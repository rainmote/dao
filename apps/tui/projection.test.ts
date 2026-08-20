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

test("projects a real tool start without allowing a late start to downgrade completion", () => {
  let projection = fromSnapshot(snapshot({
    cursor: 1,
    events: [{
      id: "call-event",
      seq: 1,
      at: "2026-08-19T00:00:01.000Z",
      type: "tool/call",
      data: {
        "call-id": "tool-1",
        name: "bash",
        arguments: { command: "sleep 1" },
      },
    }],
  }));

  projection = applyEnvelope(projection, {
    type: "event",
    hostSeq: 1,
    event: "tool.execution/start",
    data: {
      "call-id": "tool-1",
      name: "bash",
      "execution-id": "execution-1",
      "started-at": 1_777_000_000_123,
    },
  });
  let group = projection.history[0];
  assert.equal(group.type, "tool-group");
  if (group.type !== "tool-group") return;
  assert.equal(group.tools[0].status, "running");
  assert.equal(group.tools[0].executionId, "execution-1");
  assert.equal(group.tools[0].executionStartTime, 1_777_000_000_123);

  for (let index = 0; index < 40; index += 1) {
    projection = applyEnvelope(projection, {
      type: "event",
      hostSeq: 2 + index,
      event: "tool.execution/update",
      data: { "call-id": "tool-1", update: { index } },
    });
  }
  projection = applyEnvelope(projection, {
    type: "event",
    hostSeq: 42,
    event: "tool.execution/end",
    data: { "call-id": "tool-1", name: "bash", ok: true, content: "done" },
  });
  projection = applyEnvelope(projection, {
    type: "event",
    hostSeq: 43,
    event: "tool.execution/start",
    data: {
      "call-id": "tool-1",
      name: "bash",
      "execution-id": "late-execution",
      "started-at": 1_777_000_000_999,
    },
  });
  projection = applyEnvelope(projection, {
    type: "event",
    hostSeq: 44,
    event: "tool.execution/update",
    data: { "call-id": "tool-1", update: { index: 40 } },
  });

  group = projection.history[0];
  assert.equal(group.type, "tool-group");
  if (group.type !== "tool-group") return;
  assert.equal(group.tools[0].status, "success");
  assert.equal(group.tools[0].executionId, "execution-1");
  assert.equal(group.tools[0].executionStartTime, 1_777_000_000_123);
  assert.equal(group.tools[0].result?.content, "done");
  assert.equal(group.tools[0].updates.length, 32);
  assert.deepEqual(group.tools[0].updates[0], { index: 8 });
  assert.deepEqual(group.tools[0].updates.at(-1), { index: 39 });
});

test("projects confirming and canceled as monotonic tool lifecycle states", () => {
  let projection = fromSnapshot(snapshot({
    cursor: 1,
    events: [{
      id: "call-event",
      seq: 1,
      at: "2026-08-19T00:00:01.000Z",
      type: "tool/call",
      data: { "call-id": "tool-1", name: "write", arguments: { path: "a.txt" } },
    }],
  }));

  projection = applyEnvelope(projection, {
    type: "event",
    hostSeq: 1,
    event: "tool.execution/confirming",
    data: {
      "call-id": "tool-1",
      name: "write",
      "execution-id": "execution-1",
    },
  });
  let group = projection.history[0];
  assert.equal(group.type, "tool-group");
  if (group.type !== "tool-group") return;
  assert.equal(group.tools[0].status, "confirming");

  projection = applyEnvelope(projection, {
    type: "event",
    hostSeq: 2,
    event: "tool.execution/end",
    data: {
      "call-id": "tool-1",
      name: "write",
      "execution-id": "execution-1",
      status: "canceled",
      cancelled: true,
      ok: false,
      error: "Agent run was cancelled",
    },
  });
  projection = applyEnvelope(projection, {
    type: "event",
    hostSeq: 3,
    event: "tool.execution/start",
    data: {
      "call-id": "tool-1",
      "execution-id": "late-execution",
      "started-at": 1_777_000_000_999,
    },
  });
  projection = applyEnvelope(projection, {
    type: "event",
    hostSeq: 4,
    event: "tool.execution/update",
    data: { "call-id": "tool-1", update: "late update" },
  });
  projection = applyEnvelope(projection, {
    type: "event",
    hostSeq: 5,
    event: "tool.execution/end",
    data: { "call-id": "tool-1", status: "success", ok: true, content: "late success" },
  });
  projection = applyEnvelope(projection, {
    type: "event",
    durable: true,
    hostSeq: 6,
    event_id: "late-result",
    seq: 2,
    event: "tool/result",
    data: { "call-id": "tool-1", status: "success", ok: true, content: "late durable" },
  });

  group = projection.history[0];
  assert.equal(group.type, "tool-group");
  if (group.type !== "tool-group") return;
  assert.equal(group.tools[0].status, "canceled");
  assert.equal(group.tools[0].executionId, "execution-1");
  assert.equal(group.tools[0].executionStartTime, undefined);
  assert.deepEqual(group.tools[0].updates, []);
  assert.equal(group.tools[0].result?.cancelled, true);
  assert.equal(group.tools[0].result?.error, "Agent run was cancelled");
});

