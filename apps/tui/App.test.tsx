import assert from 'node:assert/strict';
import test from 'node:test';
import { render } from 'ink-testing-library';

import { App, type AppTransport } from './App.js';
import type { PluginEvent } from './transport.js';
import type { Snapshot } from './types.js';
import { getActiveTheme, qwenTheme } from './theme.js';

const flush = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 70);
  });

function snapshot(
  phase = 'idle',
  interactions: Snapshot['interactions'] = [],
): Snapshot {
  return {
    session_id: 'session-1',
    path: '/tmp/session-1.jsonl',
    cursor: 1,
    events: [
      {
        id: 'message-1',
        seq: 1,
        at: '2026-08-19T00:00:00Z',
        type: 'message',
        data: { message: { role: 'user', content: 'existing message' } },
      },
    ],
    state: { phase },
    models: {
      current: { id: 'qwen', provider: 'dashscope', model: 'qwen-coder' },
      providers: [
        { id: 'qwen', provider: 'dashscope', model: 'qwen-coder' },
        { id: 'local', provider: 'ollama', model: 'local-coder' },
      ],
    },
    interactions,
  };
}

class FakeTransport implements AppTransport {
  readonly calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  snapshotValue: Snapshot;
  readonly eventListeners = new Set<(event: PluginEvent) => void>();
  readonly errorListeners = new Set<(error: Error) => void>();
  commandResult: (command: string) => unknown = () => ({ handled: true });
  failSnapshot = false;

  constructor(snapshotValue = snapshot()) {
    this.snapshotValue = snapshotValue;
  }

  async ready() {}

