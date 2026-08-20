import {
  forwardRef,
  memo,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
  type Ref,
} from 'react';
import { Box, Text, useBoxMetrics, useInput, type DOMElement } from 'ink';

export interface ScrollableListRef {
  scrollBy: (lines: number) => void;
  scrollTo: (line: number) => void;
  scrollToEnd: () => void;
  getScrollState: () => { scrollTop: number; scrollHeight: number; innerHeight: number };
}

interface ScrollableListProps<T> {
  items: readonly T[];
  renderItem: (item: T, index: number) => ReactElement;
  keyExtractor: (item: T, index: number) => string;
  viewportHeight: number;
  width: number;
  estimatedItemHeight?: number | ((item: T, index: number) => number);
  overscan?: number;
  hasFocus?: boolean;
  captureArrows?: boolean;
  initialFollowBottom?: boolean;
  showScrollbar?: boolean;
}

interface MeasuredRowProps {
  itemKey: string;
  index: number;
  width: number;
  onHeightChange: (key: string, index: number, height: number) => void;
  children: ReactElement;
}

const MeasuredRow = memo(function MeasuredRow({
  itemKey,
  index,
  width,
  onHeightChange,
  children,
}: MeasuredRowProps) {
  const ref = useRef<DOMElement>(null);
  const { height, hasMeasured } = useBoxMetrics(ref);

  useLayoutEffect(() => {
    if (hasMeasured) onHeightChange(itemKey, index, Math.max(0, height));
  }, [hasMeasured, height, index, itemKey, onHeightChange]);

  return (
    <Box ref={ref} width={width} flexDirection="column" flexShrink={0}>
      {children}
    </Box>
  );
});

function firstItemEndingAfter(offsets: readonly number[], line: number): number {
  let low = 1;
  let high = offsets.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((offsets[middle] ?? 0) <= line) low = middle + 1;
    else high = middle;
  }
  return Math.max(0, low - 1);
}

function firstItemStartingAtOrAfter(offsets: readonly number[], line: number): number {
  let low = 0;
  let high = Math.max(0, offsets.length - 1);
  while (low < high) {
    const middle = (low + high) >>> 1;
    if ((offsets[middle] ?? 0) < line) low = middle + 1;
    else high = middle;
  }
  return low;
}