test("agent abort terminalizes open tool calls from older event streams", () => {
  const projection = fromSnapshot(snapshot({
    cursor: 4,
    events: [
      {
        id: "step-start",
        seq: 1,
        at: "2026-08-19T00:00:01.000Z",
        type: "step/start",
        data: { step: 1 },
      },
      {
        id: "call-1",
        seq: 2,
        at: "2026-08-19T00:00:02.000Z",
        type: "tool/call",
        data: { "call-id": "pending", name: "read", arguments: {} },
      },
      {
        id: "call-2",
        seq: 3,
        at: "2026-08-19T00:00:03.000Z",
        type: "tool/call",
        data: { "call-id": "running", name: "bash", arguments: {} },
      },
      {
        id: "aborted",
        seq: 4,
        at: "2026-08-19T00:00:04.000Z",
        type: "agent/aborted",
        data: {},
      },
    ],
  }));

  const group = projection.history.find((item) => item.type === "tool-group");
  assert.ok(group && group.type === "tool-group");
  assert.deepEqual(group.tools.map((tool) => tool.status), ["canceled", "canceled"]);
  assert.equal(projection.currentStep, null);
  assert.equal(projection.toolBatchKey, null);
});

test("uses durable step boundaries to keep consecutive tool-loop batches separate", () => {
  const projection = fromSnapshot(snapshot({
    cursor: 10,
    events: [
      {
        id: "step-1-start",
        seq: 1,
        at: "2026-08-19T00:00:01.000Z",
        type: "step/start",
        data: { step: 1 },
      },
      {
        id: "call-1-event",
        seq: 2,
        at: "2026-08-19T00:00:02.000Z",
        type: "tool/call",
        data: { "call-id": "call-1", name: "read", arguments: { path: "a.ts" } },
      },
      {
        id: "call-2-event",
        seq: 3,
        at: "2026-08-19T00:00:03.000Z",
        type: "tool/call",
        data: { "call-id": "call-2", name: "grep", arguments: { query: "todo" } },
      },
      {
        id: "result-1-event",
        seq: 4,
        at: "2026-08-19T00:00:04.000Z",
        type: "tool/result",
        data: { "call-id": "call-1", name: "read", ok: true, content: "a" },
      },
      {
        id: "result-2-event",
        seq: 5,
        at: "2026-08-19T00:00:05.000Z",
        type: "tool/result",
        data: { "call-id": "call-2", name: "grep", ok: true, content: "b" },
      },
      {
        id: "step-1-end",
        seq: 6,
        at: "2026-08-19T00:00:06.000Z",
        type: "step/end",
        data: { step: 1, "tool-count": 2 },
      },
      {
        id: "step-2-start",
        seq: 7,
        at: "2026-08-19T00:00:07.000Z",
        type: "step/start",
        data: { step: 2 },
      },
      {
        id: "call-3-event",
        seq: 8,
        at: "2026-08-19T00:00:08.000Z",
        type: "tool/call",
        data: { "call-id": "call-3", name: "read", arguments: { path: "b.ts" } },
      },
      {
        id: "result-3-event",
        seq: 9,
        at: "2026-08-19T00:00:09.000Z",
        type: "tool/result",
        data: { "call-id": "call-3", name: "read", ok: true, content: "c" },
      },
      {
        id: "step-2-end",
        seq: 10,
        at: "2026-08-19T00:00:10.000Z",
        type: "step/end",
        data: { step: 2, "tool-count": 1 },
      },
    ],
  }));

  const groups = projection.history.filter((item) => item.type === "tool-group");
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.tools.map((tool) => tool.callId)), [
    ["call-1", "call-2"],
    ["call-3"],
  ]);
  assert.deepEqual(groups.map((group) => group.batchKey), ["step-1-start", "step-2-start"]);
  assert.equal(projection.currentStep, null);
  assert.equal(projection.toolBatchKey, null);
});

