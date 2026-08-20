import assert from 'node:assert/strict';
import test from 'node:test';
import { useState } from 'react';
import { render } from 'ink-testing-library';

import { Composer, type ComposerCommand } from './Composer.js';

function VisualHarness({ commands = [] }: { commands?: ComposerCommand[] }) {
  const [value, setValue] = useState('');
  return (
    <Composer
      value={value}
      onChange={setValue}
      onSubmit={() => {}}
      busy={false}
      commands={commands}
    />
  );
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 50));

test('renders the Qwen-style horizontal input and default prompt', () => {
  const view = render(<VisualHarness />);
  const frame = view.lastFrame() ?? '';
  assert.match(frame, /^─{20,}/m);
  assert.match(frame, />\s+Type your message or @path\/to\/file/);
  assert.doesNotMatch(frame, /[╭╮╰╯]/);
  view.unmount();
});

test('renders up to eight command suggestions below the input', async () => {
  const commands = Array.from({ length: 10 }, (_, index) => ({
    name: `command-${index}`,
    description: `Description\n${index}`,
  }));
  const view = render(<VisualHarness commands={commands} />);
  view.stdin.write('/');
  await flush();

  const frame = view.lastFrame() ?? '';
  const bottomBorder = frame.lastIndexOf('─');
  const firstSuggestion = frame.indexOf('/command-0');
  assert.ok(firstSuggestion > bottomBorder);
  assert.match(frame, /> \/command-0/);
  assert.match(frame, /Description 0/);
  assert.match(frame, /▼/);
  assert.match(frame, /\(1\/10\)/);
  assert.doesNotMatch(frame, /\/command-8/);
  view.unmount();
});
