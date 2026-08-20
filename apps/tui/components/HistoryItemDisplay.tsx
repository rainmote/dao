import { Box, Text } from 'ink';
import type { HistoryItem } from '../types.js';
import { QWEN_ICON, qwenTheme } from '../theme.js';
import { MarkdownDisplay } from './MarkdownDisplay.js';
import { ToolGroup } from './ToolGroup.js';

interface HistoryItemDisplayProps {
  item: HistoryItem;
  terminalWidth: number;
  isPending?: boolean;
  reasoningExpanded?: boolean;
  toolExpanded?: boolean;
  toolFocused?: boolean;
  maxToolOutputLines?: number;
  onToolExpandedChange?: (expanded: boolean) => void;
}

export function HistoryItemDisplay({
  item,
  terminalWidth,
  isPending = false,
  reasoningExpanded = false,
  toolExpanded,
  toolFocused = false,
  maxToolOutputLines,
  onToolExpandedChange,
}: HistoryItemDisplayProps) {
  const contentWidth = Math.max(12, terminalWidth - 4);

  if (item.type === 'tool-group') {
    return (
      <ToolGroup
        item={item}
        terminalWidth={terminalWidth}
        expanded={toolExpanded}
        isFocused={toolFocused}
        maxOutputLines={maxToolOutputLines}
        onExpandedChange={onToolExpandedChange}
      />
    );
  }

  if (item.type === 'user') {
    return (
      <Box marginTop={1} marginLeft={2} marginRight={2}>
        <Text color={qwenTheme.text.accent} bold>{'> '}</Text>
        <Text color={qwenTheme.text.accent} wrap="wrap">{item.text}</Text>
      </Box>
    );
  }

  if (item.type === 'assistant') {
    const streaming = isPending || item.streaming === true;
    if (!item.text && !item.reasoning) return null;
    return (
      <Box flexDirection="column" marginTop={1} marginLeft={2} marginRight={2}>
        {item.reasoning && reasoningExpanded ? (
          <Box flexDirection="column">
            <Text dimColor italic color={qwenTheme.text.secondary}>
              {streaming
                ? `${QWEN_ICON.because} Thinking…`
                : `${QWEN_ICON.therefore} Thought (ctrl+o to collapse)`}
            </Text>
            <Box marginLeft={2} marginBottom={item.text ? 1 : 0}>
              <MarkdownDisplay
                text={item.reasoning}
                contentWidth={Math.max(8, contentWidth - 2)}
                isPending={streaming && !item.text}
                color={qwenTheme.text.secondary}
              />
            </Box>
          </Box>
        ) : item.reasoning ? (
          <Text dimColor italic color={qwenTheme.text.secondary}>
            {streaming
              ? `${QWEN_ICON.because} Thinking…`
              : `${QWEN_ICON.therefore} Thought (ctrl+o to expand)`}
          </Text>
        ) : null}
        {item.text && (
          <Box>
            <Box width={2} flexShrink={0}>
              <Text color={qwenTheme.text.accent}>{`${QWEN_ICON.diamond} `}</Text>
            </Box>
            <MarkdownDisplay
              text={item.text}
              contentWidth={Math.max(8, contentWidth - 2)}
              isPending={streaming}
            />
          </Box>
        )}
      </Box>
    );
  }

  if (item.type === 'error') {
    return (
      <Box marginLeft={2} marginRight={2}>
        <Text color={qwenTheme.status.error} bold>✕ </Text>
        <Text color={qwenTheme.status.error} wrap="wrap">{item.text}</Text>
      </Box>
    );
  }

  return (
    <Box marginLeft={2} marginRight={2}>
      <Text color={qwenTheme.ui.symbol}>{`${QWEN_ICON.circleFilled} `}</Text>
      <Text dimColor color={qwenTheme.text.secondary} wrap="wrap">{item.text}</Text>
    </Box>
  );
}
