import { randomUUID } from "node:crypto";
import type { EventEmitter } from "node:events";
import { createInterface, type Interface as ReadLineInterface } from "node:readline";

export type JsonObject = Record<string, unknown>;

export interface RequestMessage<Params extends JsonObject = JsonObject> {
  type: "request";
  id: string;
  method: string;
  params: Params;
}

export interface ReadyMessage extends JsonObject {
  type: "ready";
  version?: number;
  session_id?: string;
  methods?: string[];
  capabilities?: JsonObject;
}

export interface RpcErrorPayload extends JsonObject {
  message: string;
  code?: string | number;
  data?: unknown;
}

export type ResponseMessage =
  | (JsonObject & {
    type: "response";
    id: string;
    ok: true;
    result?: unknown;
  })
  | (JsonObject & {
    type: "response";
    id: string;
    ok: false;
    error?: RpcErrorPayload;
  });

export interface PluginEvent extends JsonObject {
  type: "event";
  event?: string;
  data?: JsonObject;
  version?: number;
  session_id?: string;
  run_id?: string;
}

export type IncomingMessage = ReadyMessage | ResponseMessage | PluginEvent;
export type EventListener = (event: PluginEvent) => void;
export type ErrorListener = (error: Error) => void;

export interface PluginTransportOptions {
  /** JSONL emitted by the Clojure host. Defaults to process.stdin. */
  input?: NodeJS.ReadableStream;
  /** JSONL requests sent to the Clojure host. Defaults to process.stdout. */
  output?: NodeJS.WritableStream;
  /** Optional spawned-host lifecycle. EOF alone is sufficient for plugin mode. */
  child?: EventEmitter;
  defaultTimeoutMs?: number;
  readyTimeoutMs?: number;
  idFactory?: () => string;
}

interface PendingCall {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class PluginTransportError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PluginTransportError";
  }
}

export class PluginTransportClosedError extends PluginTransportError {
  constructor(message = "Plugin transport is closed") {
    super(message);
    this.name = "PluginTransportClosedError";
  }
}

export class PluginTransportTimeoutError extends PluginTransportError {
  readonly method?: string;

  constructor(message: string, method?: string) {
    super(message);
    this.name = "PluginTransportTimeoutError";
    this.method = method;
  }
}

export class PluginTransportProtocolError extends PluginTransportError {
  readonly line?: string;

  constructor(message: string, line?: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PluginTransportProtocolError";
    this.line = line;
  }
}

export class PluginRpcError extends PluginTransportError {
  readonly code?: string | number;
  readonly data?: unknown;

  constructor(payload?: RpcErrorPayload) {
    super(payload?.message || "Plugin RPC failed");
    this.name = "PluginRpcError";
    this.code = payload?.code;
    this.data = payload?.data;
  }
}

/**
 * Bidirectional JSONL transport for a TUI plugin.
 *
 * This class never writes diagnostics or UI output to `output`: its only writes
 * are `request` envelopes. Consumers may render errors received via `onError`
 * to stderr or through Ink.
 */
export class PluginTransport {
  readonly input: NodeJS.ReadableStream;
  readonly output: NodeJS.WritableStream;

  #child?: EventEmitter;
  #defaultTimeoutMs: number;
  #readyTimeoutMs: number;
  #idFactory: () => string;
  #lines: ReadLineInterface | null = null;
  #started = false;
  #closed = false;
  #failure: Error | null = null;
  #pending = new Map<string, PendingCall>();
  #eventListeners = new Set<EventListener>();
  #errorListeners = new Set<ErrorListener>();
  #readiness: Promise<ReadyMessage> | null = null;
  #readyMessage: ReadyMessage | null = null;
  #readyResolve: ((message: ReadyMessage) => void) | null = null;
  #readyReject: ((error: Error) => void) | null = null;
  #readyTimer: NodeJS.Timeout | null = null;

