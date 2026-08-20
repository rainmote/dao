import assert from "node:assert/strict";
import test from "node:test";
import { render } from "ink-testing-library";
import { ApprovalDialog } from "./ApprovalDialog";
import { DialogManager } from "./DialogManager";
import { Footer } from "./Footer";
import { Header } from "./Header";
import { SelectionDialog } from "./SelectionDialog";
import { TextPromptDialog } from "./TextPromptDialog";
import { ThemeDialog } from './ThemeDialog.js';
import type { Interaction } from "../types";

const flush = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 60);
  });

test("selection dialog windows long lists and handles keyboard selection", async () => {
  let selected: string | undefined;
  let highlighted: string | undefined;
  const options = Array.from({ length: 12 }, (_, index) => ({
    value: `model-${index + 1}`,
    label: `Model ${index + 1}`,
  }));
  const view = render(
    <SelectionDialog
      kind="model"
      options={options}
      terminalHeight={11}
      onSelect={(value) => {
        selected = value;
      }}
      onHighlight={(value) => {
        highlighted = value;
      }}
      onCancel={() => {}}
    />,
  );

  assert.match(view.lastFrame() ?? "", /Select model/);
  assert.match(view.lastFrame() ?? "", /▼/);
  assert.doesNotMatch(view.lastFrame() ?? "", /Model 12/);

  for (let index = 0; index < 4; index += 1) {
    view.stdin.write("\u001B[B");
    await flush();
  }
  assert.match(view.lastFrame() ?? "", /Model 5/);
  assert.doesNotMatch(view.lastFrame() ?? "", /1\. Model 1\s/);
  assert.equal(highlighted, "model-5");
  view.stdin.write("\r");
  await flush();

  assert.equal(selected, "model-5");
  view.unmount();
});

test("approval dialog supports session approval and Escape denial", async () => {
  const interaction: Interaction = {
    id: "approval-1",
    title: "Run shell command?",
    message: "npm test",
    default: "allow",
    items: [
      { label: "Allow once", value: "allow" },
      { label: "Allow this session", value: "allow-session" },
      { label: "Deny", value: "deny" },
    ],
  };
  const decisions: string[] = [];
  const view = render(
    <ApprovalDialog
      interaction={interaction}
      onResolve={(decision) => decisions.push(decision)}
    />,
  );

  assert.match(view.lastFrame() ?? "", /1\. Allow once/);
  assert.match(view.lastFrame() ?? "", /2\. Allow this session/);
  assert.doesNotMatch(view.lastFrame() ?? "", /! Run shell command/);
  view.stdin.write("\u001B[B");
  await flush();
  view.stdin.write("\r");
  await flush();
  assert.deepEqual(decisions, ["allow-session"]);
  view.unmount();

  const cancelView = render(
    <ApprovalDialog
      interaction={interaction}
      onResolve={(decision) => decisions.push(decision)}
    />,
  );
  cancelView.stdin.write("\u001B");
  await flush();
  assert.deepEqual(decisions, ["allow-session", "deny"]);
  cancelView.unmount();

  const compactView = render(
    <ApprovalDialog
      interaction={{
        ...interaction,
        message: Array.from({ length: 20 }, (_, index) => `line ${index}`).join(
          "\n",
        ),
      }}
      terminalHeight={10}
      onResolve={() => {}}
    />,
  );
  const compactFrame = compactView.lastFrame() ?? "";
  assert.ok(compactFrame.split("\n").length <= 10);
  assert.match(compactFrame, /Allow this session/);
  assert.match(compactFrame, /lines hidden/);
  compactView.unmount();
});

test("header and footer expose Qwen-style runtime context without duplication", () => {
  const header = render(
    <Header
      version="0.2.0"
      provider="openai-compatible"
      model="qwen-coder"
      cwd="/workspace/dao"
      terminalWidth={100}
    />,
  );
  const footer = render(
    <Footer
      cwd="/workspace/dao"
      model="qwen-coder"
      phase="tool"
      context={{ used: 24_000, limit: 120_000 }}
      queueCount={2}
    />,
  );

  assert.match(header.lastFrame() ?? "", />_ bb-agent/);
  assert.match(header.lastFrame() ?? "", /v0\.2\.0/);
  assert.match(header.lastFrame() ?? "", /___ ___/);
  assert.match(header.lastFrame() ?? "", /openai-compatible \| qwen-coder/);
  assert.match(header.lastFrame() ?? "", /Tips: Type \/ to see all available commands/);
  assert.match(footer.lastFrame() ?? "", /Alt\+Enter follow-up/);
  assert.match(footer.lastFrame() ?? "", /20\.0% used/);
  assert.match(footer.lastFrame() ?? "", /2 queued/);
  assert.doesNotMatch(footer.lastFrame() ?? "", /\/workspace\/dao/);
  assert.doesNotMatch(footer.lastFrame() ?? "", /qwen-coder/);
  header.unmount();
  footer.unmount();
});

test("header hides the block logo when the information panel would be cramped", () => {
  const header = render(
    <Header
      version="0.2.0"
      provider="local"
      model="qwen-coder"
      cwd="/a/very/long/workspace/path/that/needs/to/be/shortened"
      terminalWidth={52}
    />,
  );

  const frame = header.lastFrame() ?? "";
  assert.match(frame, />_ bb-agent/);
  assert.match(frame, /local \| qwen-coder/);
  assert.doesNotMatch(frame, /██████/);
  assert.ok(frame.split("\n").every((line) => line.length <= 52));
  header.unmount();
});

