import assert from 'node:assert/strict';
import test from 'node:test';
import { render } from 'ink-testing-library';

import { QueuedMessageDisplay } from './QueuedMessageDisplay.js';

test('shows three compact queue previews, overflow, and the follow-up hint', () => {
  const view = render(
    <QueuedMessageDisplay
      items={[
        { id: '1', kind: 'follow-up', message: 'first\nmessage' },
        { id: '2', kind: 'follow-up', message: 'second' },
        { id: '3', kind: 'follow-up', message: 'third' },
        { id: '4', kind: 'follow-up', message: 'hidden fourth' },
      ]}
    />,
  );
  const frame = view.lastFrame() ?? '';
  assert.match(frame, /first message/);
  assert.match(frame, /second/);
  assert.match(frame, /third/);
  assert.doesNotMatch(frame, /hidden fourth/);
  assert.match(frame, /\.\.\. \(\+1 more\)/);
  assert.match(frame, /Alt\+Enter to queue a follow-up/);
  view.unmount();
});

test('renders nothing for an empty queue', () => {
  const view = render(<QueuedMessageDisplay items={[]} />);
  assert.equal(view.lastFrame(), '');
  view.unmount();
});
