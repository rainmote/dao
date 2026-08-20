import assert from "node:assert/strict";
import test from "node:test";
import { applyEnvelope, fromSnapshot } from "./projection";
import type { Envelope, Snapshot, UiProjection } from "./types";

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    session_id: "session-1",
    path: "/tmp/session.jsonl",
    cursor: 0,
    events: [],
    state: { phase: "idle", "run-id": null },
    models: {
      current: { id: "qwen", provider: "openai", model: "qwen3" },
      providers: [{ id: "qwen", provider: "openai", model: "qwen3" }],
    },
    interactions: [],
    ...overrides,
  };
}

function event(
  hostSeq: number,
  eventId: string,
  seq: number,
  name: string,
  data: Record<string, unknown>,
): Envelope {
  return {
    type: "event",
    hostSeq,
    durable: true,
    event_id: eventId,
    seq,
    event: name,
    at: `2026-08-19T00:00:0${seq}.000Z`,
    data,
  };
}

function apply(projection: UiProjection, ...envelopes: Envelope[]): UiProjection {
  return envelopes.reduce(applyEnvelope, projection);
}

test("fromSnapshot sorts and deduplicates messages while grouping tool calls", () => {
  const projection = fromSnapshot(snapshot({
    cursor: 5,
    events: [
      {
        id: "message-2",
        seq: 2,
        at: "2026-08-19T00:00:02.000Z",
        type: "message",
        data: { message: { role: "assistant", content: "I will check." } },
      },
      {
        id: "message-1",
        seq: 1,
        at: "2026-08-19T00:00:01.000Z",
        type: "message",
        data: { message: { role: "user", content: "Check it" } },
      },
      {
        id: "call-1-event",
        seq: 3,
        at: "2026-08-19T00:00:03.000Z",
        type: "tool/call",
        data: { "call-id": "call-1", name: "read", arguments: { path: "a.txt" } },
      },
      {
        id: "call-2-event",
        seq: 4,
        at: "2026-08-19T00:00:04.000Z",
        type: "tool/call",
        data: { "call-id": "call-2", name: "grep", arguments: { query: "todo" } },
      },
      {
        id: "result-1-event",
        seq: 5,
        at: "2026-08-19T00:00:05.000Z",
        type: "tool/result",
        data: {
          "call-id": "call-1",
          name: "read",
          ok: true,
          content: "contents",
          "duration-ms": 12,
        },
      },
      {
        id: "call-2-event",
        seq: 4,
        at: "2026-08-19T00:00:04.000Z",
        type: "tool/call",
        data: { "call-id": "call-2", name: "grep", arguments: { query: "todo" } },
      },
    ],
  }));

  assert.equal(projection.history.length, 3);
  assert.deepEqual(projection.history.map((item) => item.type), [
    "user",
    "assistant",
    "tool-group",
  ]);
  const group = projection.history[2];
  assert.equal(group.type, "tool-group");
  if (group.type !== "tool-group") return;
  assert.equal(group.tools.length, 2);
  assert.deepEqual(group.tools[0], {
    callId: "call-1",
    name: "read",
    arguments: { path: "a.txt" },
    status: "success",
    updates: [],
    result: { ok: true, content: "contents", durationMs: 12 },
  });
  assert.equal(group.tools[1].status, "pending");
  assert.equal(projection.seenEventIds.size, 5);
  assert.equal(projection.models?.current?.model, "qwen3");
});

test("projects text and reasoning streams, then replaces them with a durable assistant", () => {
  let projection = fromSnapshot(snapshot({
    state: {
      phase: "model",
      "run-id": "run-1",
      "partial-assistant": "Hel",
      "partial-reasoning": "Think",
    },
  }));
  assert.deepEqual(projection.history, [{
    id: "stream:run-1",
    type: "assistant",
    text: "Hel",
    reasoning: "Think",
    streaming: true,
  }]);

  projection = apply(
    projection,
    {
      type: "event",
      hostSeq: 1,
      event: "llm/stream",
      data: { type: "text/delta", delta: "lo" },
    },
    {
      type: "event",
      hostSeq: 2,
      event: "llm/stream",
      data: { type: "reasoning/delta", delta: "ing" },
    },
    {
      type: "event",
      hostSeq: 3,
      event: "agent/state",
      data: {
        phase: "model",
        "run-id": "run-1",
        "partial-assistant": "Hello",
        "partial-reasoning": "Thinking",
      },
    },
  );
  assert.equal(projection.history.length, 1);
  assert.deepEqual(projection.history[0], {
    id: "stream:run-1",
    type: "assistant",
    text: "Hello",
    reasoning: "Thinking",
    streaming: true,
  });

  const beforeDuplicate = projection;
  projection = applyEnvelope(projection, {
    type: "event",
    hostSeq: 3,
    event: "agent/state",
    data: { phase: "model", "partial-assistant": "duplicated" },
  });
  assert.equal(projection, beforeDuplicate);

  projection = applyEnvelope(
    projection,
    event(4, "assistant-final", 1, "message", {
      message: { role: "assistant", content: "Hello" },
    }),
  );
  assert.deepEqual(projection.history, [{
    id: "assistant-final",
    type: "assistant",
    text: "Hello",
    reasoning: "Thinking",
    timestamp: "2026-08-19T00:00:01.000Z",
  }]);
  assert.equal(projection.state.partialAssistant, "");
  assert.equal(projection.state.partialReasoning, "");

  projection = applyEnvelope(
    projection,
    event(5, "assistant-final", 1, "message", {
      message: { role: "assistant", content: "Hello again" },
    }),
  );
  assert.equal(projection.history.length, 1);
  assert.equal((projection.history[0] as { text: string }).text, "Hello");
});