test("dialog manager renders a supplied command picker and nothing otherwise", () => {
  const hidden = render(<DialogManager />);
  assert.equal(hidden.lastFrame(), "");
  hidden.unmount();

  const visible = render(
    <DialogManager
      dialog={{
        type: "selection",
        kind: "command",
        options: [{ value: "help", label: "/help" }],
        onSelect: () => {},
        onCancel: () => {},
      }}
    />,
  );
  assert.match(visible.lastFrame() ?? "", /Commands/);
  assert.match(visible.lastFrame() ?? "", /\/help/);
  visible.unmount();

  const input = render(
    <DialogManager
      dialog={{
        type: "input",
        title: "Set provider",
        placeholder: "provider id",
        onSubmit: () => {},
        onCancel: () => {},
      }}
    />,
  );
  assert.match(input.lastFrame() ?? "", /Set provider/);
  assert.match(input.lastFrame() ?? "", /provider id/);
  input.unmount();
});

test('theme dialog previews the highlighted Qwen palette before selection', async () => {
  let highlighted: string | undefined;
  let selected: string | undefined;
  const view = render(
    <ThemeDialog
      options={[
        { value: 'Qwen Dark', label: 'Qwen Dark', description: 'Dark' },
        { value: 'Dracula', label: 'Dracula', description: 'Dark' },
      ]}
      initialValue="Qwen Dark"
      terminalWidth={100}
      terminalHeight={20}
      onHighlight={(value) => {
        highlighted = value;
      }}
      onSelect={(value) => {
        selected = value;
      }}
      onCancel={() => {}}
    />,
  );

  assert.match(view.lastFrame() ?? '', /> Select Theme/);
  assert.match(view.lastFrame() ?? '', /Preview/);
  assert.match(view.lastFrame() ?? '', /def fibonacci/);
  assert.match(view.lastFrame() ?? '', /Hello/);

  view.stdin.write('\u001b[B');
  await flush();
  assert.equal(highlighted, 'Dracula');
  view.stdin.write('\r');
  await flush();
  assert.equal(selected, 'Dracula');
  view.unmount();

  const narrow = render(
    <ThemeDialog
      options={[{ value: 'Qwen Dark', label: 'Qwen Dark' }]}
      terminalWidth={52}
      onSelect={() => {}}
      onCancel={() => {}}
    />,
  );
  assert.match(narrow.lastFrame() ?? '', /> Select Theme/);
  assert.doesNotMatch(narrow.lastFrame() ?? '', /Preview/);
  narrow.unmount();
});

test("text prompt edits whole graphemes with Backspace and Delete", async () => {
  const submissions: string[] = [];
  const backspaceView = render(
    <TextPromptDialog
      title="Name session"
      defaultValue="A👨‍👩‍👧‍👦B"
      onSubmit={(value) => submissions.push(value)}
      onCancel={() => {}}
    />,
  );
  await flush();
  backspaceView.stdin.write("\u001B[D");
  await flush();
  backspaceView.stdin.write("\u007f");
  await flush();
  backspaceView.stdin.write("🙂");
  await flush();
  backspaceView.stdin.write("\r");
  await flush();
  assert.deepEqual(submissions, ["A🙂B"]);
  backspaceView.unmount();

  const deleteView = render(
    <TextPromptDialog
      title="Name session"
      defaultValue="A🙂B"
      onSubmit={(value) => submissions.push(value)}
      onCancel={() => {}}
    />,
  );
  await flush();
  deleteView.stdin.write("\u001B[D");
  await flush();
  deleteView.stdin.write("\u001B[D");
  await flush();
  deleteView.stdin.write("\u001B[3~");
  await flush();
  deleteView.stdin.write("\r");
  await flush();
  assert.deepEqual(submissions, ["A🙂B", "AB"]);
  deleteView.unmount();
});

test("text prompt enforces required input and leaves JSON parsing to its caller", async () => {
  let submitted: string | undefined;
  let cancelled = false;
  const view = render(
    <TextPromptDialog
      title="Tool arguments"
      customJson
      required
      terminalHeight={8}
      onSubmit={(value) => {
        submitted = value;
      }}
      onCancel={() => {
        cancelled = true;
      }}
    />,
  );

  assert.match(view.lastFrame() ?? "", /JSON input/);
  assert.match(view.lastFrame() ?? "", /> /);
  assert.doesNotMatch(view.lastFrame() ?? "", /[┌┐└┘]/);
  assert.ok((view.lastFrame() ?? "").split("\n").length <= 8);
  view.stdin.write("\r");
  await flush();
  assert.equal(submitted, undefined);
  assert.match(view.lastFrame() ?? "", /Value is required/);

  view.stdin.write('{"valid":false}');
  await flush();
  view.stdin.write("\r");
  await flush();
  assert.equal(submitted, '{"valid":false}');
  view.unmount();

  const cancelView = render(
    <TextPromptDialog
      title="Cancel me"
      onSubmit={() => {}}
      onCancel={() => {
        cancelled = true;
      }}
    />,
  );
  cancelled = false;
  cancelView.stdin.write("\u001B");
  await flush();
  assert.equal(cancelled, true);
  cancelView.unmount();
});
