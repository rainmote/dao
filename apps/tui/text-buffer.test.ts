import assert from 'node:assert/strict';
import test from 'node:test';
import { createElement, useState } from 'react';
import { render } from 'ink-testing-library';

import {
  Composer,
  type ComposerAbortReason,
  type ComposerCommand,
  type ComposerSubmitOptions,
} from './components/Composer.js';
import {
  createTextBuffer,
  deleteBackward,
  deleteForward,
  getCursorLocation,
  graphemeBoundaries,
  graphemes,
  insertNewline,
  insertText,
  moveCursor,
  normalizeCursor,
  reconcileTextBuffer,
  splitLinesWithOffsets,
} from './text-buffer.js';

test('segments combining characters, flags, and ZWJ emoji as cursor units', () => {
  const text = 'e\u0301🇭🇰👨‍👩‍👧‍👦';
  assert.deepEqual(graphemes(text), ['e\u0301', '🇭🇰', '👨‍👩‍👧‍👦']);
  assert.deepEqual(graphemeBoundaries(text), [
    0,
    'e\u0301'.length,
    'e\u0301🇭🇰'.length,
    text.length,
  ]);
});

test('normalizes unsafe offsets and moves without splitting graphemes', () => {
  const family = '👨‍👩‍👧‍👦';
  const text = `A${family}B`;
  assert.equal(normalizeCursor(text, 3), 1);

  let buffer = createTextBuffer(text);
  buffer = moveCursor(buffer, 'left');
  assert.equal(buffer.cursor, 1 + family.length);
  buffer = moveCursor(buffer, 'left');
  assert.equal(buffer.cursor, 1);
  buffer = moveCursor(buffer, 'right');
  assert.equal(buffer.cursor, 1 + family.length);
});

test('backspace and delete remove a whole grapheme', () => {
  const family = '👨‍👩‍👧‍👦';
  const afterFamily = createTextBuffer(`A${family}B`, 1 + family.length);
  assert.deepEqual(deleteBackward(afterFamily), {
    text: 'AB',
    cursor: 1,
    preferredColumn: null,
  });

  const beforeFamily = createTextBuffer(`A${family}B`, 1);
  assert.deepEqual(deleteForward(beforeFamily), {
    text: 'AB',
    cursor: 1,
    preferredColumn: null,
  });
});

test('inserts Unicode and normalizes pasted line endings', () => {
  let buffer = createTextBuffer('ab', 1);
  buffer = insertText(buffer, '🇭🇰\r\n好');
  assert.equal(buffer.text, 'a🇭🇰\n好b');
  assert.equal(buffer.cursor, 'a🇭🇰\n好'.length);
  assert.equal(getCursorLocation(buffer).line, 1);

  buffer = insertNewline(buffer);
  assert.equal(buffer.text, 'a🇭🇰\n好\nb');
  assert.deepEqual(getCursorLocation(buffer), {
    line: 2,
    column: 0,
    lineStart: 'a🇭🇰\n好\n'.length,
    lineEnd: buffer.text.length,
  });
});

test('backspace and delete join adjacent lines at a newline boundary', () => {
  const text = 'one\ntwo';
  assert.deepEqual(deleteBackward(createTextBuffer(text, 4)), {
    text: 'onetwo',
    cursor: 3,
    preferredColumn: null,
  });
  assert.deepEqual(deleteForward(createTextBuffer(text, 3)), {
    text: 'onetwo',
    cursor: 3,
    preferredColumn: null,
  });
});

test('vertical movement preserves the preferred grapheme column', () => {
  const text = 'abcde\n🙂\n12345';
  let buffer = createTextBuffer(text, text.length - 1);
  assert.equal(getCursorLocation(buffer).column, 4);

  buffer = moveCursor(buffer, 'up');
  assert.deepEqual(getCursorLocation(buffer), {
    line: 1,
    column: 1,
    lineStart: 6,
    lineEnd: 8,
  });
  assert.equal(buffer.preferredColumn, 4);

  buffer = moveCursor(buffer, 'up');
  assert.equal(getCursorLocation(buffer).column, 4);
  buffer = moveCursor(buffer, 'down');
  buffer = moveCursor(buffer, 'down');
  assert.equal(getCursorLocation(buffer).column, 4);
});

test('home/end are line-local and leading/trailing empty lines are valid', () => {
  const text = '\nalpha\n';
  let buffer = createTextBuffer(text, 4);
  buffer = moveCursor(buffer, 'home');
  assert.equal(buffer.cursor, 1);
  buffer = moveCursor(buffer, 'end');
  assert.equal(buffer.cursor, 6);

  assert.deepEqual(splitLinesWithOffsets(text), [
    { text: '', start: 0, end: 0 },
    { text: 'alpha', start: 1, end: 6 },
    { text: '', start: 7, end: 7 },
  ]);
  assert.equal(getCursorLocation(createTextBuffer(text, 0)).line, 0);
  assert.equal(getCursorLocation(createTextBuffer(text, text.length)).line, 2);
});