test("scopes a reused call id to its step for live lifecycle and durable result", () => {
  let projection = fromSnapshot(snapshot({
    cursor: 7,
    events: [
      {
        id: "step-1-start",
        seq: 1,
        at: "2026-08-19T00:00:01.000Z",
        type: "step/start",
        data: { step: 1 },
      },
      {
        id: "step-1-call",
        seq: 2,
        at: "2026-08-19T00:00:02.000Z",
        type: "tool/call",
        data: {
          "call-id": "reused-call",
          name: "read",
          arguments: { path: "first.ts" },
        },
      },
      {
        id: "step-1-result",
        seq: 3,
        at: "2026-08-19T00:00:03.000Z",
        type: "tool/result",
        data: {
          "call-id": "reused-call",
          name: "read",
          "execution-id": "execution-step-1",
          ok: true,
          content: "first result",
        },
      },
      {
        id: "step-1-end",
        seq: 4,
        at: "2026-08-19T00:00:04.000Z",
        type: "step/end",
        data: { step: 1, "tool-count": 1 },
      },
      {
        id: "step-2-start",
        seq: 5,
        at: "2026-08-19T00:00:05.000Z",
        type: "step/start",
        data: { step: 2 },
      },
      {
        id: "step-2-call",
        seq: 6,
        at: "2026-08-19T00:00:06.000Z",
        type: "tool/call",
        data: {
          "call-id": "reused-call",
          name: "read",
          arguments: { path: "second.ts" },
        },
      },
    ],
  }));

  let groups = projection.history.filter((item) => item.type === "tool-group");
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.batchKey), ["step-1-start", "step-2-start"]);
  assert.deepEqual(groups.map((group) => group.tools[0].arguments), [
    { path: "first.ts" },
    { path: "second.ts" },
  ]);

  projection = apply(
    projection,
    {
      type: "event",
      hostSeq: 20,
      event: "tool.execution/start",
      data: {
        "call-id": "reused-call",
        "execution-id": "execution-step-2",
        "started-at": 1_777_000_000_200,
      },
    },
    {
      type: "event",
      hostSeq: 21,
      event: "tool.execution/update",
      data: {
        "call-id": "reused-call",
        "execution-id": "execution-step-2",
        update: "second update",
      },
    },
    {
      type: "event",
      hostSeq: 22,
      event: "tool.execution/end",
      data: {
        "call-id": "reused-call",
        "execution-id": "execution-step-2",
        ok: true,
        content: "live second result",
      },
    },
    {
      type: "event",
      hostSeq: 23,
      durable: true,
      event_id: "step-2-result",
      seq: 7,
      event: "tool/result",
      data: {
        "call-id": "reused-call",
        "execution-id": "execution-step-2",
        ok: true,
        content: "durable second result",
        "duration-ms": 9,
      },
    },
  );

  groups = projection.history.filter((item) => item.type === "tool-group");
  assert.equal(groups[0].tools[0].executionId, "execution-step-1");
  assert.equal(groups[0].tools[0].result?.content, "first result");
  assert.deepEqual(groups[0].tools[0].updates, []);
  assert.equal(groups[1].tools[0].executionId, "execution-step-2");
  assert.equal(groups[1].tools[0].executionStartTime, 1_777_000_000_200);
  assert.deepEqual(groups[1].tools[0].updates, ["second update"]);
  assert.equal(groups[1].tools[0].result?.content, "durable second result");
  assert.equal(groups[1].tools[0].result?.durationMs, 9);
});

