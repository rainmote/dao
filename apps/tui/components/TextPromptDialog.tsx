import { useEffect, useRef, useState } from "react";
import { Box, Text, useInput } from "ink";
import {
  createTextBuffer,
  deleteBackward,
  deleteForward,
  graphemes,
  insertText,
  moveCursor,
  type TextBufferState,
} from "../text-buffer.js";
import { qwenTheme } from '../theme.js';

export interface TextPromptDialogProps {
  title: string;
  subtitle?: string;
  placeholder?: string;
  defaultValue?: string;
  customJson?: boolean;
  required?: boolean;
  resolving?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  terminalHeight?: number;
  terminalWidth?: number;
  isActive?: boolean;
}

function singleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

function InputValue({
  buffer,
  placeholder,
  focused,
  width,
}: {
  buffer: TextBufferState;
  placeholder: string;
  focused: boolean;
  width: number;
}) {
  if (!buffer.text) {
    const [first = " ", ...rest] = graphemes(placeholder).slice(0, width);
    return (
      <Text>
        {focused ? (
          <Text inverse>{first}</Text>
        ) : (
          <Text color={qwenTheme.text.secondary}>{first}</Text>
        )}
        <Text color={qwenTheme.text.secondary}>{rest.join("")}</Text>
      </Text>
    );
  }

  const before = graphemes(buffer.text.slice(0, buffer.cursor));
  const remaining = graphemes(buffer.text.slice(buffer.cursor));
  const cursorCell = remaining.shift() ?? " ";
  const beforeBudget = Math.max(0, width - 1);
  const visibleBefore = before.slice(-beforeBudget);
  const afterBudget = Math.max(0, width - visibleBefore.length - 1);
  const visibleAfter = remaining.slice(0, afterBudget);

  if (visibleBefore.length > 0 && visibleBefore.length < before.length) {
    visibleBefore[0] = "…";
  }
  if (visibleAfter.length > 0 && visibleAfter.length < remaining.length) {
    visibleAfter[visibleAfter.length - 1] = "…";
  }

  return (
    <Text>
      {visibleBefore.join("")}
      {focused ? <Text inverse>{cursorCell}</Text> : cursorCell}
      {visibleAfter.join("")}
    </Text>
  );
}

export function TextPromptDialog({
  title,
  subtitle,
  placeholder = "Enter a value",
  defaultValue = "",
  customJson = false,
  required = false,
  resolving = false,
  onSubmit,
  onCancel,
  terminalHeight,
  terminalWidth = process.stdout.columns || 80,
  isActive = true,
}: TextPromptDialogProps) {
  const normalizedDefault = singleLine(defaultValue);
  const [buffer, setBuffer] = useState(() =>
    createTextBuffer(normalizedDefault),
  );
  const bufferRef = useRef(buffer);
  const [requiredError, setRequiredError] = useState(false);

  useEffect(() => {
    const next = createTextBuffer(normalizedDefault);
    bufferRef.current = next;
    setBuffer(next);
    setRequiredError(false);
  }, [normalizedDefault]);

  const commit = (next: TextBufferState) => {
    bufferRef.current = next;
    setBuffer(next);
    if (next.text.trim()) setRequiredError(false);
  };

  useInput(
    (input, key) => {
      if (key.eventType === "release" || resolving) return;
      const current = bufferRef.current;
      if (key.escape) {
        onCancel();
        return;
      }
      if (key.return) {
        if (required && !current.text.trim()) {
          setRequiredError(true);
          return;
        }
        onSubmit(current.text);
        return;
      }
      if (key.leftArrow) {
        commit(moveCursor(current, "left"));
        return;
      }
      if (key.rightArrow) {
        commit(moveCursor(current, "right"));
        return;
      }
      if (key.home || (key.ctrl && input.toLocaleLowerCase() === "a")) {
        commit(moveCursor(current, "home"));
        return;
      }
      if (key.end || (key.ctrl && input.toLocaleLowerCase() === "e")) {
        commit(moveCursor(current, "end"));
        return;
      }
      if (key.backspace || input === "\u007f") {
        commit(deleteBackward(current));
        return;
      }
      if (key.delete) {
        commit(deleteForward(current));
        return;
      }
      if (key.ctrl || key.meta || input.length === 0) return;

      commit(insertText(current, singleLine(input)));
    },
    { isActive: isActive && !resolving },
  );

  const compact = terminalHeight !== undefined && terminalHeight < 14;
  const status = requiredError
    ? "Value is required."
    : resolving
      ? "Submitting…"
      : customJson
        ? "JSON input · validation happens after submit"
        : required
          ? "Required"
          : undefined;
  const showFooter =
    terminalHeight === undefined || terminalHeight >= 8 || status === undefined;
  const showSubtitle =
    subtitle !== undefined &&
    (terminalHeight === undefined || terminalHeight >= (status ? 9 : 8));
  const inputWidth = Math.max(4, Math.min(terminalWidth - 10, 60));
  const focused = isActive && !resolving;

  return (
    <Box
      borderStyle="round"
      borderColor={
        requiredError ? qwenTheme.status.error : qwenTheme.border.default
      }
      flexDirection="column"
      paddingX={2}
      paddingY={compact ? 0 : 1}
      width="100%"
      overflow="hidden"
    >
      <Text bold color={qwenTheme.text.accent} wrap="truncate">
        {title}
      </Text>
      {showSubtitle && (
        <Box marginTop={compact ? 0 : 1}>
          <Text color={qwenTheme.text.primary} wrap="truncate">
            {subtitle}
          </Text>
        </Box>
      )}

      <Box
        marginTop={compact ? 0 : 1}
        minWidth={0}
      >
        <Text
          color={
            requiredError ? qwenTheme.status.error : qwenTheme.text.accent
          }
        >
          {'> '}
        </Text>
        <Box minWidth={0} flexGrow={1}>
          <InputValue
            buffer={buffer}
            placeholder={placeholder}
            focused={focused}
            width={inputWidth}
          />
        </Box>
      </Box>

      {status && (
        <Text
          color={
            requiredError
              ? qwenTheme.status.error
              : resolving
                ? qwenTheme.status.warning
                : qwenTheme.text.secondary
          }
          wrap="truncate"
        >
          {status}
        </Text>
      )}
      {showFooter && (
        <Box marginTop={compact ? 0 : 1}>
          <Text color={qwenTheme.text.secondary} wrap="truncate">
            {resolving
              ? 'Please wait…'
              : 'Press Enter to submit, Escape to cancel'}
          </Text>
        </Box>
      )}
    </Box>
  );
}