function ScrollableListComponent<T>(
  {
    items,
    renderItem,
    keyExtractor,
    viewportHeight,
    width,
    estimatedItemHeight = 3,
    overscan = 2,
    hasFocus = true,
    captureArrows = false,
    initialFollowBottom = true,
    showScrollbar = true,
  }: ScrollableListProps<T>,
  ref: Ref<ScrollableListRef>,
) {
  const height = Math.max(1, Math.floor(viewportHeight));
  const listWidth = Math.max(1, Math.floor(width));
  const [measuredHeights, setMeasuredHeights] = useState<Record<string, number>>({});
  const [scrollTop, setScrollTop] = useState(0);
  const [followsBottom, setFollowsBottom] = useState(initialFollowBottom);

  const { offsets, totalHeight } = useMemo(() => {
    const nextOffsets = [0];
    let nextTotal = 0;
    for (let index = 0; index < items.length; index += 1) {
      const item = items[index];
      if (item === undefined) continue;
      const key = keyExtractor(item, index);
      const estimate = typeof estimatedItemHeight === 'function'
        ? estimatedItemHeight(item, index)
        : estimatedItemHeight;
      const rawHeight = measuredHeights[key] ?? estimate;
      nextTotal += Number.isFinite(rawHeight) ? Math.max(0, Math.ceil(rawHeight)) : 0;
      nextOffsets.push(nextTotal);
    }
    return { offsets: nextOffsets, totalHeight: nextTotal };
  }, [estimatedItemHeight, items, keyExtractor, measuredHeights]);

  const maxScroll = Math.max(0, totalHeight - height);
  const actualScrollTop = followsBottom ? maxScroll : Math.min(scrollTop, maxScroll);
  const scrollStateRef = useRef({ actualScrollTop, maxScroll, totalHeight });
  scrollStateRef.current = { actualScrollTop, maxScroll, totalHeight };

  const scrollTo = useCallback((target: number) => {
    const state = scrollStateRef.current;
    const next = Math.max(0, Math.min(state.maxScroll, Math.floor(target)));
    const atBottom = next >= state.maxScroll;
    scrollStateRef.current = { ...state, actualScrollTop: next };
    setFollowsBottom(atBottom);
    setScrollTop(next);
  }, []);

  const scrollBy = useCallback((delta: number) => {
    const state = scrollStateRef.current;
    scrollTo(state.actualScrollTop + delta);
  }, [scrollTo]);

  const scrollToEnd = useCallback(() => {
    scrollStateRef.current = {
      ...scrollStateRef.current,
      actualScrollTop: scrollStateRef.current.maxScroll,
    };
    setFollowsBottom(true);
    setScrollTop(scrollStateRef.current.maxScroll);
  }, []);

  useInput((input, key) => {
    if (captureArrows && key.upArrow) scrollBy(-1);
    else if (captureArrows && key.downArrow) scrollBy(1);
    else if (key.pageUp) scrollBy(-height);
    else if (key.pageDown) scrollBy(height);
    else if (key.home || input === 'g') scrollTo(0);
    else if (key.end || input === 'G') scrollToEnd();
  }, { isActive: hasFocus });

  useImperativeHandle(ref, () => ({
    scrollBy,
    scrollTo,
    scrollToEnd,
    getScrollState: () => ({
      scrollTop: scrollStateRef.current.actualScrollTop,
      scrollHeight: scrollStateRef.current.totalHeight,
      innerHeight: height,
    }),
  }), [height, scrollBy, scrollTo, scrollToEnd]);

  useLayoutEffect(() => {
    setMeasuredHeights((previous) => {
      if (Object.keys(previous).length <= Math.max(8, items.length * 2)) return previous;
      const liveKeys = new Set(items.map((item, index) => keyExtractor(item, index)));
      const entries = Object.entries(previous);
      if (entries.every(([key]) => liveKeys.has(key))) return previous;
      return Object.fromEntries(entries.filter(([key]) => liveKeys.has(key)));
    });
  }, [items.length]);

  const onHeightChange = useCallback((key: string, _index: number, nextHeight: number) => {
    setMeasuredHeights((previous) => previous[key] === nextHeight
      ? previous
      : { ...previous, [key]: nextHeight });
  }, []);

  const firstVisible = Math.min(
    Math.max(0, items.length - 1),
    firstItemEndingAfter(offsets, actualScrollTop),
  );
  const firstAfterViewport = Math.min(
    items.length,
    firstItemStartingAtOrAfter(offsets, actualScrollTop + height),
  );
  const startIndex = Math.max(0, firstVisible - overscan);
  const endIndex = Math.min(items.length - 1, firstAfterViewport + overscan);
  const topSpacer = offsets[startIndex] ?? 0;
  const bottomSpacer = Math.max(0, totalHeight - (offsets[endIndex + 1] ?? totalHeight));
  const visibleItems: ReactElement[] = [];
  for (let index = startIndex; index <= endIndex; index += 1) {
    const item = items[index];
    if (item === undefined) continue;
    const key = keyExtractor(item, index);
    visibleItems.push(
      <MeasuredRow
        key={key}
        itemKey={key}
        index={index}
        width={Math.max(1, listWidth - 1)}
        onHeightChange={onHeightChange}
      >
        {renderItem(item, index)}
      </MeasuredRow>,
    );
  }

  const rootHeight = Math.max(1, Math.min(height, Math.max(1, totalHeight)));
  const scrollbarVisible = showScrollbar && maxScroll > 0;
  const thumbHeight = scrollbarVisible
    ? Math.max(1, Math.round((height * height) / Math.max(height, totalHeight)))
    : 0;
  const thumbTop = scrollbarVisible
    ? Math.round((actualScrollTop / Math.max(1, maxScroll)) * (height - thumbHeight))
    : 0;

  return (
    <Box width={listWidth} height={rootHeight} flexDirection="row">
      <Box width={Math.max(1, listWidth - 1)} height={rootHeight} overflowY="hidden" overflowX="hidden">
        <Box
          width={Math.max(1, listWidth - 1)}
          flexDirection="column"
          flexShrink={0}
          marginTop={-actualScrollTop}
        >
          <Box height={topSpacer} flexShrink={0} />
          {visibleItems}
          <Box height={bottomSpacer} flexShrink={0} />
        </Box>
      </Box>
      <Box width={1} height={rootHeight} flexDirection="column" flexShrink={0}>
        {Array.from({ length: rootHeight }, (_, row) => {
          const inThumb = scrollbarVisible && row >= thumbTop && row < thumbTop + thumbHeight;
          return <Text key={row} dimColor={!inThumb}>{scrollbarVisible ? (inThumb ? '#' : '|') : ' '}</Text>;
        })}
      </Box>
    </Box>
  );
}

export const ScrollableList = forwardRef(ScrollableListComponent) as <T>(
  props: ScrollableListProps<T> & { ref?: Ref<ScrollableListRef> },
) => ReactElement;
