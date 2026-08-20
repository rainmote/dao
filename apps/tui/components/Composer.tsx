import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';

import { qwenTheme } from '../theme.js';

import {
  createTextBuffer,
  deleteBackward,
  deleteForward,
  graphemes,
  insertNewline,
  insertText,
  isOnFirstLine,
  isOnLastLine,
  moveCursor,
  reconcileTextBuffer,
  replaceText,
  splitLinesWithOffsets,
  type TextBufferState,
} from '../text-buffer.js';

export interface ComposerCommandDefinition {
  /** Canonical command name, with or without the leading slash. */
  readonly name: string;
  readonly description?: string;
  readonly aliases?: readonly string[];
}

export type ComposerCommand = string | ComposerCommandDefinition;

export interface ComposerSubmitOptions {
  /** false sends an in-flight steer; true queues a follow-up. */
  readonly deferUntilIdle: boolean;
}

export type ComposerAbortReason = 'escape' | 'ctrl-c';

export interface ComposerProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string, options: ComposerSubmitOptions) => void;
  busy: boolean;
  commands?: readonly ComposerCommand[];
  placeholder?: string;
  focus?: boolean;
  onAbort?: (reason?: ComposerAbortReason) => void;
  /** Called for readline-style Ctrl+D when the input is empty. */
  onExitRequest?: () => void;
  /** Host-registered shortcut names such as `ctrl+g` or `alt+enter`. */
  shortcutNames?: readonly string[];
  onShortcut?: (shortcut: string) => void;
}

interface NormalizedCommand {
  readonly name: string;
  readonly description?: string;
  readonly matchNames: readonly string[];
}

const MAX_VISIBLE_SUGGESTIONS = 8;

function shortcutName(input: string, key: Parameters<Parameters<typeof useInput>[0]>[1]): string | null {
  if (key.ctrl && input) return `ctrl+${input.toLocaleLowerCase()}`;
  if (key.meta && key.return) return 'alt+enter';
  if (key.tab) return 'tab';
  if (key.escape) return 'escape';
  if (key.return) return 'enter';
  return null;
}

function withSlash(name: string): string {
  const trimmed = name.trim();
  return trimmed.startsWith('/') ? trimmed : `/${trimmed}`;
}

