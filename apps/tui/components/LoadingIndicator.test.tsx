import assert from 'node:assert/strict';
import test from 'node:test';
import { render } from 'ink-testing-library';

import { LoadingIndicator } from './LoadingIndicator.js';

test('renders nothing while idle and a timed Qwen-style busy row', () => {
  const idle = render(<LoadingIndicator busy={false} phase="model" />);
  assert.equal(idle.lastFrame(), '');
  idle.unmount();

  const busy = render(
    <LoadingIndicator busy phase="model" elapsedSeconds={12} />,
  );
  const frame = busy.lastFrame() ?? '';
  assert.match(frame, /⠋ Thinking…/);
  assert.match(frame, /\(12s · esc to cancel\)/);
  busy.unmount();
});

test('uses a compact cancel affordance on ultra-narrow terminals', () => {
  const view = render(
    <LoadingIndicator busy phase="tool" terminalWidth={30} />,
  );
  assert.match(view.lastFrame() ?? '', /\(Esc to cancel\)/);
  assert.doesNotMatch(view.lastFrame() ?? '', /Working/);
  view.unmount();
});
