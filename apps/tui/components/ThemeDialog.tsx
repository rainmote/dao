import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Box, Text, useInput } from 'ink';

import {
  getActiveTheme,
  getTheme,
  qwenTheme,
  type SemanticTheme,
} from '../theme.js';
import type {
  SelectionDialogProps,
  SelectionOption,
} from './SelectionDialog.js';

export interface ThemeDialogProps<T extends string = string>
  extends Omit<SelectionDialogProps<T>, 'kind'> {
  terminalWidth?: number;
}

function firstEnabledIndex<T extends string>(
  options: readonly SelectionOption<T>[],
  initialValue?: T,
): number {
  const requested = options.findIndex(
    (option) => option.value === initialValue && !option.disabled,
  );
  if (requested >= 0) return requested;
  return Math.max(0, options.findIndex((option) => !option.disabled));
}

function nextEnabledIndex<T extends string>(
  options: readonly SelectionOption<T>[],
  current: number,
  direction: -1 | 1,
): number {
  if (options.length === 0) return 0;
  for (let offset = 1; offset <= options.length; offset += 1) {
    const index = (current + direction * offset + options.length) % options.length;
    if (!options[index]?.disabled) return index;
  }
  return current;
}

function visibleStart(
  selectedIndex: number,
  itemCount: number,
  visibleCount: number,
): number {
  return Math.max(
    0,
    Math.min(selectedIndex - visibleCount + 1, itemCount - visibleCount),
  );
}

interface PreviewLineProps {
  background: string;
  width: number;
  visibleLength: number;
  children: ReactNode;
}

function PreviewLine({
  background,
  width,
  visibleLength,
  children,
}: PreviewLineProps) {
  return (
    <Text backgroundColor={background} wrap="truncate">
      {children}
      {' '.repeat(Math.max(0, width - visibleLength))}
    </Text>
  );
}

function Preview({
  theme,
  width,
  availableRows,
  includePadding,
}: {
  theme: SemanticTheme;
  width: number;
  availableRows: number;
  includePadding: boolean;
}) {
  const { colors } = theme;
  const foreground = colors.foreground || undefined;
  const codeWidth = Math.max(18, width);
  const codeLineCount = availableRows >= 9 ? 6 : availableRows >= 7 ? 4 : 2;
  const showDiffHeaders = availableRows >= 11;

  return (
    <Box
      borderStyle="single"
      borderColor={qwenTheme.border.default}
      flexDirection="column"
      paddingX={1}
      paddingY={includePadding ? 1 : 0}
      overflow="hidden"
    >
      <PreviewLine background={colors.background} width={codeWidth} visibleLength={10}>
        <Text color={colors.comment}># function</Text>
      </PreviewLine>
      <PreviewLine background={colors.background} width={codeWidth} visibleLength={17}>
        <Text color={colors.accentPurple}>def </Text>
        <Text color={colors.accentBlue}>fibonacci</Text>
        <Text color={foreground}>(n):</Text>
      </PreviewLine>
      {codeLineCount >= 4 && (
        <>
          <PreviewLine background={colors.background} width={codeWidth} visibleLength={15}>
            <Text color={foreground}>    a, b = </Text>
            <Text color={colors.accentCyan}>0, 1</Text>
          </PreviewLine>
          <PreviewLine background={colors.background} width={codeWidth} visibleLength={22}>
            <Text color={colors.accentPurple}>    for </Text>
            <Text color={foreground}>_ </Text>
            <Text color={colors.accentPurple}>in </Text>
            <Text color={colors.accentBlue}>range</Text>
            <Text color={foreground}>(n):</Text>
          </PreviewLine>
        </>
      )}
      {codeLineCount >= 6 && (
        <>
          <PreviewLine background={colors.background} width={codeWidth} visibleLength={23}>
            <Text color={foreground}>        a, b = b, a + b</Text>
          </PreviewLine>
          <PreviewLine background={colors.background} width={codeWidth} visibleLength={12}>
            <Text color={colors.accentPurple}>    return </Text>
            <Text color={foreground}>a</Text>
          </PreviewLine>
        </>
      )}

      <Box marginTop={1} flexDirection="column">
        {showDiffHeaders && (
          <>
            <PreviewLine background={colors.background} width={codeWidth} visibleLength={11}>
              <Text color={colors.lightBlue}>--- a/util.py</Text>
            </PreviewLine>
            <PreviewLine background={colors.background} width={codeWidth} visibleLength={11}>
              <Text color={colors.lightBlue}>+++ b/util.py</Text>
            </PreviewLine>
          </>
        )}
        <PreviewLine background={theme.background.diff.removed} width={codeWidth} visibleLength={24}>
          <Text color={theme.status.error}>- print("Hello, " + name)</Text>
        </PreviewLine>
        <PreviewLine background={theme.background.diff.added} width={codeWidth} visibleLength={26}>
          <Text color={theme.status.success}>{'+ print(f"Hello, {name}!")'}</Text>
        </PreviewLine>
      </Box>
    </Box>
  );
}

