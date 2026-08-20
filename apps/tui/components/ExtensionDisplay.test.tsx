import assert from "node:assert/strict";
import test from "node:test";
import { render } from "ink-testing-library";
import type { UiExtensions, UiNotification } from "../types.js";
import { ExtensionDisplay } from "./ExtensionDisplay.js";

function extensions(): UiExtensions {
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  return {
    statuses: {
      lsp: { value: "ready" },
      build: { value: { files: 4 } },
      empty: { value: " " },
    },
    widgets: {
      todo: { value: ["one", "", "two"], options: { placement: "above-editor" } },
      summary: { value: { remaining: 2 }, options: { placement: "above-editor" } },
      hint: { value: "Ctrl+G: goals", options: { placement: "below-editor" } },
      blank: { value: [], options: { placement: "below-editor" } },
      circular: { value: circular, options: { placement: "below-editor" } },
    },
    shortcuts: {},
  } as unknown as UiExtensions;
}

const notifications: UiNotification[] = [
  { id: "old", text: "Old notice", level: "info", data: {} },
  { id: "success", text: "Index ready", level: "success", data: {} },
  { id: "error", text: "Build failed", level: "error", data: {} },
];

test("renders placed widgets and only the latest notifications above the editor", () => {
  const view = render(
    <ExtensionDisplay
      extensions={extensions()}
      notifications={notifications}
      placement="above-editor"
      terminalWidth={36}
    />,
  );
  const frame = view.lastFrame() ?? "";
  assert.match(frame, /Index ready/);
  assert.match(frame, /Build failed/);
  assert.doesNotMatch(frame, /Old notice/);
  assert.match(frame, /one/);
  assert.match(frame, /two/);
  assert.match(frame, /\{"remaining":2\}/);
  assert.doesNotMatch(frame, /Ctrl\+G/);
  assert.doesNotMatch(frame, /lsp/);
});

test("renders below-editor widgets and compact statuses while ignoring empty or circular values", () => {
  const view = render(
    <ExtensionDisplay
      extensions={extensions()}
      notifications={notifications}
      placement="below-editor"
      terminalWidth={80}
    />,
  );
  const frame = view.lastFrame() ?? "";
  assert.match(frame, /Ctrl\+G: goals/);
  assert.match(frame, /lsp: ready/);
  assert.match(frame, /build: \{"files":4\}/);
  assert.doesNotMatch(frame, /Build failed/);
  assert.doesNotMatch(frame, /self/);
});

test("stays inside narrow terminal widths and renders nothing for empty extensions", () => {
  const narrow = render(
    <ExtensionDisplay
      extensions={extensions()}
      notifications={notifications}
      placement="below-editor"
      terminalWidth={8}
    />,
  );
  assert.ok((narrow.lastFrame() ?? "").split("\n").every((line) => line.length <= 8));

  const empty = render(
    <ExtensionDisplay
      extensions={{ statuses: {}, widgets: {}, shortcuts: {} }}
      notifications={[]}
      placement="above-editor"
      terminalWidth={40}
    />,
  );
  assert.equal(empty.lastFrame(), "");

  const hiddenNotifications = render(
    <ExtensionDisplay
      extensions={{ statuses: {}, widgets: {}, shortcuts: {} }}
      notifications={notifications}
      placement="above-editor"
      terminalWidth={40}
      maxNotifications={0}
    />,
  );
  assert.equal(hiddenNotifications.lastFrame(), "");
});
