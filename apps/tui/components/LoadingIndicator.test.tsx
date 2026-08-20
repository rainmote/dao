import assert from 'node:assert/strict';
import test from 'node:test';
import { act, type ReactElement } from 'react';
import { render } from 'ink-testing-library';

import {
  AnimatedSpinner,
  LoadingIndicator,
  PHRASE_CHANGE_INTERVAL_MS,
  QWEN_LOADING_PHRASES,
  WAITING_FOR_CONFIRMATION_TEXT,
} from './LoadingIndicator.js';

const TEST_PHRASES = ['第一句', '第二句', '第三句'] as const;

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

function renderInAct(node: ReactElement): ReturnType<typeof render> {
  let view: ReturnType<typeof render> | undefined;
  act(() => {
    view = render(node);
  });
  return view as ReturnType<typeof render>;
}

function unmountInAct(view: ReturnType<typeof render>): void {
  act(() => view.unmount());
}

function rerenderInAct(
  view: ReturnType<typeof render>,
  node: ReactElement,
): void {
  act(() => view.rerender(node));
}

test('ships the complete Qwen Chinese loading phrase set', () => {
  assert.equal(QWEN_LOADING_PHRASES.length, 24);
  assert.equal(QWEN_LOADING_PHRASES[0], '正在努力搬砖，请稍候...');
  assert.equal(
    QWEN_LOADING_PHRASES.at(-1),
    '加载的是字节，承载的是对技术的热爱...',
  );
});

test('renders nothing while idle and a timed Qwen-style busy row', () => {
  const idle = renderInAct(<LoadingIndicator busy={false} phase="model" />);
  assert.equal(idle.lastFrame(), '');
  unmountInAct(idle);

  const busy = renderInAct(
    <LoadingIndicator
      busy
      phase="model"
      elapsedSeconds={12}
      phrases={TEST_PHRASES}
      random={() => 0.5}
    />,
  );
  try {
    const frame = busy.lastFrame() ?? '';
    assert.match(frame, /⠋ 第二句/);
    assert.match(frame, /\(12s · esc to cancel\)/);
    assert.equal(frame.split('\n').length, 1);
  } finally {
    unmountInAct(busy);
  }
});

test('an explicit label overrides the rotating phrase', () => {
  const view = renderInAct(
    <LoadingIndicator
      busy
      label="Waiting for user confirmation..."
      elapsedSeconds={3}
      phrases={TEST_PHRASES}
      random={() => 0.9}
    />,
  );
  assert.match(view.lastFrame() ?? '', /⠋ Waiting for user confirmation\.\.\./);
  assert.doesNotMatch(view.lastFrame() ?? '', /第三句/);
  unmountInAct(view);
});

test('renders a static confirmation wait row at every terminal width', (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const view = renderInAct(
    <LoadingIndicator
      busy={false}
      mode="waiting-for-confirmation"
      terminalWidth={20}
      elapsedSeconds={99}
      phrases={TEST_PHRASES}
      random={() => 0}
    />,
  );
  const initialFrame = view.lastFrame() ?? '';
  assert.match(initialFrame, new RegExp(`⠏ ${WAITING_FOR_CONFIRMATION_TEXT.replaceAll('.', '\\.')}`));
  assert.doesNotMatch(initialFrame, /99s|esc to cancel|Esc to cancel|第一句/);

  act(() => context.mock.timers.tick(PHRASE_CHANGE_INTERVAL_MS));
  assert.equal(view.lastFrame(), initialFrame);
  unmountInAct(view);
});

test('uses two rows from 31 through 79 columns', () => {
  const view = renderInAct(
    <LoadingIndicator
      busy
      terminalWidth={79}
      elapsedSeconds={17.5}
      phrases={TEST_PHRASES}
      random={() => 0}
    />,
  );
  const lines = (view.lastFrame() ?? '').split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0] ?? '', /⠋ 第一句/);
  assert.doesNotMatch(lines[0] ?? '', /17s/);
  assert.match(lines[1] ?? '', /\(17s · esc to cancel\)/);
  unmountInAct(view);
});

test('uses a compact cancel affordance on ultra-narrow terminals', () => {
  const view = renderInAct(
    <LoadingIndicator
      busy
      phase="tool"
      terminalWidth={30}
      phrases={TEST_PHRASES}
      random={() => 0}
    />,
  );
  assert.match(view.lastFrame() ?? '', /\(Esc to cancel\)/);
  assert.doesNotMatch(view.lastFrame() ?? '', /第一句/);
  assert.doesNotMatch(view.lastFrame() ?? '', /⠋/);
  unmountInAct(view);
});