test("uses run scope when durable tool events have no step boundaries", () => {
  const projection = fromSnapshot(snapshot({
    cursor: 4,
    events: [
      {
        id: "run-1-call",
        seq: 1,
        at: "2026-08-19T00:00:01.000Z",
        type: "tool/call",
        run_id: "run-1",
        data: { "call-id": "same-call", name: "read", arguments: { path: "one" } },
      },
      {
        id: "run-1-result",
        seq: 2,
        at: "2026-08-19T00:00:02.000Z",
        type: "tool/result",
        run_id: "run-1",
        data: { "call-id": "same-call", ok: true, content: "one" },
      },
      {
        id: "run-2-call",
        seq: 3,
        at: "2026-08-19T00:00:03.000Z",
        type: "tool/call",
        run_id: "run-2",
        data: { "call-id": "same-call", name: "read", arguments: { path: "two" } },
      },
      {
        id: "run-2-result",
        seq: 4,
        at: "2026-08-19T00:00:04.000Z",
        type: "tool/result",
        run_id: "run-2",
        data: { "call-id": "same-call", ok: false, error: "two failed" },
      },
    ],
  }));

  const groups = projection.history.filter((item) => item.type === "tool-group");
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.runId), ["run-1", "run-2"]);
  assert.deepEqual(groups.map((group) => group.tools[0].arguments), [
    { path: "one" },
    { path: "two" },
  ]);
  assert.equal(groups[0].tools[0].status, "success");
  assert.equal(groups[0].tools[0].result?.content, "one");
  assert.equal(groups[1].tools[0].status, "error");
  assert.equal(groups[1].tools[0].result?.error, "two failed");
});

test("keeps unscoped legacy tool replay independent of the current agent run", () => {
  const projection = fromSnapshot(snapshot({
    cursor: 2,
    state: { phase: "tool", "run-id": "currently-running" },
    events: [
      {
        id: "legacy-call",
        seq: 1,
        at: "2026-08-19T00:00:01.000Z",
        type: "tool/call",
        data: { "call-id": "legacy", name: "read", arguments: { path: "old" } },
      },
      {
        id: "legacy-result",
        seq: 2,
        at: "2026-08-19T00:00:02.000Z",
        type: "tool/result",
        data: { "call-id": "legacy", ok: true, content: "old result" },
      },
    ],
  }));

  const group = projection.history.find((item) => item.type === "tool-group");
  assert.ok(group && group.type === "tool-group");
  assert.equal(group.runId, undefined);
  assert.equal(group.tools.length, 1);
  assert.equal(group.tools[0].status, "success");
  assert.equal(group.tools[0].result?.content, "old result");
});

test("starts a new legacy tool instance when a terminal call id is reused after a message", () => {
  const projection = fromSnapshot(snapshot({
    cursor: 6,
    events: [
      {
        id: "user-1",
        seq: 1,
        at: "2026-08-19T00:00:01.000Z",
        type: "message",
        data: { message: { role: "user", content: "Read the first file" } },
      },
      {
        id: "legacy-call-1",
        seq: 2,
        at: "2026-08-19T00:00:02.000Z",
        type: "tool/call",
        data: { "call-id": "same", name: "read", arguments: { path: "one.ts" } },
      },
      {
        id: "legacy-result-1",
        seq: 3,
        at: "2026-08-19T00:00:03.000Z",
        type: "tool/result",
        data: { "call-id": "same", ok: true, content: "first" },
      },
      {
        id: "user-2",
        seq: 4,
        at: "2026-08-19T00:00:04.000Z",
        type: "message",
        data: { message: { role: "user", content: "Now read the second file" } },
      },
      {
        id: "legacy-call-2",
        seq: 5,
        at: "2026-08-19T00:00:05.000Z",
        type: "tool/call",
        data: { "call-id": "same", name: "read", arguments: { path: "two.ts" } },
      },
      {
        id: "legacy-result-2",
        seq: 6,
        at: "2026-08-19T00:00:06.000Z",
        type: "tool/result",
        data: { "call-id": "same", ok: false, error: "second failed" },
      },
    ],
  }));

  const groups = projection.history.filter((item) => item.type === "tool-group");
  assert.equal(groups.length, 2);
  assert.deepEqual(groups.map((group) => group.tools[0].arguments), [
    { path: "one.ts" },
    { path: "two.ts" },
  ]);
  assert.equal(groups[0].tools[0].status, "success");
  assert.equal(groups[0].tools[0].result?.content, "first");
  assert.equal(groups[1].tools[0].status, "error");
  assert.equal(groups[1].tools[0].result?.error, "second failed");
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
