import assert from 'node:assert/strict';
import test from 'node:test';
import { createRef } from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import type { HistoryItem } from '../types.js';
import { MainContent } from './MainContent.js';
import { ScrollableList, type ScrollableListRef } from './ScrollableList.js';

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function rows(count: number): string[] {
  return Array.from({ length: count }, (_, index) => `row-${String(index).padStart(2, '0')}`);
}

test('renders only the bottom viewport with an ASCII scrollbar', () => {
  const rendered: number[] = [];
  const view = render(
    <ScrollableList
      items={rows(100)}
      keyExtractor={(item) => item}
      renderItem={(item, index) => {
        rendered.push(index);
        return <Text>{item}</Text>;
      }}
      estimatedItemHeight={1}
      viewportHeight={5}
      width={24}
      overscan={1}
    />,
  );
  const frame = view.lastFrame() ?? '';
  assert.match(frame, /row-99/);
  assert.doesNotMatch(frame, /row-00/);
  assert.match(frame, /[#|]/);
  assert.ok(rendered.length < 12, `expected a small render window, rendered ${rendered.length}`);
});

test('replaces conservative estimates with measured Ink row heights', async () => {
  const ref = createRef<ScrollableListRef>();
  const view = render(
    <ScrollableList
      ref={ref}
      items={['first\nsecond\nthird']}
      keyExtractor={(item) => item}
      renderItem={(item) => <Text>{item}</Text>}
      estimatedItemHeight={1}
      viewportHeight={2}
      width={24}
    />,
  );
  await tick();
  await new Promise<void>((resolve) => setTimeout(resolve, 50));
  assert.equal(ref.current?.getScrollState().scrollHeight, 3);
  assert.doesNotMatch(view.lastFrame() ?? '', /first/);
  assert.match(view.lastFrame() ?? '', /second/);
  assert.match(view.lastFrame() ?? '', /third/);
});

test('supports arrow and page navigation and resumes following at the bottom', async () => {
  const initial = rows(12);
  const view = render(
    <ScrollableList
      items={initial}
      keyExtractor={(item) => item}
      renderItem={(item) => <Text>{item}</Text>}
      estimatedItemHeight={1}
      viewportHeight={4}
      width={24}
      captureArrows
    />,
  );
  assert.match(view.lastFrame() ?? '', /row-11/);

  view.stdin.write('\u001B[A');
  await tick();
  assert.match(view.lastFrame() ?? '', /row-07/);

  view.stdin.write('\u001B[5~');
  await tick();
  assert.match(view.lastFrame() ?? '', /row-04/);
  assert.doesNotMatch(view.lastFrame() ?? '', /row-11/);

  view.rerender(
    <ScrollableList
      items={[...initial, 'row-12']}
      keyExtractor={(item) => item}
      renderItem={(item) => <Text>{item}</Text>}
      estimatedItemHeight={1}
      viewportHeight={4}
      width={24}
      captureArrows
    />,
  );
  assert.doesNotMatch(view.lastFrame() ?? '', /row-12/);

  view.stdin.write('\u001B[6~');
  view.stdin.write('\u001B[6~');
  await tick();
  assert.match(view.lastFrame() ?? '', /row-12/);

  view.rerender(
    <ScrollableList
      items={[...initial, 'row-12', 'row-13']}
      keyExtractor={(item) => item}
      renderItem={(item) => <Text>{item}</Text>}
      estimatedItemHeight={1}
      viewportHeight={4}
      width={24}
      captureArrows
    />,
  );
  assert.match(view.lastFrame() ?? '', /row-13/);
});

test('MainContent virtualizes a long conversation', () => {
  const history: HistoryItem[] = rows(60).map((text, index) => ({
    id: `message-${index}`,
    type: 'info',
    text,
  }));
  const view = render(
    <MainContent
      history={history}
      terminalWidth={48}
      viewportHeight={6}
      useVirtualScroll
    />,
  );
  const frame = view.lastFrame() ?? '';
  assert.match(frame, /row-59/);
  assert.doesNotMatch(frame, /row-00/);
  assert.ok(frame.split('\n').length <= 6);
});
