import assert from 'node:assert/strict';
import test from 'node:test';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import type { HistoryItem, HistoryItemToolGroup } from '../types.js';
import { HistoryItemDisplay } from './HistoryItemDisplay.js';
import { isFinal, MainContent } from './MainContent.js';
import { MarkdownDisplay } from './MarkdownDisplay.js';
import { ToolGroup } from './ToolGroup.js';

const toolGroup: HistoryItemToolGroup = {
  id: 'tools-1',
  type: 'tool-group',
  tools: [
    {
      callId: 'call-1',
      name: 'read_file',
      arguments: { path: '/tmp/example.txt' },
      status: 'success',
      updates: [],
      result: {
        content: ['first', 'second', 'third', 'fourth'].join('\n'),
        durationMs: 12,
      },
    },
  ],
};

test('MarkdownDisplay uses Qwen block chrome and no separate streaming cursor', () => {
  const view = render(
    <MarkdownDisplay
      text={'# Heading\n- item with **weight**\n> note\n```ts\nconst n = 1\n```'}
      contentWidth={60}
      isPending
    />,
  );
  const frame = view.lastFrame() ?? '';
  assert.match(frame, /Heading/);
  assert.match(frame, /- item with weight/);
  assert.match(frame, /│ note/);
  assert.match(frame, /ts/);
  assert.match(frame, /const n = 1/);
  assert.doesNotMatch(frame, /[╭╮╰╯]/);
  assert.doesNotMatch(frame, /▍/);
});

test('ToolGroup uses a semantic compact row and complete full detail', () => {
  const view = render(<ToolGroup item={toolGroup} terminalWidth={60} expanded={false} />);
  assert.match(view.lastFrame() ?? '', /✓ Read \/tmp\/example\.txt/);
  assert.doesNotMatch(view.lastFrame() ?? '', /tools|complete|[▸▾]/);
  assert.doesNotMatch(view.lastFrame() ?? '', /first/);

  view.rerender(
    <ToolGroup item={toolGroup} terminalWidth={60} expanded maxOutputLines={2} />,
  );
  const expanded = view.lastFrame() ?? '';
  assert.match(expanded, /ReadFile \/tmp\/example\.txt/);
  assert.doesNotMatch(expanded, /\bdone\b|12ms/);
  assert.doesNotMatch(expanded, /^\s*(?:input|output|error|update)\s*$/m);
  assert.doesNotMatch(expanded, /"path":/);
  assert.match(expanded, /first/);
  assert.match(expanded, /second/);
  assert.match(expanded, /third/);
  assert.match(expanded, /fourth/);
  assert.doesNotMatch(expanded, /lines hidden/);
});

test('a focused ToolGroup toggles from the keyboard', async () => {
  const view = render(
    <ToolGroup item={toolGroup} terminalWidth={60} isFocused />,
  );
  assert.doesNotMatch(view.lastFrame() ?? '', /first/);
  view.stdin.write('\r');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(view.lastFrame() ?? '', /first/);
  view.stdin.write('\u001B[D');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.doesNotMatch(view.lastFrame() ?? '', /first/);
});

test('HistoryItemDisplay folds live reasoning and uses Qwen assistant chrome', () => {
  const assistant: HistoryItem = {
    id: 'assistant-1',
    type: 'assistant',
    reasoning: 'Checking the repository',
    text: 'Working **now**',
    streaming: true,
  };
  const view = render(
    <HistoryItemDisplay item={assistant} terminalWidth={72} isPending />,
  );
  const frame = view.lastFrame() ?? '';
  assert.match(frame, /∵︎ Thinking…/);
  assert.doesNotMatch(frame, /Checking the repository/);
  assert.match(frame, /◆︎ Working now/);
  assert.doesNotMatch(frame, /▍/);

  view.rerender(
    <HistoryItemDisplay item={assistant} terminalWidth={72} isPending reasoningExpanded />,
  );
  assert.match(view.lastFrame() ?? '', /Checking the repository/);

  view.rerender(
    <HistoryItemDisplay
      item={{ id: 'error-1', type: 'error', text: 'Agent failed' }}
      terminalWidth={72}
    />,
  );
  assert.match(view.lastFrame() ?? '', /✕ Agent failed/);
});

test('MainContent renders committed history and a mutable pending tail', () => {
  const history: HistoryItem[] = [
    { id: 'user-1', type: 'user', text: 'Inspect the project' },
    { id: 'assistant-1', type: 'assistant', text: 'I will inspect it.' },
  ];
  const pending: HistoryItem[] = [
    { id: 'assistant-2', type: 'assistant', text: 'Reading files', streaming: true },
  ];
  const view = render(
    <MainContent history={history} pendingHistory={pending} terminalWidth={72} />,
  );
  const frame = view.lastFrame() ?? '';
  assert.match(frame, /> Inspect the project/);
  assert.match(frame, /I will inspect it\./);
  assert.match(frame, /Reading files/);
  assert.match(frame, /◆︎ Reading files/);
  assert.doesNotMatch(frame, /▍/);
});

test('MainContent commits canceled tool groups but keeps confirming groups live', () => {
  const canceled: HistoryItem = {
    id: 'canceled-tools',
    type: 'tool-group',
    tools: [{
      callId: 'canceled',
      name: 'read',
      arguments: { path: 'partial.ts' },
      status: 'canceled',
      updates: ['partial output'],
    }],
  };
  const confirming: HistoryItem = {
    id: 'confirming-tools',
    type: 'tool-group',
    tools: [{
      callId: 'confirming',
      name: 'write',
      arguments: { path: 'approval.ts' },
      status: 'confirming',
      updates: [],
    }],
  };

  assert.equal(isFinal(canceled), true);
  assert.equal(isFinal(confirming), false);
});

test('MainContent renders a header as the first scrolling item in both modes', async () => {
  const history: HistoryItem[] = Array.from({ length: 20 }, (_, index) => ({
    id: `info-${index}`,
    type: 'info',
    text: `message-${index}`,
  }));
  const plain = render(
    <MainContent header={<Text>DAO BANNER</Text>} history={history.slice(0, 1)} terminalWidth={48} />,
  );
  assert.ok((plain.lastFrame() ?? '').indexOf('DAO BANNER') < (plain.lastFrame() ?? '').indexOf('message-0'));

  const virtual = render(
    <MainContent
      header={<Text>DAO BANNER</Text>}
      history={history}
      terminalWidth={48}
      viewportHeight={5}
      useVirtualScroll
    />,
  );
  assert.doesNotMatch(virtual.lastFrame() ?? '', /DAO BANNER/);
  virtual.stdin.write('g');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.match(virtual.lastFrame() ?? '', /DAO BANNER/);
});