export function ThemeDialog<T extends string = string>({
  options,
  onSelect,
  onHighlight,
  onCancel,
  initialValue,
  terminalHeight,
  terminalWidth = process.stdout.columns || 80,
  maxVisibleItems = 12,
  isActive = true,
  emptyMessage = 'No themes available',
}: ThemeDialogProps<T>) {
  const initialIndex = firstEnabledIndex(options, initialValue);
  const [selectedIndex, setSelectedIndex] = useState(initialIndex);
  const optionState = options
    .map((option) => `${option.value}:${option.disabled ? 'disabled' : 'enabled'}`)
    .join('\u0000');

  useEffect(() => {
    setSelectedIndex(initialIndex);
  }, [initialIndex, optionState]);

  const highlighted = options[selectedIndex]?.disabled
    ? undefined
    : options[selectedIndex];

  useEffect(() => {
    if (highlighted) onHighlight?.(highlighted.value);
  }, [highlighted, onHighlight]);

  useInput(
    (input, key) => {
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.upArrow || input === 'k') {
        setSelectedIndex((current) => nextEnabledIndex(options, current, -1));
        return;
      }
      if (key.downArrow || input === 'j') {
        setSelectedIndex((current) => nextEnabledIndex(options, current, 1));
        return;
      }
      if (key.return) {
        const selected = options[selectedIndex];
        if (selected && !selected.disabled) onSelect(selected.value);
      }
    },
    { isActive },
  );

  const wide = terminalWidth >= 76;
  const includePadding = terminalHeight === undefined || terminalHeight >= 20;
  const visibleCount = Math.max(
    1,
    Math.min(
      maxVisibleItems,
      options.length || 1,
      terminalHeight === undefined
        ? maxVisibleItems
        : Math.max(3, terminalHeight - (includePadding ? 9 : 5)),
    ),
  );
  const start = visibleStart(selectedIndex, options.length, visibleCount);
  const visibleOptions = options.slice(start, start + visibleCount);
  const showArrows = options.length > visibleCount;
  const selectedTheme = getTheme(highlighted?.value) ?? getActiveTheme();
  const dialogWidth = Math.max(1, Math.min(terminalWidth - 4, 100));
  const previewContentWidth = Math.max(
    18,
    Math.floor((dialogWidth - 4) * 0.55) - 6,
  );
  const numberWidth = String(options.length).length;
  const height = terminalHeight;
  const previewRows = terminalHeight === undefined
    ? 11
    : Math.max(5, terminalHeight - (includePadding ? 11 : 7));

  const list = useMemo(() => (
    <Box flexDirection="column" flexGrow={1} overflow="hidden">
      {options.length === 0 ? (
        <Text color={qwenTheme.text.secondary}>{emptyMessage}</Text>
      ) : (
        <>
          {showArrows && (
            <Text color={start > 0 ? qwenTheme.text.primary : qwenTheme.text.secondary}>
              ▲
            </Text>
          )}
          {visibleOptions.map((option, offset) => {
            const index = start + offset;
            const selected = index === selectedIndex;
            const color = option.disabled
              ? qwenTheme.text.secondary
              : selected
                ? qwenTheme.status.success
                : qwenTheme.text.primary;
            const number = `${String(index + 1).padStart(numberWidth)}.`;
            return (
              <Box key={`${option.value}:${index}`} minWidth={0}>
                <Box minWidth={2} flexShrink={0}>
                  <Text color={selected ? qwenTheme.status.success : qwenTheme.text.primary}>
                    {selected ? '›' : ' '}
                  </Text>
                </Box>
                <Box minWidth={number.length} marginRight={1} flexShrink={0}>
                  <Text color={color}>{number}</Text>
                </Box>
                <Text color={color} wrap="truncate">
                  {option.value === 'auto' ? 'Auto' : option.label}{' '}
                  <Text color={qwenTheme.text.secondary}>
                    {option.description || ''}
                  </Text>
                </Text>
              </Box>
            );
          })}
          {showArrows && (
            <Text
              color={
                start + visibleCount < options.length
                  ? qwenTheme.text.primary
                  : qwenTheme.text.secondary
              }
            >
              ▼
            </Text>
          )}
        </>
      )}
    </Box>
  ), [
    emptyMessage,
    numberWidth,
    options.length,
    selectedIndex,
    showArrows,
    start,
    visibleCount,
    visibleOptions,
  ]);

  return (
    <Box
      borderStyle="round"
      borderColor={qwenTheme.border.default}
      flexDirection="column"
      paddingTop={includePadding ? 1 : 0}
      paddingBottom={includePadding ? 1 : 0}
      paddingX={1}
      width="100%"
      height={height}
      overflow="hidden"
    >
      {wide ? (
        <Box flexDirection="row" flexGrow={1} overflow="hidden">
          <Box flexDirection="column" width="45%" paddingRight={2}>
            <Text bold wrap="truncate">
              <Text color={qwenTheme.text.primary}>{'> Select Theme'}</Text>
            </Text>
            {list}
          </Box>
          <Box flexDirection="column" width="55%" paddingLeft={2}>
            <Text bold color={qwenTheme.text.primary}>Preview</Text>
            <Preview
              theme={selectedTheme}
              width={previewContentWidth}
              availableRows={previewRows}
              includePadding={includePadding && previewRows >= 11}
            />
          </Box>
        </Box>
      ) : (
        <Box flexDirection="column" flexGrow={1} overflow="hidden">
          <Text bold color={qwenTheme.text.primary} wrap="truncate">
            {'> Select Theme'}
          </Text>
          {list}
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={qwenTheme.text.secondary} wrap="truncate">
          (Use Enter to select, Esc to close)
        </Text>
      </Box>
    </Box>
  );
}

export default ThemeDialog;
