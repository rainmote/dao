import type { ReactElement } from 'react';
import { Box, Static } from 'ink';
import type { HistoryItem } from '../types.js';
import { HistoryItemDisplay } from './HistoryItemDisplay.js';
import { ScrollableList } from './ScrollableList.js';

interface MainContentProps {
  header?: ReactElement;
  history: HistoryItem[];
  pendingHistory?: HistoryItem[];
  terminalWidth: number;
  reasoningExpanded?: boolean;
  expandedToolGroupIds?: ReadonlySet<string>;
  focusedToolGroupId?: string;
  maxToolOutputLines?: number;
  viewportHeight?: number;
  useVirtualScroll?: boolean;
  scrollFocused?: boolean;
  scrollCaptureArrows?: boolean;
  showScrollbar?: boolean;
  onToolGroupExpandedChange?: (id: string, expanded: boolean) => void;
}

function isFinal(item: HistoryItem): boolean {
  if (item.type === 'assistant') return item.streaming !== true;
  if (item.type === 'tool-group') {
    return item.tools.every((tool) => tool.status === 'success' || tool.status === 'error');
  }
  return true;
}

function lineEstimate(text: string, width: number): number {
  return text.replace(/\r\n?/g, '\n').split('\n').reduce(
    (sum, line) => sum + Math.max(1, Math.ceil(line.length / Math.max(1, width))),
    0,
  );
}

export function MainContent({
  header,
  history,
  pendingHistory = [],
  terminalWidth,
  reasoningExpanded = false,
  expandedToolGroupIds,
  focusedToolGroupId,
  maxToolOutputLines,
  viewportHeight,
  useVirtualScroll = false,
  scrollFocused = true,
  scrollCaptureArrows = false,
  showScrollbar = true,
  onToolGroupExpandedChange,
}: MainContentProps) {
  const mutableIndex = history.findIndex((item) => !isFinal(item));
  const staticItems = mutableIndex < 0 ? history : history.slice(0, mutableIndex);
  const liveItems = mutableIndex < 0 ? pendingHistory : [...history.slice(mutableIndex), ...pendingHistory];
  const pendingIds = new Set(liveItems.map((item) => item.id));
  const allItems = [...staticItems, ...liveItems];
  const renderItem = (item: HistoryItem, isPending: boolean, renderWidth = terminalWidth) => (
    <HistoryItemDisplay
      key={item.id}
      item={item}
      terminalWidth={renderWidth}
      isPending={isPending}
      reasoningExpanded={reasoningExpanded}
      toolExpanded={expandedToolGroupIds?.has(item.id)}
      toolFocused={item.type === 'tool-group' && item.id === focusedToolGroupId}
      maxToolOutputLines={maxToolOutputLines}
      onToolExpandedChange={item.type === 'tool-group'
        ? (expanded) => onToolGroupExpandedChange?.(item.id, expanded)
        : undefined}
    />
  );

  if (useVirtualScroll && viewportHeight !== undefined && viewportHeight > 0) {
    const virtualWidth = Math.max(20, terminalWidth);
    const contentWidth = Math.max(12, virtualWidth - 7);
    const virtualItems: Array<
      | { kind: 'header'; id: string; element: ReactElement }
      | { kind: 'history'; id: string; item: HistoryItem }
    > = [
      ...(header ? [{ kind: 'header' as const, id: '__main-header__', element: header }] : []),
      ...allItems.map((item) => ({ kind: 'history' as const, id: item.id, item })),
    ];
    return (
      <ScrollableList
        items={virtualItems}
        keyExtractor={(item) => item.id}
        renderItem={(entry) => entry.kind === 'header'
          ? <Box flexDirection="column" width={Math.max(1, virtualWidth - 1)}>{entry.element}</Box>
          : renderItem(entry.item, pendingIds.has(entry.item.id), virtualWidth - 1)}
        estimatedItemHeight={(item) => {
          if (item.kind === 'header') return 8;
          const historyItem = item.item;
          if (historyItem.type === 'user') return 1 + lineEstimate(historyItem.text, contentWidth);
          if (historyItem.type === 'assistant') {
            const response = historyItem.text ? lineEstimate(historyItem.text, contentWidth) : 0;
            const reasoning = historyItem.reasoning
              ? (reasoningExpanded
                  ? 1 + lineEstimate(historyItem.reasoning, contentWidth - 2)
                  : 1)
              : 0;
            return 1 + response + reasoning;
          }
          if (historyItem.type === 'tool-group') return Math.max(1, historyItem.tools.length);
          return lineEstimate(historyItem.text, contentWidth);
        }}
        viewportHeight={viewportHeight}
        width={virtualWidth}
        hasFocus={scrollFocused}
        captureArrows={scrollCaptureArrows}
        initialFollowBottom
        showScrollbar={showScrollbar}
      />
    );
  }

  const legacyStaticItems: Array<
    | { kind: 'header'; id: string; element: ReactElement }
    | { kind: 'history'; id: string; item: HistoryItem }
  > = [
    ...(header ? [{ kind: 'header' as const, id: '__main-header__', element: header }] : []),
    ...staticItems.map((item) => ({ kind: 'history' as const, id: item.id, item })),
  ];
  return (
    <Box flexDirection="column" width={Math.max(20, terminalWidth)}>
      <Static items={legacyStaticItems}>
        {(entry) => entry.kind === 'header'
          ? <Box key={entry.id} flexDirection="column">{entry.element}</Box>
          : renderItem(entry.item, false)}
      </Static>
      <Box flexDirection="column">
        {liveItems.map((item) => renderItem(item, true))}
      </Box>
    </Box>
  );
}
