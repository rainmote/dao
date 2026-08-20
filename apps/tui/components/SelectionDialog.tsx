import { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import { qwenTheme } from '../theme.js';

export type SelectionDialogKind = "model" | "session" | "theme" | "command";

export interface SelectionOption<T extends string = string> {
  value: T;
  label: string;
  description?: string;
  disabled?: boolean;
}

export interface SelectionDialogProps<T extends string = string> {
  kind: SelectionDialogKind;
  options: readonly SelectionOption<T>[];
  onSelect: (value: T) => void;
  onHighlight?: (value: T) => void;
  onCancel: () => void;
  title?: string;
  subtitle?: string;
  initialValue?: T;
  terminalHeight?: number;
  maxVisibleItems?: number;
  isActive?: boolean;
  emptyMessage?: string;
}

const TITLES: Record<SelectionDialogKind, string> = {
  model: "Select model",
  session: "Resume session",
  theme: "Select Theme",
  command: "Commands",
};

function firstEnabledIndex<T extends string>(
  options: readonly SelectionOption<T>[],
  initialValue?: T,
): number {
  const requested = options.findIndex(
    (option) => option.value === initialValue && !option.disabled,
  );
  if (requested >= 0) return requested;

  const firstEnabled = options.findIndex((option) => !option.disabled);
  return Math.max(0, firstEnabled);
}

function nextEnabledIndex<T extends string>(
  options: readonly SelectionOption<T>[],
  current: number,
  direction: -1 | 1,
): number {
  if (options.length === 0) return 0;

  for (let offset = 1; offset <= options.length; offset += 1) {
    const index =
      (current + direction * offset + options.length) % options.length;
    if (!options[index]?.disabled) return index;
  }
  return current;
}

function visibleWindow(
  selectedIndex: number,
  itemCount: number,
  visibleCount: number,
): { start: number; end: number } {
  const start = Math.max(
    0,
    Math.min(selectedIndex - visibleCount + 1, itemCount - visibleCount),
  );
  return { start, end: Math.min(itemCount, start + visibleCount) };
}

export function SelectionDialog<T extends string = string>({
  kind,
  options,
  onSelect,
  onHighlight,
  onCancel,
  title = TITLES[kind],
  subtitle,
  initialValue,
  terminalHeight,
  maxVisibleItems = 10,
  isActive = true,
  emptyMessage = "No items available",
}: SelectionDialogProps<T>) {
  const initialIndex = firstEnabledIndex(options, initialValue);
  const [selectedIndex, setSelectedIndex] = useState(initialIndex);
  const optionState = options
    .map(
      (option) =>
        `${option.value}:${option.disabled ? "disabled" : "enabled"}`,
    )
    .join("\u0000");

  useEffect(() => {
    setSelectedIndex(initialIndex);
  }, [initialIndex, optionState]);

  const highlightedValue = options[selectedIndex]?.disabled
    ? undefined
    : options[selectedIndex]?.value;
  useEffect(() => {
    if (highlightedValue !== undefined) onHighlight?.(highlightedValue);
  }, [highlightedValue, onHighlight]);

  useInput(
    (input, key) => {
      if (key.escape) {
        onCancel();
        return;
      }

      if (key.upArrow || input === "k") {
        setSelectedIndex((current) =>
          nextEnabledIndex(options, current, -1),
        );
        return;
      }

      if (key.downArrow || input === "j") {
        setSelectedIndex((current) =>
          nextEnabledIndex(options, current, 1),
        );
        return;
      }

      if (key.return) {
        const selected = options[selectedIndex];
        if (selected && !selected.disabled) onSelect(selected.value);
      }
    },
    { isActive },
  );

  const layout = useMemo(() => {
    const baseRows = 6 + (subtitle ? 1 : 0);
    const preferredAvailableRows = terminalHeight
      ? Math.max(1, terminalHeight - baseRows - 2)
      : maxVisibleItems;
    const footerWouldCrampWindow =
      options.length > preferredAvailableRows && preferredAvailableRows <= 4;
    const showHint = terminalHeight === undefined || !footerWouldCrampWindow;
    const fixedRows = baseRows + (showHint ? 2 : 0);
    const availableRows = terminalHeight
      ? Math.max(1, terminalHeight - fixedRows)
      : maxVisibleItems;
    const needsWindow = options.length > availableRows;
    const showArrows = needsWindow && availableRows >= 3;
    const itemRows = Math.max(
      1,
      Math.min(
        maxVisibleItems,
        options.length || 1,
        availableRows - (showArrows ? 2 : 0),
      ),
    );
    const window = visibleWindow(selectedIndex, options.length, itemRows);
    const naturalHeight = fixedRows + itemRows + (showArrows ? 2 : 0);

    return {
      ...window,
      showArrows,
      showHint,
      height: terminalHeight
        ? Math.min(terminalHeight, naturalHeight)
        : undefined,
    };
  }, [maxVisibleItems, options.length, selectedIndex, subtitle, terminalHeight]);

  const visibleOptions = options.slice(layout.start, layout.end);
  const selectedColor =
    kind === 'session' ? qwenTheme.text.accent : qwenTheme.status.success;

  return (
    <Box
      borderStyle="round"
      borderColor={qwenTheme.border.default}
      flexDirection="column"
      padding={1}
      width="100%"
      height={layout.height}
      overflow="hidden"
    >
      <Text bold color={qwenTheme.text.primary} wrap="truncate">
        {title}
      </Text>
      {subtitle && (
        <Text color={qwenTheme.text.secondary} wrap="truncate">
          {subtitle}
        </Text>
      )}

      <Box flexDirection="column" marginTop={1} flexGrow={1}>
        {options.length === 0 ? (
          <Text color={qwenTheme.text.secondary}>{emptyMessage}</Text>
        ) : (
          <>
            {layout.showArrows && (
              <Text
                color={
                  layout.start > 0
                    ? qwenTheme.text.primary
                    : qwenTheme.text.secondary
                }
              >
                ▲
              </Text>
            )}
            {visibleOptions.map((option, offset) => {
              const index = layout.start + offset;
              const selected = index === selectedIndex;
              const number = `${String(index + 1).padStart(
                String(options.length).length,
              )}.`;

              return (
                <Box
                  key={`${option.value}:${index}`}
                  minWidth={0}
                  alignItems="flex-start"
                >
                  <Box minWidth={2} flexShrink={0}>
                    <Text
                      color={
                        selected ? selectedColor : qwenTheme.text.primary
                      }
                    >
                      {selected ? '›' : ' '}
                    </Text>
                  </Box>
                  <Box minWidth={number.length} marginRight={1} flexShrink={0}>
                    <Text
                      color={
                        option.disabled
                          ? qwenTheme.text.secondary
                          : selected
                            ? selectedColor
                            : qwenTheme.text.primary
                      }
                    >
                      {number}
                    </Text>
                  </Box>
                  <Box minWidth={0} flexGrow={1}>
                    <Text
                      color={
                        option.disabled
                          ? qwenTheme.text.secondary
                          : selected
                            ? selectedColor
                            : qwenTheme.text.primary
                      }
                      bold={kind === 'session' && selected && !option.disabled}
                      wrap="truncate"
                    >
                      {option.label}
                      {option.description && (
                        <Text color={qwenTheme.text.secondary}>
                          {' '}
                          {option.description}
                        </Text>
                      )}
                    </Text>
                  </Box>
                </Box>
              );
            })}
            {layout.showArrows && (
              <Text
                color={
                  layout.end < options.length
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

      {layout.showHint && (
        <Box marginTop={1}>
          <Text color={qwenTheme.text.secondary} wrap="truncate">
            Enter to select, ↑↓ to navigate, Esc to close
          </Text>
        </Box>
      )}
    </Box>
  );
}