test("merges live tool updates, ephemeral completion, and durable result", () => {
  let projection = fromSnapshot(snapshot());
  projection = apply(
    projection,
    event(1, "call-event", 1, "tool/call", {
      "call-id": "tool-1",
      name: "bash",
      arguments: { command: "false" },
    }),
    {
      type: "event",
      hostSeq: 2,
      event: "tool.execution/update",
      data: {
        "call-id": "tool-1",
        "execution-id": "execution-1",
        name: "bash",
        update: { stdout: "working" },
      },
    },
  );

  const afterUpdate = projection;
  projection = applyEnvelope(projection, {
    type: "event",
    hostSeq: 2,
    event: "tool.execution/update",
    data: { "call-id": "tool-1", update: "duplicate" },
  });
  assert.equal(projection, afterUpdate);

  projection = apply(
    projection,
    {
      type: "event",
      hostSeq: 3,
      event: "tool.execution/end",
      data: {
        "call-id": "tool-1",
        name: "bash",
        ok: true,
        content: "exit 1",
        details: { "exit-code": 1 },
      },
    },
    event(4, "result-event", 2, "tool/result", {
      "call-id": "tool-1",
      name: "bash",
      ok: true,
      content: "exit 1",
      details: { "exit-code": 1 },
      "duration-ms": 8,
    }),
  );

  assert.equal(projection.history.length, 1);
  const group = projection.history[0];
  assert.equal(group.type, "tool-group");
  if (group.type !== "tool-group") return;
  assert.equal(group.tools.length, 1);
  assert.equal(group.tools[0].status, "error");
  assert.equal(group.tools[0].executionId, "execution-1");
  assert.deepEqual(group.tools[0].updates, [{ stdout: "working" }]);
  assert.equal(group.tools[0].result?.durationMs, 8);
});

test("projects agent state, queue, interactions, and run errors without duplicates", () => {
  let projection = fromSnapshot(snapshot({
    interactions: [{
      id: "approval-1",
      title: "Allow write?",
      message: "write a.txt",
      "created-at": "2026-08-19T00:00:00Z",
      items: [{ label: "Allow", value: "allow" }],
      default: "allow",
    }],
  }));
  assert.equal(projection.interactions[0].createdAt, "2026-08-19T00:00:00Z");

  projection = apply(
    projection,
    {
      type: "event",
      hostSeq: 1,
      event: "agent/state",
      data: { phase: "retry", attempt: 2, "last-error": "temporary" },
    },
    {
      type: "event",
      hostSeq: 2,
      event: "queue/changed",
      data: {
        queue: [
          { id: "queued-1", kind: "steer", message: "focus" },
          { id: "queued-1", kind: "steer", message: "focus" },
          { id: "queued-2", kind: "follow-up", message: "then test" },
        ],
      },
    },
    {
      type: "event",
      hostSeq: 3,
      event: "interaction/request",
      data: {
        id: "approval-2",
        title: "Run command?",
        message: "npm test",
        items: [{ label: "Deny", value: "deny" }],
        default: "deny",
      },
    },
    {
      type: "event",
      hostSeq: 4,
      event: "interaction/request",
      data: {
        id: "approval-2",
        title: "Run command?",
        message: "npm test",
        items: [],
        default: "deny",
      },
    },
    {
      type: "event",
      hostSeq: 5,
      event: "interaction/resolved",
      data: { id: "approval-1" },
    },
    {
      type: "event",
      hostSeq: 6,
      event: "remote/run-result",
      data: {
        request_id: "request-1",
        ok: false,
        error: { message: "provider unavailable" },
      },
    },
  );

  assert.deepEqual(projection.state, {
    phase: "retry",
    runId: null,
    partialAssistant: "",
    partialReasoning: "",
    attempt: 2,
    lastError: "temporary",
  });
  assert.deepEqual(projection.queue.map((item) => item.id), ["queued-1", "queued-2"]);
  assert.deepEqual(projection.interactions.map((item) => item.id), ["approval-2"]);
  assert.equal(projection.lastRunError, "provider unavailable");
  assert.equal(projection.history.at(-1)?.type, "error");

  projection = applyEnvelope(projection, {
    type: "run-result",
    hostSeq: 7,
    ok: false,
    error: { message: "worker failed" },
  });
  projection = applyEnvelope(projection, {
    type: "run-result",
    hostSeq: 7,
    ok: false,
    error: { message: "duplicate" },
  });
  assert.equal(projection.history.filter((item) => item.type === "error").length, 2);
  assert.equal(projection.lastRunError, "worker failed");

  projection = applyEnvelope(projection, { type: "run-result", hostSeq: 8, ok: true });
  assert.equal(projection.lastRunError, null);
});

