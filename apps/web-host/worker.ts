import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { delimiter, join } from "node:path";
import type { HostEvent, WorkerMessage } from "./types.js";

interface PendingCall {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class AgentWorker extends EventEmitter {
  readonly workspaceRoot: string;
  readonly sessionPath: string;
  readonly repositoryRoot: string;
  #process: ChildProcessWithoutNullStreams | null = null;
  #pending = new Map<string, PendingCall>();
  #ready: Promise<WorkerMessage> | null = null;
  #readyResolve: ((message: WorkerMessage) => void) | null = null;
  #readyReject: ((error: Error) => void) | null = null;
  #hostSequence = 0;
  #events: HostEvent[] = [];
  #stderr = "";
  #subscriberCount = 0;
  #disconnectTimer: NodeJS.Timeout | null = null;

  constructor(workspaceRoot: string, sessionPath: string, repositoryRoot: string) {
    super();
    this.workspaceRoot = workspaceRoot;
    this.sessionPath = sessionPath;
    this.repositoryRoot = repositoryRoot;
  }

  async start(): Promise<WorkerMessage> {
    if (this.#ready) return this.#ready;
    this.#ready = new Promise((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
    });
    const classpath = [join(this.repositoryRoot, "src"),
      join(this.repositoryRoot, "plugins")].join(delimiter);
    this.#process = spawn("bb", [
      "-cp", classpath,
      "-m", "agent.cli",
      "--config", join(this.repositoryRoot, "agent.edn"),
      "--session", this.sessionPath,
      "--mode", "rpc",
      "--approval-mode", "ask",
    ], {
      cwd: this.workspaceRoot,
      env: { ...process.env, BB_AGENT_WEB_WORKER: "1" },
      stdio: ["pipe", "pipe", "pipe"],
    });

    const lines = createInterface({ input: this.#process.stdout });
    lines.on("line", (line) => this.handleLine(line));
    this.#process.stderr.on("data", (chunk: Buffer) => {
      this.#stderr = `${this.#stderr}${chunk.toString("utf8")}`.slice(-20_000);
    });
    this.#process.on("error", (error) => this.fail(error));
    this.#process.on("exit", (code, signal) => {
      const detail = this.#stderr.trim();
      this.fail(new Error(
        `Agent worker exited (${signal || (code ?? "unknown")})${detail ? `: ${detail}` : ""}`));
      this.emit("exit", { code, signal });
    });
    const readinessTimeout = setTimeout(() => {
      const error = new Error("Agent worker did not become ready within 15 seconds");
      this.#readyReject?.(error);
      this.#process?.kill("SIGTERM");
    }, 15_000);
    readinessTimeout.unref();
    return this.#ready.finally(() => clearTimeout(readinessTimeout));
  }

  async call(method: string, params: Record<string, unknown> = {},
    timeoutMs = 30_000): Promise<unknown> {
    await this.start();
    if (!this.#process || this.#process.killed) throw new Error("Agent worker is unavailable");
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`RPC method timed out: ${method}`));
      }, timeoutMs);
      this.#pending.set(id, { resolve, reject, timer });
      this.#process!.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  eventsAfter(sequence = 0): HostEvent[] {
    return this.#events.filter((event) => event.hostSeq > sequence);
  }

  subscribeClient(): () => void {
    this.#subscriberCount += 1;
    if (this.#disconnectTimer) {
      clearTimeout(this.#disconnectTimer);
      this.#disconnectTimer = null;
    }
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.#subscriberCount = Math.max(0, this.#subscriberCount - 1);
      if (this.#subscriberCount === 0) {
        this.#disconnectTimer = setTimeout(() => {
          this.#disconnectTimer = null;
          if (this.#subscriberCount === 0) void this.denyPendingInteractions();
        }, 1_500);
        this.#disconnectTimer.unref();
      }
    };
  }

  get stderr(): string {
    return this.#stderr;
  }

  async close(): Promise<void> {
    const process = this.#process;
    if (!process || process.killed) return;
    try {
      await this.call("shutdown", {}, 1_500);
    } catch {
      // The worker may already be exiting.
    }
    if (process.exitCode === null) {
      process.kill("SIGTERM");
      setTimeout(() => {
        if (process.exitCode === null) process.kill("SIGKILL");
      }, 1_000).unref();
    }
  }

  private async denyPendingInteractions(): Promise<void> {
    try {
      const pending = await this.call("interaction.list", {}) as Array<{ id: string }>;
      await Promise.allSettled(pending.map((interaction) =>
        this.call("interaction.resolve", { id: interaction.id, decision: "deny" })));
    } catch {
      // A stopped worker has no pending approvals to protect.
    }
  }

  private handleLine(line: string): void {
    let message: WorkerMessage;
    try {
      message = JSON.parse(line) as WorkerMessage;
    } catch {
      this.#stderr = `${this.#stderr}\nInvalid worker JSON: ${line}`.slice(-20_000);
      return;
    }
    if (message.type === "ready") {
      this.#readyResolve?.(message);
      this.#readyResolve = null;
      this.#readyReject = null;
      return;
    }
    if (message.type === "response" && message.id) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(message.id);
      if (message.ok) pending.resolve(message.result);
      else pending.reject(Object.assign(
        new Error(message.error?.message || "Worker RPC failed"),
        { data: message.error?.data }));
      return;
    }
    if (message.type === "event" || message.type === "run-result") {
      const event = { ...message, hostSeq: ++this.#hostSequence } as HostEvent;
      this.#events.push(event);
      if (this.#events.length > 2_000) this.#events.splice(0, this.#events.length - 2_000);
      this.emit("event", event);
    }
  }

  private fail(error: Error): void {
    this.#readyReject?.(error);
    this.#readyReject = null;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
  }
}
