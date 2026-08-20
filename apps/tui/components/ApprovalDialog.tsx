import { useEffect, useMemo, useState } from "react";
import { Box, Text, useInput } from "ink";
import type { Interaction } from "../types";
import { qwenTheme } from '../theme.js';

export type ApprovalDecision = "allow" | "allow-session" | "deny";

export interface ApprovalDialogProps {
  interaction: Interaction;
  onResolve: (decision: ApprovalDecision) => void;
  resolving?: boolean;
  terminalHeight?: number;
  isActive?: boolean;
}

interface ApprovalOption {
  value: ApprovalDecision;
  label: string;
  description: string;
}

const DEFAULT_OPTIONS: readonly ApprovalOption[] = [
  {
    value: "allow",
    label: "Yes, allow once",
    description: "Run this tool call",
  },
  {
    value: "allow-session",
    label: "Allow for this session",
    description: "Remember for this session",
  },
  {
    value: "deny",
    label: "No, deny",
    description: "Cancel this tool call",
  },
];

function isApprovalDecision(value: string): value is ApprovalDecision {
  return value === "allow" || value === "allow-session" || value === "deny";
}

function nextIndex(current: number, direction: -1 | 1, count: number): number {
  if (count === 0) return 0;
  return (current + direction + count) % count;
}

export function ApprovalDialog({
  interaction,
  onResolve,
  resolving = false,
  terminalHeight,
  isActive = true,
}: ApprovalDialogProps) {
  const options = useMemo(() => {
    const suppliedLabels = new Map(
      interaction.items
        .filter((item) => isApprovalDecision(item.value))
        .map((item) => [item.value as ApprovalDecision, item.label]),
    );

    return DEFAULT_OPTIONS.map((option) => ({
      ...option,
      label: suppliedLabels.get(option.value) || option.label,
    }));
  }, [interaction.items]);

  const initialIndex = Math.max(
    0,
    options.findIndex((option) => option.value === interaction.default),
  );
  const [selectedIndex, setSelectedIndex] = useState(initialIndex);

  useEffect(() => {
    setSelectedIndex(initialIndex);
  }, [initialIndex, interaction.id]);

  useInput(
    (input, key) => {
      if (resolving) return;

      if (key.escape) {
        onResolve("deny");
        return;
      }
      if (key.upArrow || input === "k") {
        setSelectedIndex((current) => nextIndex(current, -1, options.length));
        return;
      }
      if (key.downArrow || input === "j") {
        setSelectedIndex((current) => nextIndex(current, 1, options.length));
        return;
      }
      if (key.return) {
        const selected = options[selectedIndex];
        if (selected) onResolve(selected.value);
      }
    },
    { isActive: isActive && !resolving },
  );

  const messageLines = interaction.message
    ? interaction.message.split("\n")
    : [];
  const showDetails = terminalHeight === undefined || terminalHeight >= 14;
  const showQuestion = terminalHeight === undefined || terminalHeight >= 13;
  const fixedRows = 7 + (showDetails ? 1 : 0) + (showQuestion ? 1 : 0);
  const messageBudget = terminalHeight
    ? Math.max(0, terminalHeight - fixedRows)
    : 10;
  const unconstrainedPreviewRows = Math.min(8, messageLines.length);
  const needsHiddenNotice = messageLines.length > Math.max(0, messageBudget - 2);
  const previewRows =
    terminalHeight === undefined
      ? unconstrainedPreviewRows
      : messageBudget >= (needsHiddenNotice ? 4 : 3)
        ? Math.max(
            1,
            Math.min(
              messageLines.length,
              messageBudget - 2 - (needsHiddenNotice ? 1 : 0),
            ),
          )
        : 0;
  const visibleMessage = messageLines.slice(0, previewRows);
  const hiddenLines = Math.max(0, messageLines.length - visibleMessage.length);
  const showHiddenNotice = hiddenLines > 0 && messageBudget >= 1;
  const naturalHeight =
    fixedRows +
    (visibleMessage.length > 0 ? visibleMessage.length + 2 : 0) +
    (showHiddenNotice ? 1 : 0);

  return (
    <Box
      borderStyle="round"
      borderColor={qwenTheme.status.warning}
      flexDirection="column"
      paddingX={1}
      paddingY={terminalHeight === undefined ? 1 : 0}
      width="100%"
      marginLeft={1}
      height={
        terminalHeight ? Math.min(terminalHeight, naturalHeight) : undefined
      }
      overflow="hidden"
    >
      <Text bold color={qwenTheme.text.primary} wrap="truncate">
        {interaction.title || 'Approve tool execution?'}
      </Text>
      {showDetails && (
        <Text color={qwenTheme.text.primary} wrap="truncate">
          The agent needs your confirmation to continue.
        </Text>
      )}

      {visibleMessage.length > 0 && (
        <Box
          flexDirection="column"
          marginTop={terminalHeight === undefined ? 1 : 0}
          marginBottom={terminalHeight === undefined ? 1 : 0}
          flexShrink={1}
        >
          <Box
            borderStyle="round"
            borderColor={qwenTheme.border.default}
            flexDirection="column"
            paddingX={1}
            overflow="hidden"
          >
            {visibleMessage.map((line, index) => (
              <Text
                key={`${index}:${line}`}
                color={qwenTheme.text.link}
                wrap="truncate"
              >
                {line || ' '}
              </Text>
            ))}
          </Box>
        </Box>
      )}
      {showHiddenNotice && (
        <Text color={qwenTheme.status.warning} wrap="truncate">
          {`… ${hiddenLines} line${hiddenLines === 1 ? '' : 's'} hidden - resize terminal to review`}
        </Text>
      )}

      {showQuestion && (
        <Text color={qwenTheme.text.primary}>Do you want to proceed?</Text>
      )}
      <Box flexDirection="column" flexShrink={0}>
        {options.map((option, index) => {
          const selected = selectedIndex === index;
          const number = `${index + 1}.`;
          return (
            <Box key={option.value} alignItems="flex-start">
              <Box minWidth={2} flexShrink={0}>
                <Text
                  color={
                    selected
                      ? qwenTheme.status.success
                      : qwenTheme.text.primary
                  }
                >
                  {selected ? '›' : ' '}
                </Text>
              </Box>
              <Box minWidth={2} marginRight={1} flexShrink={0}>
                <Text
                  color={
                    selected
                      ? qwenTheme.status.success
                      : qwenTheme.text.primary
                  }
                >
                  {number}
                </Text>
              </Box>
              <Text
                color={
                  selected
                    ? qwenTheme.status.success
                    : qwenTheme.text.primary
                }
                wrap="truncate"
              >
                {option.label}
                {showDetails && (
                  <Text color={qwenTheme.text.secondary}>
                    {' '}
                    {option.description}
                  </Text>
                )}
              </Text>
            </Box>
          );
        })}
      </Box>

      <Box>
        <Text color={qwenTheme.text.secondary} wrap="truncate">
          {resolving
            ? 'Resolving approval…'
            : 'Enter to confirm, ↑↓ to navigate, Esc to deny'}
        </Text>
      </Box>
    </Box>
  );
}
