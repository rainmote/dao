import { useEffect, useState } from 'react';
import { Box, Text, useInput } from 'ink';
import { qwenTheme } from '../theme.js';
import type { HistoryItemToolGroup, ToolCall, ToolCallStatus } from '../types.js';
import { AnimatedSpinner } from './LoadingIndicator.js';

interface ToolGroupProps {
  item: HistoryItemToolGroup;
  terminalWidth: number;
  expanded?: boolean;
  defaultExpanded?: boolean;
  isFocused?: boolean;
  maxOutputLines?: number;
  onExpandedChange?: (expanded: boolean) => void;
}

type ToolCategory =
  | 'search'
  | 'read'
  | 'list'
  | 'shell'
  | 'edit'
  | 'write'
  | 'agent'
  | 'other';

const STATUS: Record<ToolCallStatus, { icon: string }> = {
  pending: { icon: 'o' },
  confirming: { icon: '?' },
  running: { icon: '⊷' },
  success: { icon: '✓' },
  error: { icon: 'x' },
  canceled: { icon: '-' },
};

const TOOL_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  edit: 'Edit',
  edit_file: 'Edit',
  hash_edit: 'HashEdit',
  apply_patch: 'Edit',
  patch: 'Edit',
  replace: 'Edit',
  write: 'WriteFile',
  write_file: 'WriteFile',
  create_file: 'WriteFile',
  read: 'ReadFile',
  read_file: 'ReadFile',
  hash_read: 'HashRead',
  view: 'ReadFile',
  view_file: 'ReadFile',
  get_file: 'ReadFile',
  open_file: 'ReadFile',
  zoom_image: 'ZoomImage',
  grep: 'Grep',
  grep_search: 'Grep',
  search_file_content: 'Grep',
  ripgrep: 'Grep',
  rg: 'Grep',
  glob: 'Glob',
  find: 'Glob',
  find_files: 'Glob',
  findfiles: 'Glob',
  run_shell_command: 'Shell',
  shell: 'Shell',
  bash: 'Shell',
  exec: 'Shell',
  exec_command: 'Shell',
  command: 'Shell',
  terminal: 'Shell',
  todo_write: 'TodoList',
  get_goal: 'Goal',
  update_goal: 'UpdateGoal',
  save_memory: 'SaveMemory',
  agent: 'Agent',
  task: 'Agent',
  workflow: 'Workflow',
  send_message: 'SendMessage',
  list_agents: 'ListAgents',
  spawn_agent: 'SpawnAgent',
  wait_agent: 'WaitAgent',
  interrupt_agent: 'InterruptAgent',
  followup_task: 'FollowupTask',
  task_create: 'TaskCreate',
  task_update: 'TaskUpdate',
  task_list: 'TaskList',
  task_stop: 'TaskStop',
  create_sub_session: 'CreateSubSession',
  team_create: 'TeamCreate',
  team_delete: 'TeamDelete',
  team_plan_approval: 'TeamPlanApproval',
  skill: 'Skill',
  enter_plan_mode: 'EnterPlanMode',
  exit_plan_mode: 'ExitPlanMode',
  web_fetch: 'WebFetch',
  web_search: 'WebSearch',
  list: 'ListFiles',
  ls: 'ListFiles',
  list_directory: 'ListFiles',
  read_directory: 'ListFiles',
  read_dir: 'ListFiles',
  read_folder: 'ListFiles',
  ls_files: 'ListFiles',
  lsp: 'Lsp',
  ask_user_question: 'AskUserQuestion',
  cron_create: 'CronCreate',
  cron_list: 'CronList',
  cron_delete: 'CronDelete',
  loop_wakeup: 'LoopWakeup',
  structured_output: 'StructuredOutput',
  monitor: 'Monitor',
  notebook: 'NotebookEdit',
  notebook_edit: 'NotebookEdit',
  tool_search: 'ToolSearch',
  read_mcp_resource: 'ReadMcpResource',
  enter_worktree: 'EnterWorktree',
  exit_worktree: 'ExitWorktree',
  artifact: 'Artifact',
  record_artifact: 'RecordArtifact',
  display_image: 'DisplayImage',
  image_gen: 'ImageGen',
};