  async call<Result = unknown>(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<Result> {
    this.calls.push({ method, params });
    if (method === 'session.snapshot') {
      if (this.failSnapshot) throw new Error('snapshot unavailable');
      return this.snapshotValue as Result;
    }
    if (method === 'command.list') {
      return [
        { name: 'model', description: 'Select model' },
        { name: 'sessions', description: 'Resume session' },
        { name: 'theme', description: 'Select theme' },
        { name: 'quit', description: 'Exit' },
      ] as Result;
    }
    if (method === 'command.execute') {
      return this.commandResult(String(params.command || '')) as Result;
    }
    if (method === 'model.list') return this.snapshotValue.models as Result;
    if (method === 'model.select') {
      const provider = String(params.provider);
      return this.snapshotValue.models?.providers.find(
        (entry) => entry.id === provider || entry.provider === provider,
      ) as Result;
    }
    return { ok: true } as Result;
  }

  subscribe(listener: (event: PluginEvent) => void) {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  onError(listener: (error: Error) => void) {
    this.errorListeners.add(listener);
    return () => {
      this.errorListeners.delete(listener);
    };
  }

  emit(event: PluginEvent) {
    for (const listener of this.eventListeners) listener(event);
  }
}

test('loads snapshot and commands, then projects live events', async () => {
  const transport = new FakeTransport();
  const view = render(<App transport={transport} cwd="/workspace/dao" />);
  assert.match(view.lastFrame() ?? '', /Loading session and commands/);
  await flush();

  const frame = view.lastFrame() ?? '';
  assert.match(frame, /bb-agent/);
  assert.match(frame, /Tips: Type \/ to see all available commands/);
  assert.match(frame, /> existing message/);
  assert.match(frame, /existing message/);
  assert.match(frame, /qwen-coder/);
  assert.match(frame, /─{12}/);
  assert.match(frame, /Type your message or @path\/to\/file/);
  assert.deepEqual(
    transport.calls.slice(0, 2).map((entry) => entry.method).sort(),
    ['command.list', 'session.snapshot'],
  );

  transport.emit({
    type: 'event',
    event: 'llm/stream',
    data: { type: 'text/delta', delta: 'streamed answer' },
  });
  await flush();
  assert.match(view.lastFrame() ?? '', /streamed answer/);
  view.unmount();
});

test('routes idle submit, busy steer/follow-up, abort, and quit', async () => {
  const transport = new FakeTransport();
  let exits = 0;
  const view = render(
    <App transport={transport} onExit={() => { exits += 1; }} />,
  );
  await flush();

  view.stdin.write('start');
  await flush();
  view.stdin.write('\r');
  await flush();
  assert.ok(transport.calls.some(
    (entry) => entry.method === 'turn.submit' && entry.params.message === 'start',
  ));

  transport.emit({
    type: 'event',
    event: 'agent/state',
    data: { phase: 'model', run_id: 'run-1' },
  });
  await flush();
  view.stdin.write('steer now');
  await flush();
  view.stdin.write('\r');
  await flush();
  view.stdin.write('afterwards');
  await flush();
  view.stdin.write('\u001b\r');
  await flush();
  assert.ok(transport.calls.some(
    (entry) => entry.method === 'turn.steer' && entry.params.message === 'steer now',
  ));
  assert.ok(transport.calls.some(
    (entry) => entry.method === 'turn.follow-up' && entry.params.message === 'afterwards',
  ));

  view.stdin.write('\u001b');
  await flush();
  assert.ok(transport.calls.some((entry) => entry.method === 'turn.abort'));

  transport.emit({ type: 'event', event: 'agent/state', data: { phase: 'idle' } });
  await flush();
  const abortCount = transport.calls.filter((entry) => entry.method === 'turn.abort').length;
  view.stdin.write('draft');
  await flush();
  view.stdin.write('\u001b');
  await flush();
  assert.equal(
    transport.calls.filter((entry) => entry.method === 'turn.abort').length,
    abortCount,
  );

  view.stdin.write('/quit');
  await flush();
  view.stdin.write('\r');
  await flush();
  assert.ok(transport.calls.some((entry) => entry.method === 'frontend.exit'));
  assert.equal(exits, 1);
  view.unmount();
});

test('handles model, session, and theme command selectors', async () => {
  const transport = new FakeTransport();
  let exits = 0;
  transport.commandResult = (command) => {
    if (command === '/sessions') {
      return {
        handled: true,
        ui: 'session-selector',
        output: [{
          'session-id': 'session-2',
          path: '/tmp/session-2.jsonl',
          name: 'Second session',
          'message-count': 4,
        }],
      };
    }
    if (command === '/theme') return { handled: true, ui: 'theme-selector' };
    if (command.startsWith('/theme ')) return { handled: true, theme: command.slice(7) };
    return { handled: true };
  };
  const view = render(
    <App transport={transport} onExit={() => { exits += 1; }} />,
  );
  await flush();

  view.stdin.write('/model');
  await flush();
  view.stdin.write('\r');
  await flush();
  assert.match(view.lastFrame() ?? '', /Select model/);
  assert.equal(
    transport.calls.some(
      (entry) =>
        entry.method === 'command.execute' && entry.params.command === '/model',
    ),
    false,
  );
  view.stdin.write('\u001b[B');
  await flush();
  view.stdin.write('\r');
  await flush();
  assert.ok(transport.calls.some(
    (entry) => entry.method === 'model.select' && entry.params.provider === 'local',
  ));

  view.stdin.write('/theme');
  await flush();
  view.stdin.write('\r');
  await flush();
  assert.match(view.lastFrame() ?? '', /Select Theme/);
  view.stdin.write('\u001b[A');
  await flush();
  assert.equal(getActiveTheme().name, 'Qwen Light');
  assert.equal(qwenTheme.text.accent, '#8B5CF6');
  view.stdin.write('\u001b');
  await flush();
  assert.equal(getActiveTheme().name, 'Qwen Dark');

  view.stdin.write('/theme');
  await flush();
  view.stdin.write('\r');
  await flush();
  view.stdin.write('\u001b[A');
  await flush();
  view.stdin.write('\r');
  await flush();
  assert.ok(transport.calls.some(
    (entry) =>
      entry.method === 'command.execute' && entry.params.command === '/theme Qwen Light',
  ));

  view.stdin.write('/theme midnight');
  await flush();
  view.stdin.write('\r');
  await flush();
  assert.match(view.lastFrame() ?? '', /Theme "midnight" not found/);
  assert.match(view.lastFrame() ?? '', /Select Theme/);
  assert.equal(
    transport.calls.some(
      (entry) =>
        entry.method === 'command.execute' && entry.params.command === '/theme midnight',
    ),
    false,
  );
  view.stdin.write('\u001b');
  await flush();

  view.stdin.write('/sessions');
  await flush();
  view.stdin.write('\r');
  await flush();
  assert.match(view.lastFrame() ?? '', /Second session/);
  view.stdin.write('\r');
  await flush();
  assert.ok(transport.calls.some(
    (entry) =>
      entry.method === 'frontend.exit' &&
      objectAt(entry.params, 'outcome')?.next_session === '/tmp/session-2.jsonl',
  ));
  assert.equal(exits, 1);
  view.unmount();
});

test('resolves approval and generic confirm prompts through separate methods', async () => {
  const approval = {
    id: 'approval-1',
    kind: 'select',
    title: 'Run command?',
    message: 'npm test',
    items: [
      { label: 'Allow once', value: 'allow' },
      { label: 'Allow session', value: 'allow-session' },
      { label: 'Deny', value: 'deny' },
    ],
    default: 'allow',
  };
  const transport = new FakeTransport(snapshot('tool', [approval]));
  const view = render(<App transport={transport} />);
  await flush();
  const approvalFrame = view.lastFrame() ?? '';
  assert.match(approvalFrame, /bb-agent/);
  assert.match(approvalFrame, /existing message/);
  assert.match(approvalFrame, /Run command/);
  assert.doesNotMatch(approvalFrame, /Type your message/);
  assert.doesNotMatch(approvalFrame, /\? for shortcuts/);
  view.stdin.write('\r');
  await flush();
  assert.ok(transport.calls.some(
    (entry) =>
      entry.method === 'interaction.resolve' && entry.params.decision === 'allow',
  ));
  view.unmount();

  const confirm = {
    id: 'confirm-1',
    kind: 'confirm',
    title: 'Continue?',
    message: 'Confirm the operation',
    items: [
      { label: 'Yes', value: true },
      { label: 'No', value: false },
    ],
    default: false,
  } as unknown as Snapshot['interactions'][number];
  const confirmTransport = new FakeTransport(snapshot('idle', [confirm]));
  const confirmView = render(<App transport={confirmTransport} />);
  await flush();
  assert.match(confirmView.lastFrame() ?? '', /Continue/);
  confirmView.stdin.write('\u001b[A');
  await flush();
  confirmView.stdin.write('\r');
  await flush();
  assert.ok(confirmTransport.calls.some(
    (entry) =>
      entry.method === 'ui.prompt.resolve' && entry.params.value === true,
  ));
  confirmView.unmount();
});

test('resolves input prompts as strings and does not cancel required input', async () => {
  const inputPrompt = {
    id: 'input-1',
    kind: 'input',
    title: 'Your name',
    message: 'Enter a display name',
    placeholder: 'Ada',
    'required?': true,
    items: [],
  } as unknown as Snapshot['interactions'][number];
  const transport = new FakeTransport(snapshot('idle', [inputPrompt]));
  const view = render(<App transport={transport} />);
  await flush();
  assert.match(view.lastFrame() ?? '', /Your name/);
  assert.match(view.lastFrame() ?? '', /Ada/);

  view.stdin.write('\u001b');
  await flush();
  assert.equal(
    transport.calls.some((entry) => entry.method === 'ui.prompt.resolve'),
    false,
  );
  assert.match(view.lastFrame() ?? '', /cannot be cancelled/);

  view.stdin.write('Grace');
  await flush();
  view.stdin.write('\r');
  await flush();
  assert.ok(transport.calls.some(
    (entry) =>
      entry.method === 'ui.prompt.resolve' && entry.params.value === 'Grace',
  ));
  view.unmount();
});

test('keeps a custom prompt open until its JSON parses', async () => {
  const customPrompt = {
    id: 'custom-1',
    kind: 'custom',
    title: 'Tool parameters',
    message: 'Enter a JSON value',
    placeholder: '{"count": 2}',
    items: [],
  } as unknown as Snapshot['interactions'][number];
  const transport = new FakeTransport(snapshot('idle', [customPrompt]));
  const view = render(<App transport={transport} />);
  await flush();

  view.stdin.write('{');
  await flush();
  view.stdin.write('\r');
  await flush();
  assert.match(view.lastFrame() ?? '', /Invalid JSON/);
  assert.equal(
    transport.calls.some((entry) => entry.method === 'ui.prompt.resolve'),
    false,
  );

  view.stdin.write('\u007f');
  await flush();
  view.stdin.write('{"count":2}');
  await flush();
  view.stdin.write('\r');
  await flush();
  const resolution = transport.calls.find(
    (entry) => entry.method === 'ui.prompt.resolve',
  );
  assert.deepEqual(resolution?.params.value, { count: 2 });
  view.unmount();
});

test('supports scalar prompt options and optional cancellation', async () => {
  const selectPrompt = {
    id: 'select-1',
    kind: 'select',
    title: 'Choose a mode',
    options: ['quick', { label: 'Deep mode', value: { mode: 'deep' } }],
    default: 'quick',
  } as unknown as Snapshot['interactions'][number];
  const transport = new FakeTransport(snapshot('idle', [selectPrompt]));
  const view = render(<App transport={transport} />);
  await flush();
  assert.match(view.lastFrame() ?? '', /quick/);
  assert.match(view.lastFrame() ?? '', /Deep mode/);
  view.stdin.write('\r');
  await flush();
  assert.ok(transport.calls.some(
    (entry) =>
      entry.method === 'ui.prompt.resolve' && entry.params.value === 'quick',
  ));
  view.unmount();

  const optionalInput = {
    id: 'input-optional',
    kind: 'input',
    title: 'Optional note',
    items: [],
  } as unknown as Snapshot['interactions'][number];
  const cancelTransport = new FakeTransport(snapshot('idle', [optionalInput]));
  const cancelView = render(<App transport={cancelTransport} />);
  await flush();
  cancelView.stdin.write('\u001b');
  await flush();
  assert.ok(cancelTransport.calls.some(
    (entry) =>
      entry.method === 'ui.prompt.resolve' && entry.params.cancelled === true,
  ));
  cancelView.unmount();
});

test('requires a second idle Ctrl+C to exit and exits on empty Ctrl+D', async () => {
  const ctrlCTransport = new FakeTransport();
  let ctrlCExits = 0;
  const ctrlCView = render(
    <App
      transport={ctrlCTransport}
      onExit={() => { ctrlCExits += 1; }}
    />,
  );
  await flush();

  ctrlCView.stdin.write('discard me');
  await flush();
  ctrlCView.stdin.write('\u0003');
  await flush();
  assert.match(ctrlCView.lastFrame() ?? '', /再按一次 Ctrl\+C 退出/);
  assert.equal(
    ctrlCTransport.calls.some((entry) => entry.method === 'frontend.exit'),
    false,
  );

  ctrlCView.stdin.write('\u0003');
  await flush();
  assert.ok(
    ctrlCTransport.calls.some((entry) => entry.method === 'frontend.exit'),
  );
  assert.equal(ctrlCExits, 1);
  ctrlCView.unmount();

  const ctrlDTransport = new FakeTransport();
  let ctrlDExits = 0;
  const ctrlDView = render(
    <App
      transport={ctrlDTransport}
      onExit={() => { ctrlDExits += 1; }}
    />,
  );
  await flush();
  ctrlDView.stdin.write('\u0004');
  await flush();
  assert.ok(
    ctrlDTransport.calls.some((entry) => entry.method === 'frontend.exit'),
  );
  assert.equal(ctrlDExits, 1);
  ctrlDView.unmount();
});

test('checks out a selected tree event without replacing live projection state', async () => {
  const transport = new FakeTransport();
  transport.commandResult = (command) => {
    if (command === '/tree') {
      return {
        handled: true,
        ui: 'tree-selector',
        output: [{
          id: 'event-1',
          type: 'message',
          role: 'user',
          at: '2026-08-19T00:00:00Z',
        }],
      };
    }
    if (command === '/checkout event-1') {
      return {
        handled: true,
        output: { 'event-id': 'event-1', 'message-count': 1 },
      };
    }
    return { handled: true };
  };
  const view = render(<App transport={transport} />);
  await flush();

  view.stdin.write('/tree');
  await flush();
  view.stdin.write('\r');
  await flush();
  assert.match(view.lastFrame() ?? '', /Session tree/);
  assert.match(view.lastFrame() ?? '', /event-1/);

  view.stdin.write('\r');
  await flush();
  assert.ok(transport.calls.some(
    (entry) =>
      entry.method === 'command.execute' &&
      entry.params.command === '/checkout event-1',
  ));
  assert.equal(
    transport.calls.filter((entry) => entry.method === 'session.snapshot').length,
    1,
  );
  view.unmount();
});

test('renders structured command output as multiline local history', async () => {
  const transport = new FakeTransport();
  transport.commandResult = (command) =>
    command === '/tools'
      ? {
          handled: true,
          output: [{ name: 'shell', description: 'Run\ncommands' }],
        }
      : { handled: true };
  const view = render(<App transport={transport} />);
  await flush();

  view.stdin.write('/tools');
  await flush();
  view.stdin.write('\r');
  await flush();
  const frame = view.lastFrame() ?? '';
  assert.match(frame, /\$ \/tools/);
  assert.match(frame, /"name": "shell"/);
  assert.match(frame, /Run\\ncommands/);
  view.unmount();
});

test('renders host extension slots and invokes a registered shortcut', async () => {
  const transport = new FakeTransport();
  const view = render(<App transport={transport} />);
  await flush();

  transport.emit({
    type: 'event',
    event: 'ui/extensions',
    data: {
      kind: 'snapshot',
      snapshot: {
        theme: 'Dracula',
        registries: {
          shortcuts: { 'ctrl+g': { description: 'Show goals', 'host-invokable': true } },
          statuses: { lsp: { value: 'ready' } },
          widgets: {
            goals: {
              value: 'Two goals remaining',
              options: { placement: 'above-editor' },
            },
          },
        },
      },
    },
  });
  transport.emit({
    type: 'event',
    event: 'ui/extensions',
    data: {
      kind: 'notification',
      notification: { id: 'notice-1', text: 'Index ready', level: 'success' },
    },
  });
  await flush();

  const frame = view.lastFrame() ?? '';
  assert.match(frame, /Two goals remaining/);
  assert.match(frame, /Index ready/);
  assert.match(frame, /lsp: ready/);
  assert.equal(getActiveTheme().name, 'Dracula');
  assert.equal(qwenTheme.border.focused, '#8be9fd');

  view.stdin.write('\u0007');
  await flush();
  assert.ok(transport.calls.some(
    (entry) =>
      entry.method === 'ui.shortcut.invoke' && entry.params.shortcut === 'ctrl+g',
  ));
  view.unmount();
});

test('renders startup failures without writing protocol output itself', async () => {
  const transport = new FakeTransport();
  transport.failSnapshot = true;
  const view = render(<App transport={transport} />);
  await flush();
  assert.match(view.lastFrame() ?? '', /Failed to start TUI: snapshot unavailable/);
  view.unmount();
});

function objectAt(
  source: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = source[key];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