test("preserves prompt metadata and classifies approval and custom interactions", () => {
  let projection = fromSnapshot(snapshot({
    interactions: [{
      id: "approval",
      kind: "select",
      title: "Allow?",
      message: "write file",
      items: [
        { label: "Allow", value: "allow" },
        { label: "Deny", value: "deny" },
      ],
      default: "deny",
      schema: { type: "string" },
      "required?": true,
    }],
  }));
  assert.equal(projection.interactions[0].kind, "approval");
  assert.deepEqual(projection.interactions[0].prompt?.schema, { type: "string" });
  assert.equal(projection.interactions[0].prompt?.["required?"], true);

  projection = applyEnvelope(projection, {
    type: "event",
    hostSeq: 1,
    event: "interaction/request",
    data: {
      id: "custom",
      kind: "custom",
      title: "Choose output",
      message: "Select a format",
      options: ["text", "json"],
      schema: { enum: ["text", "json"] },
      "required?": true,
    },
  });
  const custom = projection.interactions.find((item) => item.id === "custom");
  assert.equal(custom?.kind, "custom");
  assert.deepEqual(custom?.prompt?.options, ["text", "json"]);
  assert.deepEqual(custom?.prompt?.schema, { enum: ["text", "json"] });
  assert.equal(custom?.prompt?.["required?"], true);
});

test("projects model selection, UI extensions, notifications, and subagent lifecycle", () => {
  let projection = fromSnapshot(snapshot());
  projection = apply(
    projection,
    {
      type: "event",
      hostSeq: 1,
      event: "llm/model-selected",
      data: { provider: "subscription", model: "qwen-max" },
    },
    {
      type: "event",
      hostSeq: 2,
      event: "ui/extensions",
      data: {
        kind: "snapshot",
        snapshot: {
          theme: "Qwen Light",
          registries: {
            statuses: { lsp: { value: "ready" } },
            widgets: { todo: { value: ["one"], options: { placement: "above-editor" } } },
            shortcuts: { "ctrl+g": { description: "Open goal" } },
          },
        },
      },
    },
    {
      type: "event",
      hostSeq: 3,
      at: "2026-08-19T01:00:00.000Z",
      event: "ui/extensions",
      data: {
        kind: "notification",
        notification: { id: "notice-1", text: "Index ready", level: "success" },
      },
    },
    {
      type: "event",
      hostSeq: 4,
      event: "ui/extensions",
      data: {
        kind: "notification",
        notification: { id: "notice-1", text: "duplicate", level: "error" },
      },
    },
    {
      type: "event",
      hostSeq: 5,
      event: "subagent/start",
      data: { id: "agent-1", label: "Review tests", status: "running" },
    },
    {
      type: "event",
      hostSeq: 6,
      event: "subagent/end",
      data: { id: "agent-1", "stop-reason": "completed" },
    },
    {
      type: "event",
      hostSeq: 7,
      event: "subagent/end",
      data: { id: "agent-1", "stop-reason": "completed" },
    },
  );

  assert.deepEqual(projection.models?.current, {
    id: "subscription",
    provider: "subscription",
    model: "qwen-max",
  });
  assert.deepEqual(projection.uiExtensions, {
    theme: "Qwen Light",
    statuses: { lsp: { value: "ready" } },
    widgets: { todo: { value: ["one"], options: { placement: "above-editor" } } },
    shortcuts: { "ctrl+g": { description: "Open goal" } },
  });
  assert.deepEqual(projection.notifications, [{
    id: "notice-1",
    text: "Index ready",
    level: "success",
    timestamp: "2026-08-19T01:00:00.000Z",
    data: { id: "notice-1", text: "Index ready", level: "success" },
  }]);
  assert.deepEqual(
    projection.history.filter((item) => item.type === "info").map((item) => item.text),
    ["Subagent Review tests started", "Subagent agent-1 completed"],
  );
});

test("deduplicates UI and remote reports of the same run error", () => {
  let projection = fromSnapshot(snapshot());
  projection = apply(
    projection,
    {
      type: "event",
      hostSeq: 1,
      event: "ui/run-error",
      data: { message: "provider rejected request" },
    },
    {
      type: "event",
      hostSeq: 2,
      event: "remote/run-result",
      data: {
        request_id: "request-1",
        ok: false,
        error: { message: "provider rejected request" },
      },
    },
  );
  assert.equal(projection.lastRunError, "provider rejected request");
  assert.equal(projection.history.filter((item) => item.type === "error").length, 1);
});