function normalizedToolName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function pascalCaseToolName(name: string): string {
  const words = name
    .trim()
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[^A-Za-z\d]+/)
    .filter(Boolean);
  if (words.length === 0) return 'Tool';
  return words
    .map((word) => `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
    .join('');
}

export function toolDisplayName(name: string): string {
  return TOOL_DISPLAY_NAMES[normalizedToolName(name)] ?? pascalCaseToolName(name);
}

const TOOL_CATEGORIES: Readonly<Record<string, ToolCategory>> = {
  read: 'read',
  read_file: 'read',
  hash_read: 'read',
  view: 'read',
  view_file: 'read',
  get_file: 'read',
  open_file: 'read',
  grep: 'search',
  grep_search: 'search',
  search_file_content: 'search',
  ripgrep: 'search',
  rg: 'search',
  glob: 'search',
  find: 'search',
  find_files: 'search',
  findfiles: 'search',
  search: 'search',
  query: 'search',
  list: 'list',
  ls: 'list',
  list_directory: 'list',
  read_directory: 'list',
  read_dir: 'list',
  read_folder: 'list',
  ls_files: 'list',
  edit: 'edit',
  edit_file: 'edit',
  hash_edit: 'edit',
  apply_patch: 'edit',
  patch: 'edit',
  replace: 'edit',
  notebook: 'edit',
  notebook_edit: 'edit',
  write: 'write',
  write_file: 'write',
  create_file: 'write',
  run_shell_command: 'shell',
  shell: 'shell',
  bash: 'shell',
  exec: 'shell',
  exec_command: 'shell',
  command: 'shell',
  terminal: 'shell',
  agent: 'agent',
  task: 'agent',
  workflow: 'agent',
  send_message: 'agent',
  list_agents: 'agent',
  spawn_agent: 'agent',
  wait_agent: 'agent',
  interrupt_agent: 'agent',
  followup_task: 'agent',
  task_create: 'agent',
  task_update: 'agent',
  task_list: 'agent',
  task_stop: 'agent',
};

function statusColor(status: ToolCallStatus): string {
  if (status === 'running') return qwenTheme.text.primary;
  if (status === 'error') return qwenTheme.status.error;
  if (status === 'confirming' || status === 'canceled') return qwenTheme.status.warning;
  return qwenTheme.status.success;
}

const CATEGORY_ORDER: readonly ToolCategory[] = [
  'search',
  'read',
  'list',
  'shell',
  'edit',
  'write',
  'agent',
  'other',
];

const COLLAPSIBLE_CATEGORIES: ReadonlySet<ToolCategory> = new Set([
  'search',
  'read',
  'list',
]);

const DESCRIPTION_INLINE_LIMIT = 3;
const DESCRIPTION_PREVIEW_COUNT = 2;

function sanitize(text: string): string {
  return text
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b[()][A-Z0-9]/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b./g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '');
}

function safeDescription(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  const cleaned = raw
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '')
    .replace(/\u001b[()][A-Z0-9]/g, '')
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/\u001b./g, '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '')
    .trim();

  if (cleaned.startsWith('{') || cleaned.startsWith('[')) {
    try {
      const parsed = JSON.parse(cleaned) as unknown;
      if (typeof parsed === 'object' && parsed !== null) return undefined;
    } catch {
      // A path such as "[id].tsx" only resembles JSON and remains useful.
    }
  }

  return cleaned || undefined;
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

function categoryFor(tool: ToolCall): ToolCategory {
  return TOOL_CATEGORIES[normalizedToolName(tool.name)] ?? 'other';
}

export function getOverallStatus(tools: readonly ToolCall[]): ToolCallStatus {
  if (tools.some((tool) => tool.status === 'confirming')) return 'confirming';
  if (tools.some((tool) => tool.status === 'running')) return 'running';
  if (tools.some((tool) => tool.status === 'error')) return 'error';
  if (tools.some((tool) => tool.status === 'canceled')) return 'canceled';
  if (tools.some((tool) => tool.status === 'pending')) return 'pending';
  return 'success';
}

function rawDescriptionFor(tool: ToolCall): string | undefined {
  if (typeof tool.arguments === 'string') return tool.arguments;
  if (!tool.arguments || typeof tool.arguments !== 'object') return undefined;
  const args = tool.arguments as Record<string, unknown>;
  const category = categoryFor(tool);
  const keys = category === 'search'
    ? ['pattern', 'query', 'search', 'glob', 'path']
    : category === 'shell'
      ? ['command', 'cmd', 'script']
      : category === 'agent'
        ? ['description', 'prompt', 'task', 'name']
        : ['path', 'file_path', 'file', 'directory', 'dir'];
  for (const key of keys) {
    const value = args[key];
    if (typeof value === 'string' && value.trim()) return value;
  }
  for (const value of Object.values(args)) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return undefined;
}

function descriptionFor(tool: ToolCall): string {
  return safeDescription(rawDescriptionFor(tool)) ?? '';
}

const CATEGORY_TEMPLATES: Record<
  ToolCategory,
  { pastVerb: string; activeVerb: string; singular: string; plural: string }
> = {
  search: { pastVerb: 'Searched', activeVerb: 'Searching', singular: 'pattern', plural: 'patterns' },
  read: { pastVerb: 'Read', activeVerb: 'Reading', singular: 'file', plural: 'files' },
  list: { pastVerb: 'Listed', activeVerb: 'Listing', singular: 'directory', plural: 'directories' },
  shell: { pastVerb: 'Ran', activeVerb: 'Running', singular: 'command', plural: 'commands' },
  edit: { pastVerb: 'Edited', activeVerb: 'Editing', singular: 'file', plural: 'files' },
  write: { pastVerb: 'Wrote', activeVerb: 'Writing', singular: 'file', plural: 'files' },
  agent: { pastVerb: 'Ran', activeVerb: 'Running', singular: 'agent', plural: 'agents' },
  other: { pastVerb: 'Used', activeVerb: 'Using', singular: 'tool', plural: 'tools' },
};

function countSummary(category: ToolCategory, count: number, isActive: boolean): string {
  const template = CATEGORY_TEMPLATES[category];
  const verb = isActive ? template.activeVerb : template.pastVerb;
  return `${verb} ${count} ${count === 1 ? template.singular : template.plural}`;
}

export function buildToolSummary(tools: readonly ToolCall[], isActive: boolean): string {
  const categorized = new Map<ToolCategory, ToolCall[]>();
  for (const tool of tools) {
    const category = categoryFor(tool);
    const entries = categorized.get(category) ?? [];
    entries.push(tool);
    categorized.set(category, entries);
  }

  const parts: string[] = [];
  for (const category of CATEGORY_ORDER) {
    const entries = categorized.get(category);
    if (!entries?.length) continue;

    const template = CATEGORY_TEMPLATES[category];
    const verb = isActive ? template.activeVerb : template.pastVerb;
    let part: string;
    if (entries.length === 1) {
      const description = safeDescription(rawDescriptionFor(entries[0]));
      part = description
        ? `${verb} ${description}`
        : countSummary(category, 1, isActive);
    } else if (entries.length <= DESCRIPTION_INLINE_LIMIT) {
      const descriptions = entries
        .map((tool) => safeDescription(rawDescriptionFor(tool)))
        .filter((description): description is string => description !== undefined);
      part = descriptions.length === entries.length
        ? `${verb} ${descriptions.join(', ')}`
        : countSummary(category, entries.length, isActive);
    } else {
      const descriptions = entries
        .slice(0, DESCRIPTION_PREVIEW_COUNT)
        .map((tool) => safeDescription(rawDescriptionFor(tool)))
        .filter((description): description is string => description !== undefined);
      part = descriptions.length === DESCRIPTION_PREVIEW_COUNT
        ? `${verb} ${descriptions.join(', ')}, ... and ${entries.length - DESCRIPTION_PREVIEW_COUNT} more`
        : countSummary(category, entries.length, isActive);
    }

    if (parts.length > 0) part = part.charAt(0).toLowerCase() + part.slice(1);
    parts.push(part);
  }

  return parts.join(', ');
}

function categoryShowsDescriptionsInline(tools: readonly ToolCall[], category: ToolCategory): boolean {
  const peers = tools.filter((tool) => categoryFor(tool) === category);
  return peers.length <= DESCRIPTION_INLINE_LIMIT
    && peers.every((tool) => safeDescription(rawDescriptionFor(tool)) !== undefined);
}

function activeToolHint(tools: readonly ToolCall[]): string | undefined {
  if (tools.length < 2) return undefined;
  for (const status of ['running', 'pending'] as const) {
    for (let index = tools.length - 1; index >= 0; index -= 1) {
      const tool = tools[index];
      if (tool.status !== status) continue;
      const category = categoryFor(tool);
      const hasPeers = tools.some(
        (candidate, candidateIndex) => candidateIndex !== index && categoryFor(candidate) === category,
      );
      if (!hasPeers || categoryShowsDescriptionsInline(tools, category)) return undefined;
      return safeDescription(rawDescriptionFor(tool));
    }
  }
  return undefined;
}

function toolOutput(tool: ToolCall): string {
  if (tool.result?.error) return valueText(tool.result.error);
  if (tool.result?.content) return valueText(tool.result.content);
  if (tool.result?.details !== undefined) return valueText(tool.result.details);
  if (tool.updates.length > 0) return updateText(tool.updates.at(-1));
  return '';
}

function updateText(update: unknown): string {
  if (!update || typeof update !== 'object' || Array.isArray(update)) {
    return valueText(update);
  }
  const data = update as Record<string, unknown>;
  for (const key of ['chunk', 'stdout', 'stderr', 'output', 'content', 'text', 'message']) {
    const value = data[key];
    if (typeof value === 'string') return valueText(value);
  }
  return valueText(update);
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
      {status === 'running' ? (
        <AnimatedSpinner type="toggle" />
      ) : (
        <Text
          bold={status === 'error' || status === 'canceled'}
          color={statusColor(status)}
        >
          {`${display.icon} `}
        </Text>
      )}
    </Box>
  );
}

function activeToolFor(
  tools: readonly ToolCall[],
  status: ToolCallStatus,
): ToolCall | undefined {
  if (status === 'running') {
    return tools.find((tool) => tool.status === 'running');
  }
  return tools.at(-1);
}

function timeoutFor(tool: ToolCall | undefined): number | undefined {
  if (!tool?.arguments || typeof tool.arguments !== 'object') return undefined;
  const arguments_ = tool.arguments as Record<string, unknown>;
  const timeout = arguments_.timeout_ms ?? arguments_.timeoutMs;
  return typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0
    ? timeout
    : undefined;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds === 0
      ? `${minutes}m`
      : `${minutes}m ${remainingSeconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes === 0
    ? `${hours}h`
    : `${hours}h ${remainingMinutes}m`;
}

function ToolElapsedTime({
  tool,
  status,
}: {
  tool: ToolCall | undefined;
  status: ToolCallStatus;
}) {
  const [elapsedMs, setElapsedMs] = useState(0);
  const executionStartTime = tool?.executionStartTime;
  const timeoutMs = timeoutFor(tool);

  useEffect(() => {
    if (status !== 'running' || executionStartTime === undefined) {
      setElapsedMs(0);
      return undefined;
    }

    const update = () => {
      setElapsedMs(Math.max(0, Date.now() - executionStartTime));
    };
    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [executionStartTime, status]);

  if (status !== 'running' || executionStartTime === undefined) return null;
  if (timeoutMs === undefined && elapsedMs < 3000) return null;

  const label = timeoutMs === undefined
    ? formatDuration(elapsedMs)
    : `(${formatDuration(elapsedMs)} · timeout ${formatDuration(timeoutMs)})`;
  return (
    <Box flexShrink={0} marginLeft={1}>
      <Text color={qwenTheme.text.secondary}>{label}</Text>
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
  const description = descriptionFor(tool);
  const rawOutput = toolOutput(tool);
  const output = expanded
    ? { text: rawOutput, omitted: 0 }
    : truncateOutputTail(
        rawOutput,
        Math.max(1, maxOutputLines),
        Math.max(8, contentWidth - 4),
      );
  const isCollapsible = COLLAPSIBLE_CATEGORIES.has(categoryFor(tool));
  const showOutput = expanded
    || !isCollapsible
    || tool.status === 'error'
    || tool.status === 'canceled';
  return (
    <Box flexDirection="column">
      <Box>
        <StatusIndicator status={tool.status} />
        <Box flexGrow={1}>
          <Text
            color={qwenTheme.text.primary}
            strikethrough={tool.status === 'canceled'}
            wrap="wrap"
          >
            <Text bold>{toolDisplayName(tool.name)}</Text>
            {description && (
              <Text color={qwenTheme.text.secondary}>{` ${description}`}</Text>
            )}
          </Text>
        </Box>
        <ToolElapsedTime tool={tool} status={tool.status} />
      </Box>
      {showOutput && output.text && (
        <Box flexDirection="column" marginLeft={2}>
          {output.omitted > 0 && (
            <Text dimColor color={qwenTheme.text.secondary}>{`... first ${output.omitted} lines hidden ...`}</Text>
          )}
          <Text
            color={tool.status === 'error' ? qwenTheme.status.error : qwenTheme.text.primary}
            wrap="wrap"
          >
            {output.text}
          </Text>
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
  const forceIndividual = isExpanded
    || item.tools.some(
      (tool) => tool.status === 'confirming' || tool.status === 'error',
    );
  const collapsibleTools = forceIndividual
    ? []
    : item.tools.filter(
        (tool) => COLLAPSIBLE_CATEGORIES.has(categoryFor(tool))
          && tool.status !== 'canceled',
      );
  const individualTools = forceIndividual
    ? item.tools
    : item.tools.filter(
        (tool) => !COLLAPSIBLE_CATEGORIES.has(categoryFor(tool))
          || tool.status === 'canceled',
      );
  const summaryStatus = getOverallStatus(collapsibleTools);
  const summaryIsActive = summaryStatus === 'running' || summaryStatus === 'pending';
  const activeSummaryTool = activeToolFor(collapsibleTools, summaryStatus);
  const hint = summaryIsActive ? activeToolHint(collapsibleTools) : undefined;

  return (
    <Box flexDirection="column" marginLeft={2} marginRight={2}>
      {collapsibleTools.length > 0 && (
        <Box flexDirection="column">
          <Box>
            <StatusIndicator status={summaryStatus} />
            <Box flexGrow={1}>
              <Text bold color={qwenTheme.text.primary} wrap="wrap">
                {buildToolSummary(collapsibleTools, summaryIsActive)}
                {summaryIsActive ? '…' : ''}
              </Text>
            </Box>
            <ToolElapsedTime tool={activeSummaryTool} status={summaryStatus} />
          </Box>
          {hint && (
            <Box marginLeft={2}>
              <Text dimColor color={qwenTheme.text.secondary} wrap="truncate-end">
                {`⎿ ${hint}`}
              </Text>
            </Box>
          )}
        </Box>
      )}
      {individualTools.map((tool) => (
        <ToolLine
          key={tool.callId}
          tool={tool}
          expanded={isExpanded}
          contentWidth={contentWidth}
          maxOutputLines={maxOutputLines}
        />
      ))}
    </Box>
  );
}
