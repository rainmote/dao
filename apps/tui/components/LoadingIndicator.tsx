import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';

import { qwenTheme } from '../theme.js';

export interface LoadingIndicatorProps {
  busy: boolean;
  phase?: string;
  label?: string;
  elapsedSeconds?: number;
  terminalWidth?: number;
}

const PHASE_LABELS: Record<string, string> = {
  model: 'Thinking…',
  tool: 'Working…',
  retry: 'Retrying…',
  compacting: 'Compacting…',
};

function formatElapsed(seconds: number): string {
  const safeSeconds = Math.max(0, Math.floor(seconds));
  if (safeSeconds < 60) return `${safeSeconds}s`;
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = safeSeconds % 60;
  return remainder === 0 ? `${minutes}m` : `${minutes}m ${remainder}s`;
}

/** Qwen-style status row for an active model/tool phase. */
export function LoadingIndicator({
  busy,
  phase = 'model',
  label,
  elapsedSeconds,
  terminalWidth = 80,
}: LoadingIndicatorProps) {
  const [localElapsed, setLocalElapsed] = useState(0);

  useEffect(() => {
    if (!busy || elapsedSeconds !== undefined) return undefined;
    setLocalElapsed(0);
    const timer = setInterval(() => {
      setLocalElapsed((current) => current + 1);
    }, 1000);
    return () => clearInterval(timer);
  }, [busy, elapsedSeconds, phase]);

  if (!busy) return null;

  if (terminalWidth <= 30) {
    return (
      <Box paddingLeft={2}>
        <Text color={qwenTheme.text.secondary}>(Esc to cancel)</Text>
      </Box>
    );
  }

  const status = label ?? PHASE_LABELS[phase] ?? 'Working…';
  const elapsed = elapsedSeconds ?? localElapsed;
  return (
    <Box paddingLeft={2}>
      <Text color={qwenTheme.text.accent}>⠋ {status}</Text>
      <Text color={qwenTheme.text.secondary}>
        {' '}({formatElapsed(elapsed)} · esc to cancel)
      </Text>
    </Box>
  );
}

export default LoadingIndicator;