function normalizeCommands(
  commands: readonly ComposerCommand[],
): NormalizedCommand[] {
  const byName = new Map<string, NormalizedCommand>();
  for (const command of commands) {
    const definition =
      typeof command === 'string' ? { name: command } : command;
    const name = withSlash(definition.name);
    if (name === '/') continue;
    const aliases = (definition.aliases ?? []).map(withSlash);
    const normalized: NormalizedCommand = {
      name,
      description: definition.description,
      matchNames: [name, ...aliases].map((entry) => entry.toLocaleLowerCase()),
    };
    byName.set(name.toLocaleLowerCase(), normalized);
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function completionQuery(buffer: TextBufferState): string | null {
  if (buffer.cursor !== buffer.text.length) return null;
  return /^\/[\S]*$/.test(buffer.text) ? buffer.text.toLocaleLowerCase() : null;
}

function renderInputLine(
  line: ReturnType<typeof splitLinesWithOffsets>[number],
  cursor: number,
  showCursor: boolean,
) {
  const cursorOnLine = cursor >= line.start && cursor <= line.end;
  if (!showCursor || !cursorOnLine) {
    return <Text color={qwenTheme.text.primary}>{line.text || ' '}</Text>;
  }

  const relativeCursor = cursor - line.start;
  const before = line.text.slice(0, relativeCursor);
  const remaining = line.text.slice(relativeCursor);
  const cursorGrapheme = graphemes(remaining)[0];
  const cursorCell = cursorGrapheme ?? ' ';
  const after = cursorGrapheme
    ? remaining.slice(cursorGrapheme.length)
    : remaining;
  return (
    <Text color={qwenTheme.text.primary}>
      {before}
      <Text inverse>{cursorCell}</Text>
      {!cursorGrapheme ? '\u200B' : null}
      {after}
    </Text>
  );
}

function Placeholder({ text, cursor }: { text: string; cursor: boolean }) {
  if (!cursor) return <Text color={qwenTheme.text.secondary}>{text}</Text>;
  const [first = ' ', ...rest] = graphemes(text);
  return (
    <Text>
      <Text inverse color={qwenTheme.text.primary}>{first}</Text>
      <Text color={qwenTheme.text.secondary}>{rest.join('')}</Text>
    </Text>
  );
}

function normalizedDescription(description: string): string {
  return description.replace(/\s+/g, ' ').trim();
}

/**
 * A backend-agnostic, controlled Ink composer. It follows Qwen Code's
 * input/steer/follow-up model while keeping protocol choices in its parent.
 */
export function Composer({
  value,
  onChange,
  onSubmit,
  busy,
  commands = [],
  placeholder = '  Type your message or @path/to/file',
  focus = true,
  onAbort,
  onExitRequest,
  shortcutNames = [],
  onShortcut,
}: ComposerProps) {
  const { stdout } = useStdout();
  const [buffer, setBuffer] = useState(() => createTextBuffer(value));
  const current = reconcileTextBuffer(buffer, value);
  const historyRef = useRef<string[]>([]);
  const draftRef = useRef('');
  const [historyIndex, setHistoryIndex] = useState<number | null>(null);
  const [suggestionIndex, setSuggestionIndex] = useState(0);

  // Keep the state object aligned when the controlled value changes for a
  // reason other than our own edit (session restore, clear, command action).
  useEffect(() => {
    setBuffer((previous) => reconcileTextBuffer(previous, value));
  }, [value]);

  const normalizedCommands = useMemo(
    () => normalizeCommands(commands),
    [commands],
  );
  const registeredShortcuts = useMemo(
    () => new Set(shortcutNames.map((name) => name.toLocaleLowerCase())),
    [shortcutNames],
  );
  const query = completionQuery(current);
  const suggestions = useMemo(
    () =>
      query === null
        ? []
        : normalizedCommands.filter((command) =>
            command.matchNames.some((name) => name.startsWith(query)),
          ),
    [normalizedCommands, query],
  );

  useEffect(() => {
    setSuggestionIndex(0);
  }, [query]);
  const selectedSuggestionIndex = Math.min(
    suggestionIndex,
    Math.max(0, suggestions.length - 1),
  );
  const suggestionWindowStart = Math.max(
    0,
    Math.min(
      selectedSuggestionIndex - MAX_VISIBLE_SUGGESTIONS + 1,
      suggestions.length - MAX_VISIBLE_SUGGESTIONS,
    ),
  );
  const visibleSuggestions = suggestions.slice(
    suggestionWindowStart,
    suggestionWindowStart + MAX_VISIBLE_SUGGESTIONS,
  );

  const commit = (next: TextBufferState, resetHistory = false) => {
    setBuffer(next);
    if (next.text !== current.text) onChange(next.text);
    if (resetHistory && next.text !== current.text) {
      setHistoryIndex(null);
    }
  };

  const acceptSuggestion = () => {
    const suggestion = suggestions[selectedSuggestionIndex];
    if (!suggestion) return;
    commit(replaceText(current, `${suggestion.name} `), true);
  };

  const submit = (deferUntilIdle: boolean) => {
    if (!current.text.trim()) return;
    const submitted = current.text;
    const history = historyRef.current;
    if (history[history.length - 1] !== submitted) history.push(submitted);
    draftRef.current = '';
    setHistoryIndex(null);
    commit(replaceText(current, ''));
    onSubmit(submitted, { deferUntilIdle });
  };

  const recallHistory = (direction: -1 | 1) => {
    const history = historyRef.current;
    if (history.length === 0) return;

    if (direction === -1) {
      if (historyIndex === null) draftRef.current = current.text;
      const nextIndex =
        historyIndex === null
          ? history.length - 1
          : Math.max(0, historyIndex - 1);
      setHistoryIndex(nextIndex);
      commit(replaceText(current, history[nextIndex]!));
      return;
    }

    if (historyIndex === null) return;
    const nextIndex = historyIndex + 1;
    if (nextIndex >= history.length) {
      setHistoryIndex(null);
      commit(replaceText(current, draftRef.current));
    } else {
      setHistoryIndex(nextIndex);
      commit(replaceText(current, history[nextIndex]!));
    }
  };

  useInput(
    (input, key) => {
      if (key.eventType === 'release') return;

      const shortcut = shortcutName(input, key);
      if (shortcut && onShortcut && registeredShortcuts.has(shortcut)) {
        onShortcut(shortcut);
        return;
      }

      if (key.escape) {
        onAbort?.('escape');
        return;
      }

      if (key.ctrl && input.toLocaleLowerCase() === 'c') {
        onAbort?.('ctrl-c');
        return;
      }

      if (key.ctrl && input.toLocaleLowerCase() === 'd') {
        if (current.text.length === 0) onExitRequest?.();
        else commit(deleteForward(current), true);
        return;
      }

      if (key.ctrl && input.toLocaleLowerCase() === 'n') {
        commit(insertNewline(current), true);
        return;
      }

      if (key.return) {
        if (key.meta) {
          if (busy) submit(true);
          else commit(insertNewline(current), true);
          return;
        }
        if (key.ctrl || key.shift) {
          commit(insertNewline(current), true);
          return;
        }

        const selected = suggestions[selectedSuggestionIndex];
        const exactMatch = suggestions.some((suggestion) =>
          suggestion.matchNames.includes(current.text.toLocaleLowerCase()),
        );
        if (selected && !exactMatch) {
          acceptSuggestion();
          return;
        }
        // During a run this is an immediate steer. When idle it starts a run.
        submit(false);
        return;
      }

      if (key.tab) {
        if (suggestions.length > 0) acceptSuggestion();
        return;
      }

      if (suggestions.length > 0 && (key.upArrow || key.downArrow)) {
        const delta = key.upArrow ? -1 : 1;
        setSuggestionIndex(
          (selectedSuggestionIndex + delta + suggestions.length) %
            suggestions.length,
        );
        return;
      }

      if (key.leftArrow) {
        commit(moveCursor(current, 'left'));
        return;
      }
      if (key.rightArrow) {
        commit(moveCursor(current, 'right'));
        return;
      }
      if (key.home || (key.ctrl && input.toLocaleLowerCase() === 'a')) {
        commit(moveCursor(current, 'home'));
        return;
      }
      if (key.end || (key.ctrl && input.toLocaleLowerCase() === 'e')) {
        commit(moveCursor(current, 'end'));
        return;
      }

      if (key.upArrow) {
        if (historyIndex !== null || isOnFirstLine(current)) {
          recallHistory(-1);
        } else {
          commit(moveCursor(current, 'up'));
        }
        return;
      }
      if (key.downArrow) {
        if (historyIndex !== null || isOnLastLine(current)) {
          recallHistory(1);
        } else {
          commit(moveCursor(current, 'down'));
        }
        return;
      }

      if (key.backspace || input === '\u007f') {
        commit(deleteBackward(current), true);
        return;
      }
      if (key.delete) {
        commit(deleteForward(current), true);
        return;
      }

      // Readline/control sequences and unsupported Alt shortcuts must never be
      // inserted as text. A paste can contain several printable characters
      // and newlines and is intentionally accepted as one edit.
      if (key.ctrl || key.meta || input.length === 0) return;
      commit(insertText(current, input), true);
    },
    { isActive: focus },
  );

  const lines = splitLinesWithOffsets(current.text);
  const terminalWidth = Math.max(20, stdout.columns || 80);
  const borderColor = focus
    ? qwenTheme.border.focused
    : qwenTheme.border.default;
  const suggestionContentWidth = Math.max(1, terminalWidth - 6);
  const suggestionLabelWidth = Math.max(
    1,
    Math.min(
      Math.max(...suggestions.map((suggestion) => suggestion.name.length), 1),
      Math.floor(suggestionContentWidth * 0.5),
    ),
  );

  return (
    <Box flexDirection="column" width="100%" marginTop={1}>
      <Text color={borderColor} wrap="truncate-end">
        {'─'.repeat(terminalWidth)}
      </Text>
      <Box
        borderStyle="single"
        borderTop={false}
        borderBottom
        borderLeft={false}
        borderRight={false}
        borderColor={borderColor}
      >
        <Text color={qwenTheme.text.accent}>{'> '}</Text>
        <Box flexDirection="column" flexGrow={1}>
          {current.text.length === 0 ? (
            <Placeholder text={placeholder} cursor={focus} />
          ) : (
            lines.map((line) => (
              <Box key={line.start} height={1}>
                {renderInputLine(line, current.cursor, focus)}
              </Box>
            ))
          )}
        </Box>
      </Box>

      {suggestions.length > 0 && (
        <Box flexDirection="column" marginX={2}>
          {suggestionWindowStart > 0 && (
            <Text color={qwenTheme.text.primary}>▲</Text>
          )}
          {visibleSuggestions.map((suggestion, offset) => {
            const index = suggestionWindowStart + offset;
            const selected = index === selectedSuggestionIndex;
            const color = selected
              ? qwenTheme.text.accent
              : qwenTheme.text.secondary;
            return (
              <Box key={suggestion.name} flexDirection="row" width="100%">
                <Box width={2} flexShrink={0}>
                  <Text color={color}>{selected ? '> ' : '  '}</Text>
                </Box>
                <Box width={suggestionLabelWidth} flexShrink={0}>
                  <Text color={color} wrap="truncate-end">
                    {suggestion.name}
                  </Text>
                </Box>
                {suggestion.description ? (
                  <Box flexGrow={1} minWidth={1} paddingLeft={2}>
                    <Text color={color} wrap="truncate-end">
                      {normalizedDescription(suggestion.description)}
                    </Text>
                  </Box>
                ) : null}
              </Box>
            );
          })}
          {suggestionWindowStart + visibleSuggestions.length <
            suggestions.length && (
            <Text color={qwenTheme.text.secondary}>▼</Text>
          )}
          {suggestions.length > MAX_VISIBLE_SUGGESTIONS && (
            <Text color={qwenTheme.text.secondary}>
              ({selectedSuggestionIndex + 1}/{suggestions.length})
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}

export default Composer;
