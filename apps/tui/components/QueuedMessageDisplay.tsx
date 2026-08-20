import { useRef } from 'react';
import { Box, Text } from 'ink';

import type { QueueItem } from '../types.js';
import { qwenTheme } from '../theme.js';

export interface QueuedMessageDisplayProps {
  items: readonly QueueItem[];
}

const MAX_DISPLAYED_MESSAGES = 3;
const MAX_HINT_APPEARANCES = 3;

/** Compact previews of follow-ups waiting for the next idle turn. */
export function QueuedMessageDisplay({ items }: QueuedMessageDisplayProps) {
  const hintAppearances = useRef(0);
  const wasEmpty = useRef(true);

  if (items.length === 0) {
    wasEmpty.current = true;
    return null;
  }

  if (wasEmpty.current) {
    hintAppearances.current += 1;
    wasEmpty.current = false;
  }
  const showHint = hintAppearances.current <= MAX_HINT_APPEARANCES;

  return (
    <Box flexDirection="column" marginTop={1}>
      {items.slice(0, MAX_DISPLAYED_MESSAGES).map((item) => (
        <Box key={item.id} paddingLeft={2} width="100%">
          <Text color={qwenTheme.text.secondary} wrap="truncate">
            {item.message.replace(/\s+/g, ' ')}
          </Text>
        </Box>
      ))}
      {items.length > MAX_DISPLAYED_MESSAGES && (
        <Box paddingLeft={2}>
          <Text color={qwenTheme.text.secondary}>
            ... (+{items.length - MAX_DISPLAYED_MESSAGES} more)
          </Text>
        </Box>
      )}
      {showHint && (
        <Box paddingLeft={2}>
          <Text color={qwenTheme.text.secondary} italic>
            Ctrl+Q to queue
          </Text>
        </Box>
      )}
    </Box>
  );
}

export default QueuedMessageDisplay;