  constructor(options: PluginTransportOptions = {}) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stdout;
    this.#child = options.child;
    this.#defaultTimeoutMs = positiveTimeout(
      options.defaultTimeoutMs,
      30_000,
      "defaultTimeoutMs",
    );
    this.#readyTimeoutMs = positiveTimeout(
      options.readyTimeoutMs,
      15_000,
      "readyTimeoutMs",
    );
    this.#idFactory = options.idFactory ?? randomUUID;
  }

  get started(): boolean {
    return this.#started;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get readyMessage(): ReadyMessage | null {
    return this.#readyMessage;
  }

  /** Begin consuming host JSONL. Safe to call more than once. */
  start(): this {
    if (this.#closed) throw this.#failure ?? new PluginTransportClosedError();
    if (this.#started) return this;
    this.#started = true;

    this.#readiness = new Promise<ReadyMessage>((resolve, reject) => {
      this.#readyResolve = resolve;
      this.#readyReject = reject;
    });
    // A caller can intentionally use events without awaiting ready(). Keep a
    // later stream failure from becoming an unhandled rejection in that case.
    void this.#readiness.catch(() => undefined);

    this.#lines = createInterface({ input: this.input, crlfDelay: Infinity });
    this.#lines.on("line", this.#handleLine);
    this.input.once("end", this.#handleInputEnd);
    this.input.once("close", this.#handleInputClose);
    this.input.once("error", this.#handleInputError);
    this.output.once("error", this.#handleOutputError);
    this.#child?.once("error", this.#handleChildError);
    this.#child?.once("exit", this.#handleChildExit);

    this.#readyTimer = setTimeout(() => {
      this.#fail(new PluginTransportTimeoutError(
        `Plugin host did not become ready within ${this.#readyTimeoutMs}ms`,
      ));
    }, this.#readyTimeoutMs);
    return this;
  }

  /** Resolve with the host's ready envelope, including methods/capabilities. */
  ready(): Promise<ReadyMessage> {
    try {
      this.start();
    } catch (error) {
      return Promise.reject(asError(error));
    }
    return this.#readiness!;
  }

  async call<Result = unknown, Params extends JsonObject = JsonObject>(
    method: string,
    params: Params = {} as Params,
    timeoutMs = this.#defaultTimeoutMs,
  ): Promise<Result> {
    if (!method) throw new TypeError("RPC method must not be empty");
    const effectiveTimeout = positiveTimeout(timeoutMs, this.#defaultTimeoutMs, "timeoutMs");
    await this.ready();
    if (this.#failure) throw this.#failure;

    const id = this.#idFactory();
    if (!id) throw new PluginTransportError("idFactory returned an empty request id");
    if (this.#pending.has(id)) {
      throw new PluginTransportError(`idFactory returned a duplicate request id: ${id}`);
    }

    return new Promise<Result>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new PluginTransportTimeoutError(
          `Plugin RPC method timed out after ${effectiveTimeout}ms: ${method}`,
          method,
        ));
      }, effectiveTimeout);
      this.#pending.set(id, {
        method,
        resolve: (value) => resolve(value as Result),
        reject,
        timer,
      });

      const request: RequestMessage<Params> = { type: "request", id, method, params };
      try {
        this.output.write(`${JSON.stringify(request)}\n`, "utf8", (error) => {
          if (error) this.#fail(new PluginTransportError("Could not write plugin request", {
            cause: error,
          }));
        });
      } catch (error) {
        this.#fail(new PluginTransportError("Could not write plugin request", {
          cause: error,
        }));
      }
    });
  }

  onEvent(listener: EventListener): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  /** Alias that lets UI state stores treat the transport as an event source. */
  subscribe(listener: EventListener): () => void {
    return this.onEvent(listener);
  }

  onError(listener: ErrorListener): () => void {
    this.#errorListeners.add(listener);
    if (this.#failure) listener(this.#failure);
    return () => this.#errorListeners.delete(listener);
  }

  /** Stop reading and reject readiness plus every pending RPC. */
  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#fail(new PluginTransportClosedError());
  }

  #handleLine = (line: string): void => {
    if (!line.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch (error) {
      this.#fail(new PluginTransportProtocolError("Invalid JSON from plugin host", line, {
        cause: error,
      }));
      return;
    }
    if (!isJsonObject(value) ||
        (value.type !== "ready" && value.type !== "response" && value.type !== "event")) {
      this.#fail(new PluginTransportProtocolError(
        "Unexpected message from plugin host; expected ready, response, or event",
        line,
      ));
      return;
    }

    if (value.type === "ready") {
      const message = value as ReadyMessage;
      if (this.#readyMessage) return;
      this.#readyMessage = message;
      this.#clearReadyTimer();
      this.#readyResolve?.(message);
      this.#readyResolve = null;
      this.#readyReject = null;
      return;
    }

    if (value.type === "response") {
      if (typeof value.id !== "string" || typeof value.ok !== "boolean") {
        this.#fail(new PluginTransportProtocolError(
          "Malformed response from plugin host",
          line,
        ));
        return;
      }
      const pending = this.#pending.get(value.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.#pending.delete(value.id);
      if (value.ok) {
        pending.resolve(value.result);
      } else {
        pending.reject(new PluginRpcError(
          isRpcErrorPayload(value.error) ? value.error : undefined,
        ));
      }
      return;
    }

    const event = value as PluginEvent;
    for (const listener of this.#eventListeners) listener(event);
  };

  #handleInputEnd = (): void => {
    this.#fail(new PluginTransportError("Plugin host input reached EOF"));
  };

  #handleInputClose = (): void => {
    if (!this.#failure && !this.#closed) {
      this.#fail(new PluginTransportError("Plugin host input closed"));
    }
  };

  #handleInputError = (error: Error): void => {
    this.#fail(new PluginTransportError("Plugin host input failed", { cause: error }));
  };

  #handleOutputError = (error: Error): void => {
    this.#fail(new PluginTransportError("Plugin host output failed", { cause: error }));
  };

  #handleChildError = (error: Error): void => {
    this.#fail(new PluginTransportError("Plugin host process failed", { cause: error }));
  };

  #handleChildExit = (code: number | null, signal: NodeJS.Signals | null): void => {
    const status = signal ? `signal ${signal}` : `code ${code ?? "unknown"}`;
    this.#fail(new PluginTransportError(`Plugin host process exited with ${status}`));
  };

  #fail(error: Error): void {
    if (this.#failure) return;
    this.#failure = error;
    this.#clearReadyTimer();
    this.#readyReject?.(error);
    this.#readyResolve = null;
    this.#readyReject = null;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.#pending.clear();
    this.#detach();
    for (const listener of this.#errorListeners) listener(error);
  }

  #clearReadyTimer(): void {
    if (!this.#readyTimer) return;
    clearTimeout(this.#readyTimer);
    this.#readyTimer = null;
  }

  #detach(): void {
    this.#lines?.off("line", this.#handleLine);
    this.#lines?.close();
    this.#lines = null;
    this.input.off("end", this.#handleInputEnd);
    this.input.off("close", this.#handleInputClose);
    this.input.off("error", this.#handleInputError);
    this.output.off("error", this.#handleOutputError);
    this.#child?.off("error", this.#handleChildError);
    this.#child?.off("exit", this.#handleChildExit);
  }
}

function positiveTimeout(value: number | undefined, fallback: number, name: string): number {
  const timeout = value ?? fallback;
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return timeout;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRpcErrorPayload(value: unknown): value is RpcErrorPayload {
  return isJsonObject(value) && typeof value.message === "string";
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
