import assert from 'node:assert/strict';
import test from 'node:test';
import { render } from 'ink-testing-library';

import type { HistoryItemToolGroup, ToolCall, ToolCallStatus } from '../types.js';
import {
  buildToolSummary,
  getOverallStatus,
  toolDisplayName,
  ToolGroup,
} from './ToolGroup.js';

function tool(
  callId: string,
  name: string,
  arguments_: unknown,
  status: ToolCallStatus = 'success',
): ToolCall {
  return {
    callId,
    name,
    arguments: arguments_,
    status,
    updates: [],
  };
}

function group(tools: ToolCall[]): HistoryItemToolGroup {
  return { id: 'tools-1', type: 'tool-group', tools };
}

test('collapses search, read, and list into one Qwen-ordered semantic sentence', () => {
  const item = group([
    tool('read', 'read', { path: 'src/app.ts' }),
    tool('hash-read', 'hash_read', { path: 'src/hash.ts' }),
    tool('list', 'ls', { path: 'src' }),
    tool('search', 'grep', { pattern: 'needle' }),
  ]);
  const view = render(<ToolGroup item={item} terminalWidth={100} />);
  const frame = view.lastFrame() ?? '';

  assert.match(frame, /✓ Searched needle, read src\/app\.ts, src\/hash\.ts, listed src/);
  assert.equal(frame.trim().split('\n').length, 1);
  view.unmount();
});

test('uses Qwen description preview and count rules', () => {
  const threeReads = [
    tool('a', 'read', { path: 'a.ts' }),
    tool('b', 'read', { path: 'b.ts' }),
    tool('c', 'read', { path: 'c.ts' }),
  ];
  assert.equal(buildToolSummary(threeReads, false), 'Read a.ts, b.ts, c.ts');

  const fourReads = [...threeReads, tool('d', 'read', { path: 'd.ts' })];
  assert.equal(
    buildToolSummary(fourReads, false),
    'Read a.ts, b.ts, ... and 2 more',
  );

  assert.equal(
    buildToolSummary([
      tool('a', 'read', { path: 'a.ts' }),
      tool('b', 'read', {}),
    ], false),
    'Read 2 files',
  );
});

test('cleans ANSI and control characters and rejects JSON fallback descriptions', () => {
  assert.equal(
    buildToolSummary([
      tool('ansi', 'read', { path: '\u001b[32msrc/app.ts\u001b[0m' }),
    ], false),
    'Read src/app.ts',
  );
  assert.equal(
    buildToolSummary([
      tool('osc', 'bash', '\u001b]0;title\u0007echo hello\nworld'),
    ], false),
    'Ran echo hello world',
  );
  assert.equal(
    buildToolSummary([
      tool('json', 'read', '{"file_path":"secret.ts"}'),
    ], false),
    'Read 1 file',
  );
  assert.equal(
    buildToolSummary([tool('path', 'read', '[id].tsx')], false),
    'Read [id].tsx',
  );
});

test('uses Qwen status priority', () => {
  const success = tool('success', 'read', { path: 'a' }, 'success');
  const pending = tool('pending', 'read', { path: 'b' }, 'pending');
  const canceled = tool('canceled', 'read', { path: 'c' }, 'canceled');
  const error = tool('error', 'read', { path: 'c' }, 'error');
  const running = tool('running', 'read', { path: 'd' }, 'running');
  const confirming = tool('confirming', 'read', { path: 'e' }, 'confirming');

  assert.equal(getOverallStatus([success]), 'success');
  assert.equal(getOverallStatus([success, pending]), 'pending');
  assert.equal(getOverallStatus([pending, canceled]), 'canceled');
  assert.equal(getOverallStatus([canceled, error]), 'error');
  assert.equal(getOverallStatus([error, running]), 'running');
  assert.equal(getOverallStatus([running, confirming]), 'confirming');
});

test('uses progressive phrasing, an animated toggle, and an active hint for large batches', async () => {
  const item = group([
    tool('a', 'read', { path: 'a.ts' }),
    tool('b', 'read', { path: 'b.ts' }),
    tool('c', 'read', { path: 'c.ts' }),
    tool('d', 'read', { path: 'd.ts' }, 'running'),
    tool('e', 'read', { path: 'e.ts' }, 'running'),
  ]);
  const view = render(<ToolGroup item={item} terminalWidth={100} />);
  const firstFrame = view.lastFrame() ?? '';
  assert.match(firstFrame, /⊶ Reading a\.ts, b\.ts, \.\.\. and 3 more…/);
  assert.match(firstFrame, /⎿ e\.ts/);

  await new Promise<void>((resolve) => setTimeout(resolve, 300));
  assert.match(view.lastFrame() ?? '', /⊷ Reading/);
  view.unmount();
});

