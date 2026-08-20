import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { PassThrough } from "node:stream";
import {
  PluginRpcError,
  PluginTransport,
  PluginTransportClosedError,
  PluginTransportTimeoutError,
  type RequestMessage,
} from "./transport.js";

function harness(options: {
  defaultTimeoutMs?: number;
  readyTimeoutMs?: number;
  child?: EventEmitter;
} = {}) {
  const input = new PassThrough();
  const output = new PassThrough();
  output.setEncoding("utf8");
  let requestNumber = 0;
  const transport = new PluginTransport({
    input,
    output,
    child: options.child,
    defaultTimeoutMs: options.defaultTimeoutMs,
    readyTimeoutMs: options.readyTimeoutMs,
    idFactory: () => `request-${++requestNumber}`,
  });
  return { input, output, transport };
}

function send(stream: PassThrough, message: unknown): void {
  stream.write(`${JSON.stringify(message)}\n`);
}

function nextRequest(stream: PassThrough): Promise<RequestMessage> {
  return new Promise((resolve) => {
    stream.once("data", (chunk: string | Buffer) => {
      resolve(JSON.parse(chunk.toString().trim()) as RequestMessage);
    });
  });
}

test("start/ready exposes host methods and capabilities without writing output", async (t) => {
  const { input, output, transport } = harness();
  t.after(() => transport.close());
  let outputBytes = 0;
  output.on("data", (chunk: string | Buffer) => { outputBytes += chunk.length; });

  assert.equal(transport.start(), transport);
  assert.equal(transport.start(), transport);
  send(input, {
    type: "ready",
    version: 1,
    session_id: "session-1",
    methods: ["prompt", "abort"],
    capabilities: { streaming: true },
  });

  const ready = await transport.ready();
  assert.deepEqual(ready.methods, ["prompt", "abort"]);
  assert.deepEqual(ready.capabilities, { streaming: true });
  assert.equal(transport.readyMessage, ready);
  assert.equal(outputBytes, 0);
});

test("call writes only a request envelope and resolves its response", async (t) => {
  const { input, output, transport } = harness();
  t.after(() => transport.close());
  transport.start();
  send(input, { type: "ready", methods: ["state"] });
  await transport.ready();

  const requestPromise = nextRequest(output);
  const resultPromise = transport.call<{ phase: string }>("state");
  const request = await requestPromise;
  assert.deepEqual(request, {
    type: "request",
    id: "request-1",
    method: "state",
    params: {},
  });
  send(input, { type: "response", id: request.id, ok: true, result: { phase: "idle" } });
  assert.deepEqual(await resultPromise, { phase: "idle" });
});

test("concurrent calls resolve correctly when responses arrive out of order", async (t) => {
  const { input, output, transport } = harness();
  t.after(() => transport.close());
  send(input, { type: "ready" });
  transport.start();
  await transport.ready();

  const requests: RequestMessage[] = [];
  output.on("data", (chunk: string | Buffer) => {
    for (const line of chunk.toString().trim().split("\n")) {
      if (line) requests.push(JSON.parse(line) as RequestMessage);
    }
  });
  const first = transport.call<string>("first");
  const second = transport.call<string>("second");
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(requests.length, 2);

  send(input, { type: "response", id: requests[1].id, ok: true, result: "second-result" });
  send(input, { type: "response", id: requests[0].id, ok: true, result: "first-result" });
  assert.deepEqual(await Promise.all([first, second]), ["first-result", "second-result"]);
});

test("event subscriptions receive events and can unsubscribe", async (t) => {
  const { input, transport } = harness();
  t.after(() => transport.close());
  transport.start();
  send(input, { type: "ready" });
  await transport.ready();

  const seen: string[] = [];
  const unsubscribe = transport.subscribe((event) => seen.push(event.event ?? ""));
  send(input, { type: "event", event: "llm/stream", data: { text: "a" } });
  await new Promise<void>((resolve) => setImmediate(resolve));
  unsubscribe();
  send(input, { type: "event", event: "llm/stream", data: { text: "b" } });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(seen, ["llm/stream"]);
});

test("RPC errors preserve code and data", async (t) => {
  const { input, output, transport } = harness();
  t.after(() => transport.close());
  transport.start();
  send(input, { type: "ready" });
  await transport.ready();

  const requestPromise = nextRequest(output);
  const result = transport.call("missing");
  const request = await requestPromise;
  send(input, {
    type: "response",
    id: request.id,
    ok: false,
    error: { message: "Unknown method", code: "method_not_found", data: { method: "missing" } },
  });

  await assert.rejects(result, (error: unknown) => {
    assert.ok(error instanceof PluginRpcError);
    assert.equal(error.message, "Unknown method");
    assert.equal(error.code, "method_not_found");
    assert.deepEqual(error.data, { method: "missing" });
    return true;
  });
});

test("pending calls time out and late responses are ignored", async (t) => {
  const { input, output, transport } = harness({ defaultTimeoutMs: 20 });
  t.after(() => transport.close());
  transport.start();
  send(input, { type: "ready" });
  await transport.ready();

  const requestPromise = nextRequest(output);
  const result = transport.call("slow");
  const request = await requestPromise;
  await assert.rejects(result, (error: unknown) => {
    assert.ok(error instanceof PluginTransportTimeoutError);
    assert.equal(error.method, "slow");
    return true;
  });
  send(input, { type: "response", id: request.id, ok: true, result: "too late" });
});

test("EOF before ready rejects readiness", async (t) => {
  const { input, transport } = harness();
  t.after(() => transport.close());
  transport.start();
  input.end();

  await assert.rejects(transport.ready(), /EOF/);
});

test("EOF rejects every pending and future call", async (t) => {
  const { input, output, transport } = harness();
  t.after(() => transport.close());
  transport.start();
  send(input, { type: "ready" });
  await transport.ready();

  const requestPromise = nextRequest(output);
  const first = transport.call("one");
  const second = transport.call("two");
  await requestPromise;
  input.end();

  await assert.rejects(first, /EOF/);
  await assert.rejects(second, /EOF/);
  await assert.rejects(transport.call("three"), /EOF/);
});

test("child exit rejects pending calls and notifies error subscribers", async (t) => {
  const child = new EventEmitter();
  const { input, output, transport } = harness({ child });
  t.after(() => transport.close());
  transport.start();
  send(input, { type: "ready" });
  await transport.ready();

  const failures: Error[] = [];
  transport.onError((error) => failures.push(error));
  const requestPromise = nextRequest(output);
  const result = transport.call("running");
  await requestPromise;
  child.emit("exit", 7, null);

  await assert.rejects(result, /exited with code 7/);
  assert.equal(failures.length, 1);
  assert.match(failures[0].message, /code 7/);
});

test("close rejects pending calls and future calls", async () => {
  const { input, output, transport } = harness();
  transport.start();
  send(input, { type: "ready" });
  await transport.ready();

  const requestPromise = nextRequest(output);
  const pending = transport.call("wait");
  await requestPromise;
  transport.close();

  await assert.rejects(pending, PluginTransportClosedError);
  await assert.rejects(transport.call("again"), PluginTransportClosedError);
  assert.equal(transport.closed, true);
});
