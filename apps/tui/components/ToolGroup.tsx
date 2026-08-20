import { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { qwenTheme } from '../theme.js';
import type { HistoryItemToolGroup, ToolCall, ToolCallStatus } from '../types.js';

interface ToolGroupProps {
  item: HistoryItemToolGroup;
  terminalWidth: number;
  expanded?: boolean;
  defaultExpanded?: boolean;
  isFocused?: boolean;
  maxOutputLines?: number;
  onExpandedChange?: (expanded: boolean) => void;
}

type ToolCategory = 'search' | 'read' | 'list' | 'shell' | 'other';

const STATUS: Record<ToolCallStatus, { icon: string; label: string }> = {
  pending: { icon: 'o', label: 'pending' },
  running: { icon: '⊷', label: 'running' },
  success: { icon: '✓', label: 'done' },
  error: { icon: 'x', label: 'failed' },
};

function statusColor(status: ToolCallStatus): string {
  if (status === 'running') return qwenTheme.status.warning;
  if (status === 'error') return qwenTheme.status.error;
  return qwenTheme.status.success;
}

const CATEGORY_ORDER: readonly ToolCategory[] = ['search', 'read', 'list', 'shell', 'other'];

function sanitize(text: string): string {
  return text
    .replace(/\u001b(?:(?:\[[0-?]*[ -/]*[@-~])|(?:\][^\u0007]*(?:\u0007|\u001b\\)))/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '');
}

function valueText(value: unknown): string {
  if (typeof value === 'string') return sanitize(value);
  if (value === undefined) return '';
  try {
    return sanitize(JSON.stringify(value, null, 2));
  } catch {
    return sanitize(String(value));
  }
}

function compactText(value: unknown, maxLength: number): string {
  const text = valueText(value).replace(/\s+/g, ' ').trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 1))}…`;
}

function categoryFor(tool: ToolCall): ToolCategory {
  const name = tool.name.toLowerCase();
  if (/(search|grep|ripgrep|find_text|query)/.test(name)) return 'search';
  if (/(read|view|get_file|open_file)/.test(name)) return 'read';
  if (/(list|glob|directory|read_dir|ls_files)/.test(name)) return 'list';
  if (/(shell|bash|exec|command|terminal)/.test(name)) return 'shell';
  return 'other';
}

function aggregateStatus(tools: readonly ToolCall[]): ToolCallStatus {
  if (tools.some((tool) => tool.status === 'error')) return 'error';
  if (tools.some((tool) => tool.status === 'running')) return 'running';
  if (tools.some((tool) => tool.status === 'pending')) return 'pending';
  return 'success';
}

function descriptionFor(tool: ToolCall): string {
  if (typeof tool.arguments === 'string') return compactText(tool.arguments, 80);
  if (!tool.arguments || typeof tool.arguments !== 'object') return '';
  const args = tool.arguments as Record<string, unknown>;
  const category = categoryFor(tool);
  const keys = category === 'search'
    ? ['pattern', 'query', 'search', 'path']
    : category === 'shell'
      ? ['command', 'cmd', 'script']
      : ['path', 'file_path', 'file', 'directory', 'dir', 'glob'];
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return compactText(value, 80);
  }
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value.trim()) return compactText(value, 80);
  }
  return '';
}

function categorySummary(category: ToolCategory, tools: readonly ToolCall[]): string {
  const active = tools.some((tool) => tool.status === 'pending' || tool.status === 'running');
  const verb = {
    search: active ? 'Searching' : 'Searched',
    read: active ? 'Reading' : 'Read',
    list: active ? 'Listing' : 'Listed',
    shell: active ? 'Running' : 'Ran',
    other: active ? 'Using' : 'Used',
  }[category];
  const descriptions = tools.map(descriptionFor).filter(Boolean);
  let target: string;
  if (descriptions.length === 0) {
    const noun = category === 'search' ? 'queries' : category === 'read' ? 'files' : 'paths';
    target = `${tools.length} ${noun}`;
  } else if (descriptions.length <= 3) {
    target = descriptions.join(', ');
  } else {
    target = `${descriptions.slice(0, 2).join(', ')} and ${descriptions.length - 2} more`;
  }
  return `${verb} ${target}${active ? '…' : ''}`;
}

function toolOutput(tool: ToolCall): string {
  if (tool.result?.error) return valueText(tool.result.error);
  if (tool.result?.content) return valueText(tool.result.content);
  if (tool.result?.details !== undefined) return valueText(tool.result.details);
  if (tool.updates.length > 0) return valueText(tool.updates.at(-1));
  return '';
}

function isWide(codePoint: number): boolean {
  return codePoint >= 0x1100 && (
    codePoint <= 0x115f
    || codePoint === 0x2329
    || codePoint === 0x232a
    || (codePoint >= 0x2e80 && codePoint <= 0xa4cf)
    || (codePoint >= 0xac00 && codePoint <= 0xd7a3)
    || (codePoint >= 0xf900 && codePoint <= 0xfaff)
    || (codePoint >= 0xfe10 && codePoint <= 0xfe6f)
    || (codePoint >= 0xff00 && codePoint <= 0xff60)
    || (codePoint >= 0x1f300 && codePoint <= 0x1faff)
    || (codePoint >= 0x20000 && codePoint <= 0x3fffd)
  );
}

function charWidth(character: string): number {
  const codePoint = character.codePointAt(0) ?? 0;
  if (codePoint === 0xfe0e || codePoint === 0xfe0f) return 0;
  if ((codePoint >= 0x300 && codePoint <= 0x36f) || (codePoint >= 0x1ab0 && codePoint <= 0x1aff)) return 0;
  return isWide(codePoint) ? 2 : 1;
}

function wrapVisual(text: string, lineWidth: number): string[] {
  const width = Math.max(1, lineWidth);
  return sanitize(text).replace(/\r\n?/g, '\n').split('\n').flatMap((line) => {
    if (!line) return [''];
    const chunks: string[] = [];
    let chunk = '';
    let cells = 0;
    for (const character of line) {
      const nextWidth = character === '\t' ? 4 : charWidth(character);
      if (chunk && cells + nextWidth > width) {
        chunks.push(chunk);
        chunk = '';
        cells = 0;
      }
      chunk += character === '\t' ? '    ' : character;
      cells += nextWidth;
    }
    chunks.push(chunk);
    return chunks;
  });
}

function truncateOutputTail(text: string, maxLines: number, lineWidth: number): { text: string; omitted: number } {
  const visualLines = wrapVisual(text, lineWidth);
  if (visualLines.length <= maxLines) return { text: visualLines.join('\n'), omitted: 0 };
  const omitted = visualLines.length - maxLines;
  return { text: visualLines.slice(-maxLines).join('\n'), omitted };
}

function StatusIndicator({ status }: { status: ToolCallStatus }) {
  const display = STATUS[status];
  return (
    <Box width={2} flexShrink={0}>
      <Text bold={status === 'error'} color={statusColor(status)}>{`${display.icon} `}</Text>
    </Box>
  );
}

function ToolLine({
  tool,
  expanded,
  contentWidth,
  maxOutputLines,
}: {
  tool: ToolCall;
  expanded: boolean;
  contentWidth: number;
  maxOutputLines: number;
}) {
  const status = STATUS[tool.status];
  const description = descriptionFor(tool);
  const output = truncateOutputTail(toolOutput(tool), maxOutputLines, Math.max(8, contentWidth - 4));
  return (
    <Box flexDirection="column">
      <Box>
        <StatusIndicator status={tool.status} />
        <Text bold color={qwenTheme.text.primary}>{tool.name}</Text>
        {description && <Text dimColor color={qwenTheme.text.secondary}>{` ${description}`}</Text>}
        <Text dimColor color={qwenTheme.text.secondary}>{` · ${status.label}`}</Text>
        {tool.result?.durationMs !== undefined && (
          <Text dimColor color={qwenTheme.text.secondary}>{` ${tool.result.durationMs}ms`}</Text>
        )}
      </Box>
      {expanded && (
        <Box flexDirection="column" marginLeft={2}>
          <Text dimColor color={qwenTheme.text.secondary}>input</Text>
          <Text color={qwenTheme.text.primary} wrap="wrap">{valueText(tool.arguments) || '{}'}</Text>
          {output.text && (
            <>
              <Text dimColor color={qwenTheme.text.secondary}>
                {tool.status === 'error' ? 'error' : tool.result ? 'output' : 'update'}
              </Text>
              {output.omitted > 0 && (
                <Text dimColor color={qwenTheme.text.secondary}>{`... first ${output.omitted} lines hidden ...`}</Text>
              )}
              <Text color={tool.status === 'error' ? qwenTheme.status.error : qwenTheme.text.primary} wrap="wrap">
                {output.text}
              </Text>
            </>
          )}
        </Box>
      )}
    </Box>
  );
}

export function ToolGroup({
  item,
  terminalWidth,
  expanded,
  defaultExpanded = false,
  isFocused = false,
  maxOutputLines = 5,
  onExpandedChange,
}: ToolGroupProps) {
  const [localExpanded, setLocalExpanded] = useState(defaultExpanded);
  const isExpanded = expanded ?? localExpanded;
  const setExpanded = (next: boolean) => {
    if (expanded === undefined) setLocalExpanded(next);
    onExpandedChange?.(next);
  };

  useInput((input, key) => {
    if (key.leftArrow) setExpanded(false);
    else if (key.rightArrow) setExpanded(true);
    else if (key.return || input === ' ') setExpanded(!isExpanded);
  }, { isActive: isFocused });

  const contentWidth = Math.max(12, terminalWidth - 4);
  const categorized = new Map<ToolCategory, ToolCall[]>();
  for (const category of CATEGORY_ORDER) categorized.set(category, []);
  for (const tool of item.tools) categorized.get(categoryFor(tool))?.push(tool);

  return (
    <Box flexDirection="column" marginLeft={2} marginRight={2}>
      {CATEGORY_ORDER.flatMap((category) => {
        const tools = categorized.get(category) ?? [];
        if (tools.length === 0) return [];
        const canSummarize = !isExpanded
          && (category === 'read' || category === 'search' || category === 'list')
          && tools.every((tool) => tool.status !== 'error');
        if (canSummarize) {
          const status = aggregateStatus(tools);
          return [
            <Box key={`summary-${category}`}>
              <StatusIndicator status={status} />
              <Text color={qwenTheme.text.primary}>{categorySummary(category, tools)}</Text>
            </Box>,
          ];
        }
        return tools.map((tool) => (
          <ToolLine
            key={tool.callId}
            tool={tool}
            expanded={isExpanded}
            contentWidth={contentWidth}
            maxOutputLines={maxOutputLines}
          />
        ));
      })}
    </Box>
  );
}