test('shows Qwen elapsed time only after three seconds unless a timeout is declared', async () => {
  const originalNow = Date.now;
  Date.now = () => 10_000;
  try {
    const quietTool = tool('quiet', 'read', { path: 'quick.ts' }, 'running');
    quietTool.executionStartTime = 8_000;
    const quietView = render(<ToolGroup item={group([quietTool])} terminalWidth={100} />);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.doesNotMatch(quietView.lastFrame() ?? '', /2s/);
    quietView.unmount();

    const longTool = tool('long', 'read', { path: 'slow.ts' }, 'running');
    longTool.executionStartTime = 6_000;
    const longView = render(<ToolGroup item={group([longTool])} terminalWidth={100} />);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.match(longView.lastFrame() ?? '', /Reading slow\.ts…\s+4s/);
    longView.unmount();

    const budgeted = tool(
      'budgeted',
      'bash',
      { command: 'npm test', timeout_ms: 30_000 },
      'running',
    );
    budgeted.executionStartTime = 10_000;
    const budgetView = render(<ToolGroup item={group([budgeted])} terminalWidth={100} />);
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    assert.match(budgetView.lastFrame() ?? '', /\(0s · timeout 30s\)/);
    budgetView.unmount();
  } finally {
    Date.now = originalNow;
  }
});

test('renders confirming tools individually with a static question mark and no elapsed time', () => {
  const confirming = tool(
    'confirming',
    'read',
    { path: 'approval.ts', timeout_ms: 30_000 },
    'confirming',
  );
  confirming.executionStartTime = Date.now() - 10_000;

  const view = render(
    <ToolGroup item={group([confirming])} terminalWidth={100} />,
  );
  const frame = view.lastFrame() ?? '';

  assert.match(frame, /\? ReadFile approval\.ts/);
  assert.doesNotMatch(frame, /· confirming/);
  assert.doesNotMatch(frame, /Reading|[⊶⊷]|timeout|10s/);
  view.unmount();
});

test('uses Qwen display names with a stable PascalCase fallback', () => {
  assert.equal(toolDisplayName('edit'), 'Edit');
  assert.equal(toolDisplayName('write_file'), 'WriteFile');
  assert.equal(toolDisplayName('read_file'), 'ReadFile');
  assert.equal(toolDisplayName('hash_read'), 'HashRead');
  assert.equal(toolDisplayName('hash_edit'), 'HashEdit');
  assert.equal(toolDisplayName('grep_search'), 'Grep');
  assert.equal(toolDisplayName('glob'), 'Glob');
  assert.equal(toolDisplayName('run_shell_command'), 'Shell');
  assert.equal(toolDisplayName('shell'), 'Shell');
  assert.equal(toolDisplayName('bash'), 'Shell');
  assert.equal(toolDisplayName('list_directory'), 'ListFiles');
  assert.equal(toolDisplayName('agent'), 'Agent');
  assert.equal(toolDisplayName('list_agents'), 'ListAgents');
  assert.equal(toolDisplayName('send_message'), 'SendMessage');
  assert.equal(toolDisplayName('mystery_tool-name'), 'MysteryToolName');
});

test('keeps mutation, command, agent, and unknown tools as individual rows', () => {
  const item = group([
    tool('read', 'read', { path: 'a.ts' }),
    tool('edit', 'edit', { path: 'b.ts' }),
    tool('write', 'write', { path: 'c.ts' }),
    tool('shell', 'bash', { command: 'npm test' }),
    tool('agent', 'list_agents', { task: 'inspect tests' }),
    tool('other', 'calculate', { expression: '2+2' }),
  ]);
  const view = render(<ToolGroup item={item} terminalWidth={100} />);
  const frame = view.lastFrame() ?? '';

  assert.match(frame, /✓ Read a\.ts/);
  assert.match(frame, /✓ Edit b\.ts/);
  assert.match(frame, /✓ WriteFile c\.ts/);
  assert.match(frame, /✓ Shell npm test/);
  assert.match(frame, /✓ ListAgents inspect tests/);
  assert.match(frame, /✓ Calculate 2\+2/);
  assert.doesNotMatch(frame, /· (?:done|running|failed|pending|confirming|canceled)/);
  assert.doesNotMatch(frame, /Edited|Wrote|Ran npm test|Used 2\+2/);
  view.unmount();
});

test('does not fold custom actions whose names merely contain read or list fragments', () => {
  const review = tool('review', 'review_pr', { description: 'PR 42' });
  review.result = { content: 'REVIEW-RESULT' };
  const blacklist = tool('blacklist', 'blacklist_user', { name: 'spammer' });
  blacklist.result = { content: 'BLACKLIST-RESULT' };

  const view = render(
    <ToolGroup item={group([review, blacklist])} terminalWidth={100} />,
  );
  const frame = view.lastFrame() ?? '';

  assert.match(frame, /✓ ReviewPr PR 42/);
  assert.match(frame, /REVIEW-RESULT/);
  assert.match(frame, /✓ BlacklistUser spammer/);
  assert.match(frame, /BLACKLIST-RESULT/);
  assert.doesNotMatch(frame, /Read PR 42|Listed spammer/);
  view.unmount();
});