test('controlled text reconciliation clamps the cursor safely', () => {
  const buffer = createTextBuffer('ABCD', 2);
  assert.deepEqual(reconcileTextBuffer(buffer, 'A🙂D'), {
    text: 'A🙂D',
    cursor: 1,
    preferredColumn: null,
  });
});

const flushInput = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 40);
  });

function ComposerHarness({
  busy,
  commands,
  onSubmit,
  onAbort,
  onExitRequest,
  shortcutNames,
  onShortcut,
}: {
  busy: boolean;
  commands?: readonly ComposerCommand[];
  onSubmit: (value: string, options: ComposerSubmitOptions) => void;
  onAbort?: (reason?: ComposerAbortReason) => void;
  onExitRequest?: () => void;
  shortcutNames?: readonly string[];
  onShortcut?: (shortcut: string) => void;
}) {
  const [value, setValue] = useState('');
  return createElement(Composer, {
    value,
    onChange: setValue,
    onSubmit,
    onAbort,
    onExitRequest,
    shortcutNames,
    onShortcut,
    busy,
    commands,
  });
}

test('composer completes slash commands and routes Qwen busy Enter/Ctrl+Q modes', async () => {
  const submissions: Array<[string, ComposerSubmitOptions]> = [];
  const view = render(
    createElement(ComposerHarness, {
      busy: true,
      commands: [{ name: 'help', description: 'Show help' }],
      onSubmit: (value, options) => submissions.push([value, options]),
    }),
  );

  view.stdin.write('/he');
  await flushInput();
  assert.match(view.lastFrame() ?? '', /\/help\s+Show help/);

  view.stdin.write('\r');
  await flushInput();
  assert.match(view.lastFrame() ?? '', /\/help /);
  assert.equal(submissions.length, 0);

  view.stdin.write('\r');
  await flushInput();
  assert.deepEqual(submissions, [['/help ', { deferUntilIdle: false }]]);

  view.stdin.write('later');
  await flushInput();
  view.stdin.write('\u0011');
  await flushInput();
  assert.deepEqual(submissions[1], ['later', { deferUntilIdle: true }]);

  view.stdin.write('line one');
  await flushInput();
  view.stdin.write('\u001b\r');
  await flushInput();
  assert.match(view.lastFrame() ?? '', /line one/);
  assert.equal(submissions.length, 2);
  view.unmount();
});

test('composer routes Ctrl+C and Escape to abort without changing text', async () => {
  let aborts = 0;
  const view = render(
    createElement(ComposerHarness, {
      busy: true,
      onSubmit: () => {},
      onAbort: () => {
        aborts += 1;
      },
    }),
  );
  view.stdin.write('draft');
  await flushInput();
  view.stdin.write('\u0003');
  await flushInput();
  view.stdin.write('\u001b');
  await flushInput();
  assert.equal(aborts, 2);
  assert.match(view.lastFrame() ?? '', /draft/);
  view.unmount();
});

test('composer reports the abort key and routes empty Ctrl+D to exit', async () => {
  const reasons: Array<ComposerAbortReason | undefined> = [];
  let exits = 0;
  const view = render(
    createElement(ComposerHarness, {
      busy: false,
      onSubmit: () => {},
      onAbort: (reason) => reasons.push(reason),
      onExitRequest: () => {
        exits += 1;
      },
    }),
  );
  view.stdin.write('\u001b');
  await flushInput();
  view.stdin.write('\u0003');
  await flushInput();
  view.stdin.write('\u0004');
  await flushInput();
  assert.deepEqual(reasons, ['escape', 'ctrl-c']);
  assert.equal(exits, 1);
  view.unmount();
});

test('composer gives registered host shortcuts precedence over built-in keys', async () => {
  const shortcuts: string[] = [];
  let aborts = 0;
  const view = render(
    createElement(ComposerHarness, {
      busy: false,
      onSubmit: () => {},
      onAbort: () => { aborts += 1; },
      shortcutNames: ['ctrl+c', 'ctrl+g'],
      onShortcut: (shortcut) => shortcuts.push(shortcut),
    }),
  );
  view.stdin.write('\u0007');
  await flushInput();
  view.stdin.write('\u0003');
  await flushInput();
  assert.deepEqual(shortcuts, ['ctrl+g', 'ctrl+c']);
  assert.equal(aborts, 0);
  view.unmount();
});