test('animates the Qwen dots spinner every 80ms', (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const view = renderInAct(
    <LoadingIndicator
      busy
      elapsedSeconds={0}
      phrases={TEST_PHRASES}
      random={() => 0}
    />,
  );
  assert.match(view.lastFrame() ?? '', /⠋ 第一句/);

  act(() => context.mock.timers.tick(80));
  assert.match(view.lastFrame() ?? '', /⠙ 第一句/);
  unmountInAct(view);
});

test('supports the Qwen tool toggle spinner at 250ms', (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const view = renderInAct(<AnimatedSpinner type="toggle" />);
  assert.equal(view.lastFrame(), '⊶');

  act(() => context.mock.timers.tick(250));
  assert.equal(view.lastFrame(), '⊷');
  unmountInAct(view);
});

test('uses the fixed-width low-frequency tmux spinner', (context) => {
  const previousTmux = process.env.TMUX;
  process.env.TMUX = '/tmp/tmux-test';
  context.mock.timers.enable({ apis: ['setInterval'] });

  try {
    const view = renderInAct(
      <LoadingIndicator
        busy
        elapsedSeconds={0}
        phrases={TEST_PHRASES}
        random={() => 0}
      />,
    );
    assert.match(view.lastFrame() ?? '', /\.  第一句/);

    act(() => context.mock.timers.tick(750));
    assert.match(view.lastFrame() ?? '', /\.\. 第一句/);
    unmountInAct(view);
  } finally {
    if (previousTmux === undefined) delete process.env.TMUX;
    else process.env.TMUX = previousTmux;
  }
});

test('selects a phrase immediately and rotates it every 15 seconds', (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const values = [0, 0.99];
  let call = 0;
  const view = renderInAct(
    <LoadingIndicator
      busy
      elapsedSeconds={0}
      phrases={TEST_PHRASES}
      random={() => values[call++] ?? 0.99}
    />,
  );
  assert.match(view.lastFrame() ?? '', /第一句/);

  act(() => context.mock.timers.tick(PHRASE_CHANGE_INTERVAL_MS));
  assert.match(view.lastFrame() ?? '', /第三句/);
  unmountInAct(view);
});

test('measures local elapsed time from performance.now every 500ms', (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const originalNow = performance.now;
  let now = 1000;
  Object.defineProperty(performance, 'now', {
    configurable: true,
    value: () => now,
  });

  try {
    const view = renderInAct(
      <LoadingIndicator
        busy
        phrases={TEST_PHRASES}
        random={() => 0}
      />,
    );
    assert.match(view.lastFrame() ?? '', /\(0s · esc to cancel\)/);

    now = 2500;
    act(() => context.mock.timers.tick(500));
    assert.match(view.lastFrame() ?? '', /\(1s · esc to cancel\)/);
    unmountInAct(view);
  } finally {
    Object.defineProperty(performance, 'now', {
      configurable: true,
      value: originalNow,
    });
  }
});

test('pauses response time for tool work and resumes without resetting', (context) => {
  context.mock.timers.enable({ apis: ['setInterval'] });
  const originalNow = performance.now;
  let now = 1000;
  Object.defineProperty(performance, 'now', {
    configurable: true,
    value: () => now,
  });

  const view = renderInAct(
    <LoadingIndicator
      busy
      phase="model"
      phrases={TEST_PHRASES}
      random={() => 0}
    />,
  );
  try {
    now = 3000;
    act(() => context.mock.timers.tick(500));
    assert.match(view.lastFrame() ?? '', /\(2s · esc to cancel\)/);

    rerenderInAct(
      view,
      <LoadingIndicator
        busy
        phase="tool"
        phrases={TEST_PHRASES}
        random={() => 0}
      />,
    );
    now = 8000;
    act(() => context.mock.timers.tick(500));
    assert.match(view.lastFrame() ?? '', /\(2s · esc to cancel\)/);

    rerenderInAct(
      view,
      <LoadingIndicator
        busy
        phase="model"
        phrases={TEST_PHRASES}
        random={() => 0}
      />,
    );
    now = 9000;
    act(() => context.mock.timers.tick(500));
    assert.match(view.lastFrame() ?? '', /\(3s · esc to cancel\)/);
  } finally {
    unmountInAct(view);
    Object.defineProperty(performance, 'now', {
      configurable: true,
      value: originalNow,
    });
  }
});