test('wraps an individual action description without truncating it', () => {
  const ending = 'FINAL-DESCRIPTION-MARKER';
  const description = `${'inspect every relevant module carefully '.repeat(4)}${ending}`;
  const view = render(
    <ToolGroup
      item={group([tool('agent', 'agent', { description })])}
      terminalWidth={40}
    />,
  );
  const frame = view.lastFrame() ?? '';

  assert.match(frame, /Agent inspect every relevant module carefully/);
  assert.match(frame, new RegExp(ending));
  assert.doesNotMatch(frame, /…/);
  view.unmount();
});

test('shows bounded action results and the latest live update while keeping read results collapsed', () => {
  const read = tool('read', 'read', { path: 'secret.ts' });
  read.result = { content: 'READ-RESULT-MUST-STAY-HIDDEN' };

  const edit = tool('edit', 'edit', { path: 'edited.ts' });
  edit.result = { content: 'EDIT-ONE\nEDIT-TWO\nEDIT-THREE' };

  const write = tool('write', 'write', { path: 'written.ts' });
  write.result = { content: 'WRITE-RESULT' };

  const shell = tool('shell', 'bash', { command: 'npm test' }, 'running');
  shell.updates = ['SHELL-STALE', 'SHELL-ONE\nSHELL-TWO\nSHELL-THREE'];

  const agent = tool('agent', 'list_agents', {});
  agent.result = { content: 'AGENT-RESULT' };

  const other = tool('other', 'calculate', { expression: '2+2' });
  other.result = { content: 'OTHER-RESULT' };

  const view = render(
    <ToolGroup
      item={group([read, edit, write, shell, agent, other])}
      terminalWidth={100}
      maxOutputLines={2}
    />,
  );
  const frame = view.lastFrame() ?? '';

  assert.doesNotMatch(frame, /READ-RESULT-MUST-STAY-HIDDEN/);
  assert.doesNotMatch(frame, /EDIT-ONE|SHELL-STALE|SHELL-ONE/);
  assert.match(frame, /first 1 lines hidden/);
  assert.match(frame, /EDIT-TWO/);
  assert.match(frame, /EDIT-THREE/);
  assert.match(frame, /WRITE-RESULT/);
  assert.match(frame, /SHELL-TWO/);
  assert.match(frame, /SHELL-THREE/);
  assert.match(frame, /AGENT-RESULT/);
  assert.match(frame, /OTHER-RESULT/);
  view.unmount();
});

test('keeps canceled read tools individual and surfaces their partial output', () => {
  const completed = tool('done', 'read', { path: 'done.ts' });
  completed.result = { content: 'DONE-READ-RESULT-HIDDEN' };
  const canceled = tool('canceled', 'read', { path: 'partial.ts' }, 'canceled');
  canceled.updates = ['PARTIAL-READ-OUTPUT'];

  const view = render(
    <ToolGroup item={group([completed, canceled])} terminalWidth={100} />,
  );
  const frame = view.lastFrame() ?? '';

  assert.match(frame, /✓ Read done\.ts/);
  assert.match(frame, /- ReadFile partial\.ts/);
  assert.doesNotMatch(frame, /· canceled/);
  assert.match(frame, /PARTIAL-READ-OUTPUT/);
  assert.doesNotMatch(frame, /DONE-READ-RESULT-HIDDEN/);
  view.unmount();
});

test('an errored tool shows its input and error reason without full-detail mode', () => {
  const completed = tool('completed', 'read', { path: 'context.ts' });
  completed.result = { content: 'context output' };
  const failed = tool('failed', 'read', { path: 'broken.ts' }, 'error');
  failed.result = { error: 'permission denied' };

  const view = render(
    <ToolGroup item={group([completed, failed])} terminalWidth={80} />,
  );
  const frame = view.lastFrame() ?? '';

  assert.match(frame, /ReadFile context\.ts/);
  assert.doesNotMatch(frame, /context output/);
  assert.match(frame, /x ReadFile broken\.ts/);
  assert.doesNotMatch(frame, /· (?:done|failed)/);
  assert.match(frame, /input/);
  assert.match(frame, /"path": "broken\.ts"/);
  assert.match(frame, /error/);
  assert.match(frame, /permission denied/);
  view.unmount();
});

test('expanded mode renders complete tool input and output without truncation', () => {
  const first = tool('a', 'read', { path: 'a.ts' });
  first.result = { content: 'first\nsecond\nthird' };
  const second = tool('b', 'grep', { pattern: 'needle' });
  second.result = { content: 'hit' };
  const view = render(
    <ToolGroup
      item={group([first, second])}
      terminalWidth={60}
      expanded
      maxOutputLines={2}
    />,
  );
  const frame = view.lastFrame() ?? '';

  assert.match(frame, /ReadFile a\.ts/);
  assert.match(frame, /Grep needle/);
  assert.doesNotMatch(frame, /· done|\b\d+ms\b/);
  assert.doesNotMatch(frame, /lines hidden/);
  assert.match(frame, /first/);
  assert.match(frame, /second/);
  assert.match(frame, /third/);
  assert.match(frame, /hit/);
  assert.doesNotMatch(frame, /\bRead a\.ts|Searched needle/);
  view.unmount();
});
