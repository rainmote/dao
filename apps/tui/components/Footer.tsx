import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { qwenTheme } from '../theme.js';

export interface ContextUsage {
  used: number;
  limit: number;
}

export interface FooterProps {
  /** Retained for source compatibility; runtime identity belongs in Header. */
  cwd?: string;
  /** Retained for source compatibility; runtime identity belongs in Header. */
  model?: string;
  phase?: string;
  context?: ContextUsage | string;
  hint?: string;
  queueCount?: number;
  queue?: number | string;
  busy?: boolean;
  warning?: string;
  terminalWidth?: number;
}

function contextLabel(
  context: ContextUsage | string,
  terminalWidth: number,
): { label: string; overLimit: boolean } {
  if (typeof context === 'string') {
    return { label: context, overLimit: false };
  }

  const limit = Math.max(0, context.limit);
  const used = Math.max(0, context.used);
  const percentage = limit > 0 ? used / limit : 0;
  const percentageLabel = percentage > 1 ? '>100' : (percentage * 100).toFixed(1);
  const suffix = terminalWidth < 100 ? '% used' : '% context used';
  return { label: `${percentageLabel}${suffix}`, overLimit: percentage > 1 };
}

function phaseColor(phase: string, busy: boolean): string {
  if (phase === 'error') return qwenTheme.status.error;
  if (
    phase === 'retry' ||
    phase === 'compacting' ||
    phase === 'loading' ||
    phase === 'exiting'
  ) {
    return qwenTheme.status.warning;
  }
  if (busy) return qwenTheme.text.link;
  if (phase === 'idle') return qwenTheme.status.success;
  return qwenTheme.text.secondary;
}

function inferredBusy(phase: string | undefined): boolean {
  return Boolean(
    phase && !['idle', 'error', 'loading', 'exiting'].includes(phase),
  );
}

function queueLabel(queue: number | string | undefined): string | undefined {
  if (typeof queue === 'number') return queue > 0 ? `${queue} queued` : undefined;
  return queue?.trim() || undefined;
}

export function Footer({
  phase,
  context,
  hint = "? for shortcuts",
  queueCount = 0,
  queue,
  busy,
  warning,
  terminalWidth = process.stdout.columns || 80,
}: FooterProps) {
  const narrow = terminalWidth < 80;
  const isBusy = busy ?? inferredBusy(phase);
  const queued = queueLabel(queue ?? queueCount);
  const leftText = warning
    ? warning
    : isBusy
      ? 'Enter steer · Alt+Enter follow-up · Ctrl+C/Esc abort'
      : hint;
  const contextInfo = context === undefined
    ? undefined
    : contextLabel(context, terminalWidth);
  const rightItems: Array<{ key: string; node: ReactNode }> = [];

  if (phase) {
    rightItems.push({
      key: 'phase',
      node: <Text color={phaseColor(phase, isBusy)}>{phase}</Text>,
    });
  }
  if (contextInfo) {
    rightItems.push({
      key: 'context',
      node: (
        <Text
          color={
            contextInfo.overLimit
              ? qwenTheme.status.error
              : qwenTheme.text.secondary
          }
        >
          {contextInfo.label}
        </Text>
      ),
    });
  }

  return (
    <Box
      flexDirection={narrow ? 'column' : 'row'}
      justifyContent={narrow ? 'flex-start' : 'space-between'}
      width="100%"
      paddingX={2}
      gap={narrow ? 0 : 1}
    >
      <Box minWidth={0} flexGrow={1} flexShrink={narrow ? 0 : 1}>
        {leftText && (
          <Text
            color={
              warning ? qwenTheme.status.warning : qwenTheme.text.secondary
            }
            wrap="truncate"
          >
            {leftText}
          </Text>
        )}
        {queued && (
          <Text color={qwenTheme.text.secondary} wrap="truncate">
            {` ⏳ ${queued}`}
          </Text>
        )}
      </Box>

      <Box flexShrink={0} gap={1} alignItems="flex-start">
        {rightItems.map(({ key, node }, index) => (
          <Box key={key} alignItems="center">
            {index > 0 && (
              <Text color={qwenTheme.text.secondary}> | </Text>
            )}
            {node}
          </Box>
        ))}
      </Box>
    </Box>
  );
}
