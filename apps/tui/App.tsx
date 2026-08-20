import { useEffect, useMemo, useRef, useState } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';

import { applyEnvelope, fromSnapshot } from './projection.js';
import type { PluginEvent } from './transport.js';
import type {
  Envelope,
  HistoryItemInfo,
  JsonObject,
  Model,
  Snapshot,
  UiProjection,
} from './types.js';
import {
  Composer,
  type ComposerAbortReason,
  type ComposerCommand,
} from './components/Composer.js';
import { DialogManager, type ManagedDialog } from './components/DialogManager.js';
import type { ApprovalDecision } from './components/ApprovalDialog.js';
import type { SelectionOption } from './components/SelectionDialog.js';
import { Footer } from './components/Footer.js';
import { Header } from './components/Header.js';
import { LoadingIndicator } from './components/LoadingIndicator.js';
import { MainContent } from './components/MainContent.js';
import { QueuedMessageDisplay } from './components/QueuedMessageDisplay.js';
import { ExtensionDisplay } from './components/ExtensionDisplay.js';
import {
  DEFAULT_THEME_NAME,
  THEME_OPTIONS,
  normalizeThemeName,
  qwenTheme,
  setActiveTheme,
  type ThemeSelection,
} from './theme.js';

export interface AppTransport {
  ready(): Promise<unknown>;
  call<Result = unknown>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<Result>;
  subscribe(listener: (event: PluginEvent) => void): () => void;
  onError?(listener: (error: Error) => void): () => void;
}

export interface AppProps {
  transport: AppTransport;
  onExit?: () => void;
  cwd?: string;
  brand?: string;
  version?: string;
}

type SelectorState =
  | {
      kind: 'model';
      options: SelectionOption<string>[];
      initialValue?: string;
    }
  | {
      kind: 'session';
      options: SelectionOption<string>[];
      initialValue?: string;
    }
  | {
      kind: 'theme';
      options: SelectionOption<string>[];
      initialValue?: string;
      originalTheme: ThemeSelection;
    }
  | {
      kind: 'tree';
      options: SelectionOption<string>[];
      initialValue?: string;
    };

interface CommandResult extends JsonObject {
  handled?: boolean;
  output?: unknown;
  error?: string;
  ui?: string;
  theme?: string;
}

interface ModelListResult extends JsonObject {
  current?: Model | null;
  providers?: Model[];
}

function objectValue(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function stringValue(source: JsonObject | undefined, ...keys: string[]) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === 'string') return value;
  }
  return undefined;
}

function numberValue(source: JsonObject | undefined, ...keys: string[]) {
  for (const key of keys) {
    const value = source?.[key];
    if (typeof value === 'number') return value;
  }
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error || 'Unknown error');
}

function printableOutput(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function promptLabel(value: unknown): string {
  return (printableOutput(value) || String(value ?? 'null'))
    .replace(/\s+/g, ' ')
    .trim();
}

function promptOptionEntries(prompt: JsonObject | undefined): Array<{
  token: string;
  label: string;
  value: unknown;
}> {
  const declared = Array.isArray(prompt?.items)
    ? prompt.items
    : Array.isArray(prompt?.options)
      ? prompt.options
      : [];
  return declared.map((entry, index) => {
    const option = objectValue(entry);
    const structured = option && Object.hasOwn(option, 'value');
    const value = structured ? option.value : entry;
    return {
      token: String(index),
      label: (structured && stringValue(option, 'label')) || promptLabel(value),
      value,
    };
  });
}

function promptDefaultText(
  prompt: JsonObject | undefined,
  customJson: boolean,
): string {
  const value = Object.hasOwn(prompt ?? {}, 'value')
    ? prompt?.value
    : prompt?.default;
  if (value === undefined || value === null) return '';
  if (!customJson || typeof value === 'string') return String(value);
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
}

function normalizeCommands(value: unknown): ComposerCommand[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const command = objectValue(entry);
    const name = stringValue(command, 'name');
    if (!name) return [];
    return [{ name, description: stringValue(command, 'description') }];
  });
}

function selectorName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return value.replace(/^:/, '').replace(/^ui:/, '');
}

function modelKey(model: JsonObject | Model | null | undefined): string | undefined {
  const raw = model as JsonObject | undefined;
  return stringValue(raw, 'id', 'provider');
}

function modelLabel(model: JsonObject | Model | null | undefined): string {
  const raw = model as JsonObject | undefined;
  return stringValue(raw, 'model', 'id', 'provider') || 'default';
}

function modelOptions(
  output: unknown,
  projection: UiProjection,
): { options: SelectionOption<string>[]; initialValue?: string } {
  const result = objectValue(output);
  const rawProviders = Array.isArray(result?.providers)
    ? result.providers
    : projection.models?.providers ?? [];
  const options = rawProviders.flatMap((entry) => {
    const provider = objectValue(entry);
    const value = stringValue(provider, 'id', 'provider');
    if (!value) return [];
    const label = stringValue(provider, 'model', 'id', 'provider') || value;
    const providerName = stringValue(provider, 'provider');
    return [{
      value,
      label,
      description: providerName && providerName !== label ? providerName : undefined,
    }];
  });
  const current = objectValue(result?.current) ?? projection.models?.current;
  return { options, initialValue: modelKey(current) };
}

function sessionOptions(output: unknown): SelectionOption<string>[] {
  if (!Array.isArray(output)) return [];
  return output.flatMap((entry) => {
    const session = objectValue(entry);
    const path = stringValue(session, 'path');
    if (!path) return [];
    const id = stringValue(session, 'session-id', 'session_id', 'sessionId');
    const name = stringValue(session, 'name', 'label') || id || path;
    const messages = numberValue(
      session,
      'message-count',
      'message_count',
      'messageCount',
    );
    return [{
      value: path,
      label: name,
      description: [
        messages === undefined ? undefined : `${messages} messages`,
        path,
      ].filter(Boolean).join(' · '),
    }];
  });
}

function treeOptions(output: unknown): SelectionOption<string>[] {
  if (!Array.isArray(output)) return [];
  return output.flatMap((entry) => {
    const node = objectValue(entry);
    const id = stringValue(node, 'id', 'event-id', 'event_id');
    if (!id) return [];
    const type = stringValue(node, 'type') || 'event';
    const role = stringValue(node, 'role');
    const at = stringValue(node, 'at');
    return [{
      value: id,
      label: stringValue(node, 'label') || id,
      description: [type, role, at].filter(Boolean).join(' · '),
    }];
  });
}

function isSnapshot(value: unknown): value is Snapshot {
  const snapshot = objectValue(value);
  return Boolean(
    snapshot &&
      typeof snapshot.session_id === 'string' &&
      typeof snapshot.cursor === 'number' &&
      Array.isArray(snapshot.events) &&
      objectValue(snapshot.state),
  );
}

function commandName(text: string): string | null {
  const match = /^\s*\/([^\s]*)/.exec(text);
  return match?.[1]?.toLocaleLowerCase() || null;
}

function commandArgument(text: string): string {
  const match = /^\s*\/[^\s]+(?:\s+([\s\S]*))?$/.exec(text);
  return match?.[1]?.trim() || '';
}

function widgetPlacement(value: unknown): 'above-editor' | 'below-editor' {
  const entry = objectValue(value);
  const options = objectValue(entry?.options);
  return stringValue(options, 'placement') === 'below-editor'
    ? 'below-editor'
    : 'above-editor';
}

export function App({
  transport,
  onExit,
  cwd = process.cwd(),
  brand = 'bb-agent',
  version = '0.1.0',
}: AppProps) {
  const { stdout } = useStdout();
  const [terminalSize, setTerminalSize] = useState(() => ({
    width: stdout.columns || 80,
    height: stdout.rows || 24,
  }));
  const [projection, setProjection] = useState<UiProjection | null>(null);
  const [commands, setCommands] = useState<ComposerCommand[]>([]);
  const [localHistory, setLocalHistory] = useState<HistoryItemInfo[]>([]);
  const [composer, setComposer] = useState('');
  const [selector, setSelector] = useState<SelectorState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [resolvingApproval, setResolvingApproval] = useState(false);
  const [resolvingPrompt, setResolvingPrompt] = useState(false);
  const [exiting, setExiting] = useState(false);
  const [detailsExpanded, setDetailsExpanded] = useState(false);
  const [expandedToolGroups, setExpandedToolGroups] = useState<Set<string>>(
    () => new Set(),
  );
  const [theme, setTheme] = useState<ThemeSelection>(() => {
    setActiveTheme(DEFAULT_THEME_NAME);
    return DEFAULT_THEME_NAME;
  });
  const exitRequested = useRef(false);
  const lastCtrlCAt = useRef(0);
  const localHistoryId = useRef(0);

  useEffect(() => {
    const onResize = () => {
      setTerminalSize({
        width: stdout.columns || 80,
        height: stdout.rows || 24,
      });
    };
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  useEffect(() => {
    let active = true;
    let readyForEvents = false;
    const bufferedEvents: PluginEvent[] = [];
    const unsubscribe = transport.subscribe((event) => {
      if (!active) return;

      if (event.event === 'ui/extensions') {
        const snapshot = objectValue(event.data?.snapshot);
        const nextTheme = stringValue(snapshot, 'theme');
        const selectedTheme = setActiveTheme(nextTheme);
        if (selectedTheme) {
          setTheme(selectedTheme);
        }
      }

      if (!readyForEvents) {
        bufferedEvents.push(event);
        return;
      }
      setProjection((current) =>
        current
          ? applyEnvelope(current, event as unknown as Envelope)
          : current,
      );
    });
    const unsubscribeError = transport.onError?.((error) => {
      if (active) setOperationError(error.message);
    });

    void (async () => {
      try {
        await transport.ready();
        const [snapshotValue, commandValue] = await Promise.all([
          transport.call('session.snapshot'),
          transport.call('command.list'),
        ]);
        if (!isSnapshot(snapshotValue)) {
          throw new Error('The host returned an invalid session snapshot');
        }
        let next = fromSnapshot(snapshotValue);
        for (const event of bufferedEvents.splice(0)) {
          next = applyEnvelope(next, event as unknown as Envelope);
        }
        if (!active) return;
        readyForEvents = true;
        setCommands(normalizeCommands(commandValue));
        setProjection(next);
        setLoadError(null);
      } catch (error) {
        if (active) setLoadError(errorMessage(error));
      }
    })();

    return () => {
      active = false;
      unsubscribe();
      unsubscribeError?.();
    };
  }, [transport]);

  useInput((input, key) => {
    const customCtrlO = projection?.uiExtensions.shortcuts['ctrl+o'];
    if (
      key.eventType !== 'release' &&
      key.ctrl &&
      input.toLocaleLowerCase() === 'o' &&
      !customCtrlO
    ) {
      setDetailsExpanded((current) => !current);
    }
  });

  const requestFrontendExit = async (outcome?: Record<string, unknown>) => {
    if (exitRequested.current) return;
    exitRequested.current = true;
    setExiting(true);
    setOperationError(null);
    try {
      await transport.call('frontend.exit', outcome ? { outcome } : {});
      onExit?.();
    } catch (error) {
      exitRequested.current = false;
      setExiting(false);
      setOperationError(errorMessage(error));
    }
  };

  const invokeShortcut = async (shortcut: string) => {
    setOperationError(null);
    try {
      const result = await transport.call<{ invoked?: boolean; error?: { message?: string } }>(
        'ui.shortcut.invoke',
        { shortcut },
      );
      if (result.invoked === false) {
        throw new Error(result.error?.message || `Shortcut failed: ${shortcut}`);
      }
    } catch (error) {
      setOperationError(errorMessage(error));
    }
  };

  const chooseModel = async (provider: string) => {
    setSelector(null);
    setOperationError(null);
    try {
      const selected = await transport.call<Model>('model.select', { provider });
      setProjection((current) =>
        current
          ? {
              ...current,
              models: {
                current: selected,
                providers: current.models?.providers ?? [],
              },
            }
          : current,
      );
      setNotice(`Model: ${modelLabel(selected)}`);
    } catch (error) {
      setOperationError(errorMessage(error));
    }
  };

  const chooseSession = (path: string) => {
    setSelector(null);
    void requestFrontendExit({ next_session: path });
  };

  const openThemeSelector = () => {
    setSelector({
      kind: 'theme',
      initialValue: theme,
      originalTheme: theme,
      options: THEME_OPTIONS.map((option) => ({
        value: option.value,
        label: option.label,
        description: option.type === 'auto'
          ? 'Auto'
          : option.type[0]?.toLocaleUpperCase() + option.type.slice(1),
      })),
    });
  };

  const chooseTheme = async (
    nextTheme: string,
    fallbackTheme: ThemeSelection = theme,
  ) => {
    setSelector(null);
    setOperationError(null);
    try {
      const requestedTheme = normalizeThemeName(nextTheme);
      if (!requestedTheme) throw new Error(`Unknown theme: ${nextTheme}`);
      const result = await transport.call<CommandResult>('command.execute', {
        command: `/theme ${requestedTheme}`,
      });
      if (result.error) throw new Error(result.error);
      const selectedTheme = setActiveTheme(result.theme ?? requestedTheme);
      if (!selectedTheme) throw new Error(`Unknown theme: ${result.theme}`);
      setTheme(selectedTheme);
    } catch (error) {
      setActiveTheme(fallbackTheme);
      setTheme(fallbackTheme);
      setOperationError(errorMessage(error));
    }
  };

  const addLocalOutput = (command: string, output: unknown) => {
    const text = printableOutput(output);
    if (!text) return;
    localHistoryId.current += 1;
    setLocalHistory((current) => [
      ...current,
      {
        id: `local-command:${localHistoryId.current}`,
        type: 'info',
        text: `$ ${command}\n${text}`,
        timestamp: new Date().toISOString(),
      },
    ]);
  };

  const chooseTreeEntry = async (eventId: string) => {
    setSelector(null);
    setOperationError(null);
    const command = `/checkout ${eventId}`;
    try {
      const result = await transport.call<CommandResult>('command.execute', {
        command,
      });
      if (result.error) throw new Error(result.error);
      addLocalOutput(command, result.output);
    } catch (error) {
      setOperationError(errorMessage(error));
    }
  };

  const executeCommand = async (text: string) => {
    const name = commandName(text);
    if (name === 'quit') {
      await requestFrontendExit();
      return;
    }

    if (name === 'model') {
      const requested = commandArgument(text);
      if (requested) {
        await chooseModel(requested);
      } else if (projection) {
        const listed = await transport.call<ModelListResult>('model.list');
        setSelector({ kind: 'model', ...modelOptions(listed, projection) });
      }
      return;
    }

    if (name === 'theme') {
      const requested = commandArgument(text);
      if (!requested) {
        setOperationError(null);
        openThemeSelector();
        return;
      }
      const requestedTheme = normalizeThemeName(requested);
      if (!requestedTheme) {
        setOperationError(`Theme "${requested}" not found.`);
        openThemeSelector();
        return;
      }
      await chooseTheme(requestedTheme);
      return;
    }

    const result = await transport.call<CommandResult>('command.execute', {
      command: text,
    });
    if (result.error) throw new Error(result.error);
    const requestedSelector = selectorName(result.ui);
    if (requestedSelector === 'model-selector' && projection) {
      setSelector({ kind: 'model', ...modelOptions(result.output, projection) });
      return;
    }
    if (requestedSelector === 'session-selector') {
      setSelector({ kind: 'session', options: sessionOptions(result.output) });
      return;
    }
    if (requestedSelector === 'tree-selector') {
      setSelector({ kind: 'tree', options: treeOptions(result.output) });
      return;
    }
    if (requestedSelector === 'theme-selector') {
      const selectedTheme = setActiveTheme(result.theme);
      if (result.theme && selectedTheme) {
        setTheme(selectedTheme);
      } else {
        openThemeSelector();
      }
      return;
    }

    setNotice(null);
    addLocalOutput(text, result.output);
  };

  const submit = async (
    text: string,
    options: { deferUntilIdle: boolean },
  ) => {
    setOperationError(null);
    try {
      if (commandName(text)) {
        await executeCommand(text);
        return;
      }
      const busy = projection?.state.phase !== 'idle';
      const method = options.deferUntilIdle
        ? 'turn.follow-up'
        : busy
          ? 'turn.steer'
          : 'turn.submit';
      await transport.call(method, { message: text });
    } catch (error) {
      setComposer(text);
      setOperationError(errorMessage(error));
    }
  };

  const abort = async (reason: ComposerAbortReason = 'escape') => {
    if (!projection || projection.state.phase === 'idle') {
      setComposer('');
      if (reason === 'escape') {
        lastCtrlCAt.current = 0;
        return;
      }
      const now = Date.now();
      if (now - lastCtrlCAt.current <= 500) {
        lastCtrlCAt.current = 0;
        await requestFrontendExit();
      } else {
        lastCtrlCAt.current = now;
        setNotice('再按一次 Ctrl+C 退出');
      }
      return;
    }
    setOperationError(null);
    try {
      await transport.call('turn.abort');
    } catch (error) {
      setOperationError(errorMessage(error));
    }
  };

  const resolvePrompt = async (
    interactionId: string,
    resolution: { value: unknown } | { cancelled: true },
  ) => {
    if (resolvingPrompt) return;
    setResolvingPrompt(true);
    setOperationError(null);
    try {
      await transport.call('ui.prompt.resolve', {
        id: interactionId,
        ...resolution,
      });
      setProjection((current) =>
        current
          ? {
              ...current,
              interactions: current.interactions.filter(
                (entry) => entry.id !== interactionId,
              ),
            }
          : current,
      );
    } catch (error) {
      setOperationError(errorMessage(error));
    } finally {
      setResolvingPrompt(false);
    }
  };

  const resolveApproval = async (decision: ApprovalDecision) => {
    const interaction = projection?.interactions[0];
    if (!interaction || resolvingApproval) return;
    setResolvingApproval(true);
    setOperationError(null);
    try {
      await transport.call('interaction.resolve', {
        id: interaction.id,
        decision,
      });
      setProjection((current) =>
        current
          ? {
              ...current,
              interactions: current.interactions.filter(
                (entry) => entry.id !== interaction.id,
              ),
            }
          : current,
      );
    } catch (error) {
      setOperationError(errorMessage(error));
    } finally {
      setResolvingApproval(false);
    }
  };

  const activeInteraction = projection?.interactions[0];
  let dialog: ManagedDialog | null = null;
  const rawInteraction = objectValue(activeInteraction as unknown);
  const promptSource = objectValue(rawInteraction?.prompt) ?? rawInteraction;
  const interactionKind =
    stringValue(rawInteraction, 'kind') || stringValue(promptSource, 'kind');
  const approvalValues = activeInteraction?.items.map((item) => item.value) ?? [];
  const isApproval =
    interactionKind === 'approval' ||
    (interactionKind === 'select' &&
      approvalValues.includes('deny') &&
      approvalValues.every((value) =>
        ['allow', 'allow-session', 'deny'].includes(value),
      ));
  if (activeInteraction && isApproval) {
    dialog = {
      type: 'approval',
      interaction: activeInteraction,
      resolving: resolvingApproval,
      onResolve: (decision) => void resolveApproval(decision),
    };
  } else if (
    activeInteraction &&
    (interactionKind === 'select' || interactionKind === 'confirm')
  ) {
    const promptItems = promptOptionEntries(promptSource);
    const defaultValue = promptSource?.default;
    const initial = promptItems.find((item) =>
      JSON.stringify(item.value) === JSON.stringify(defaultValue),
    );
    const required =
      promptSource?.['required?'] === true || promptSource?.required === true;
    dialog = {
      type: 'selection',
      kind: 'command',
      title: activeInteraction.title,
      subtitle: activeInteraction.message || undefined,
      options: promptItems.map((item) => ({
        value: item.token,
        label: item.label,
      })),
      initialValue: initial?.token,
      isActive: !resolvingPrompt,
      onCancel: () => {
        if (required) setOperationError('This prompt requires a selection');
        else void resolvePrompt(activeInteraction.id, { cancelled: true });
      },
      onSelect: (token) => {
        const selected = promptItems.find((item) => item.token === token);
        if (selected) {
          void resolvePrompt(activeInteraction.id, { value: selected.value });
        }
      },
    };
  } else if (
    activeInteraction &&
    (interactionKind === 'input' || interactionKind === 'custom')
  ) {
    const required =
      promptSource?.['required?'] === true || promptSource?.required === true;
    const customJson = interactionKind === 'custom';
    dialog = {
      type: 'input',
      title: activeInteraction.title,
      subtitle: activeInteraction.message || undefined,
      placeholder: stringValue(promptSource, 'placeholder'),
      defaultValue: promptDefaultText(promptSource, customJson),
      customJson,
      required,
      resolving: resolvingPrompt,
      terminalWidth: Math.max(20, terminalSize.width),
      onCancel: () => {
        if (required) setOperationError('This prompt cannot be cancelled');
        else void resolvePrompt(activeInteraction.id, { cancelled: true });
      },
      onSubmit: (value) => {
        if (!customJson) {
          void resolvePrompt(activeInteraction.id, { value });
          return;
        }
        try {
          const parsed = JSON.parse(value) as unknown;
          void resolvePrompt(activeInteraction.id, { value: parsed });
        } catch (error) {
          setOperationError(`Invalid JSON: ${errorMessage(error)}`);
        }
      },
    };
  } else if (selector) {
    const title = {
      model: 'Select model',
      session: 'Resume session',
      theme: 'Select Theme',
      tree: 'Session tree',
    }[selector.kind];
    dialog = {
      type: 'selection',
      kind: selector.kind === 'tree' ? 'command' : selector.kind,
      title,
      options: selector.options,
      initialValue: selector.initialValue,
      onHighlight: selector.kind === 'theme'
        ? (value) => {
            const selectedTheme = setActiveTheme(value);
            if (selectedTheme) setTheme(selectedTheme);
          }
        : undefined,
      onCancel: () => {
        if (selector.kind === 'theme') {
          setActiveTheme(selector.originalTheme);
          setTheme(selector.originalTheme);
        }
        setSelector(null);
      },
      onSelect: (value) => {
        if (selector.kind === 'model') void chooseModel(value);
        else if (selector.kind === 'session') chooseSession(value);
        else if (selector.kind === 'tree') void chooseTreeEntry(value);
        else void chooseTheme(value, selector.originalTheme);
      },
    };
  }

  const allExpandedToolGroups = useMemo(() => {
    if (!detailsExpanded || !projection) return expandedToolGroups;
    return new Set([
      ...expandedToolGroups,
      ...projection.history
        .filter((item) => item.type === 'tool-group')
        .map((item) => item.id),
    ]);
  }, [detailsExpanded, expandedToolGroups, projection]);

  const width = Math.max(20, terminalSize.width);
  const height = Math.max(10, terminalSize.height);
  const model = modelLabel(projection?.models?.current);
  const provider = stringValue(
    projection?.models?.current as JsonObject | undefined,
    'provider',
  ) || 'Plugin';
  const phase = projection?.state.phase || (loadError ? 'error' : 'loading');
  const busy = Boolean(projection && projection.state.phase !== 'idle');
  const exitWarning = notice?.includes('Ctrl+C') ? notice : undefined;
  const inlineNotice = exitWarning ? null : notice;
  const widgetValues = Object.values(projection?.uiExtensions.widgets ?? {});
  const hasAboveExtensions = Boolean(
    projection &&
      (projection.notifications.length > 0 ||
        widgetValues.some((value) => widgetPlacement(value) === 'above-editor')),
  );
  const hasBelowExtensions = Boolean(
    projection &&
      (Object.keys(projection.uiExtensions.statuses).length > 0 ||
        widgetValues.some((value) => widgetPlacement(value) === 'below-editor')),
  );
  const aboveExtensionRows = hasAboveExtensions ? 3 : 0;
  const belowExtensionRows = hasBelowExtensions ? 2 : 0;
  const queueCount = projection?.queue.length ?? 0;
  const queueRows = queueCount > 0
    ? 2 + Math.min(3, queueCount) + (queueCount > 3 ? 1 : 0)
    : 0;
  const waitingForConfirmation = dialog?.type === 'approval';
  const confirmationRows = waitingForConfirmation ? 1 : 0;
  const loadingRows = busy
    ? width <= 30 || width >= 80
      ? 1
      : 2
    : 0;
  const statusRows = operationError || inlineNotice ? 1 : 0;
  const dialogHeight = dialog
    ? Math.max(6, Math.min(height - 4, Math.floor(height * 0.55)))
    : 0;
  const controlsHeight = dialog
    ? dialogHeight + confirmationRows + statusRows
    : 5 + loadingRows + queueRows + aboveExtensionRows +
      belowExtensionRows + statusRows;
  const contentHeight = Math.max(
    3,
    height - controlsHeight,
  );

  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {!projection && !loadError && (
          <Box paddingX={2} paddingY={1}>
            <Text color={qwenTheme.text.accent}>Loading session and commands…</Text>
          </Box>
        )}
        {!projection && loadError && (
          <Box borderStyle="round" borderColor={qwenTheme.status.error} paddingX={1}>
            <Text color={qwenTheme.status.error}>Failed to start TUI: {loadError}</Text>
          </Box>
        )}
        {projection && (
          <MainContent
            header={(
              <Header
                brand={brand}
                version={version}
                provider={provider}
                model={model}
                cwd={cwd}
                terminalWidth={Math.max(20, width - 1)}
              />
            )}
            history={[...projection.history, ...localHistory]}
            terminalWidth={width}
            reasoningExpanded={detailsExpanded}
            expandedToolGroupIds={allExpandedToolGroups}
            maxToolOutputLines={Math.max(4, Math.floor(contentHeight / 2))}
            viewportHeight={contentHeight}
            useVirtualScroll
            scrollFocused
            onToolGroupExpandedChange={(id, expanded) => {
              setExpandedToolGroups((current) => {
                const next = new Set(current);
                if (expanded) next.add(id);
                else next.delete(id);
                return next;
              });
            }}
          />
        )}
      </Box>

      {(operationError || inlineNotice) && (
        <Box paddingX={2}>
          <Text
            color={operationError ? qwenTheme.status.error : qwenTheme.text.link}
            wrap="truncate-end"
          >
            {operationError || inlineNotice}
          </Text>
        </Box>
      )}

      {projection && dialog ? (
        <>
          {waitingForConfirmation && (
            <LoadingIndicator
              busy={busy}
              mode="waiting-for-confirmation"
              terminalWidth={width}
            />
          )}
          <Box
            width={width}
            height={dialogHeight}
            flexDirection="column"
            overflow="hidden"
          >
            <DialogManager
              dialog={dialog}
              terminalHeight={dialogHeight}
              terminalWidth={width}
            />
          </Box>
        </>
      ) : projection ? (
        <>
          {hasAboveExtensions && (
            <ExtensionDisplay
              extensions={projection.uiExtensions}
              notifications={projection.notifications}
              placement="above-editor"
              terminalWidth={width}
              maxRows={aboveExtensionRows}
            />
          )}

          <LoadingIndicator busy={busy} phase={phase} terminalWidth={width} />
          <QueuedMessageDisplay items={projection.queue} />

          <Composer
            value={composer}
            onChange={setComposer}
            onSubmit={(text, options) => void submit(text, options)}
            onAbort={(reason) => void abort(reason)}
            onExitRequest={() => void requestFrontendExit()}
            shortcutNames={Object.keys(projection.uiExtensions.shortcuts)}
            onShortcut={(shortcut) => void invokeShortcut(shortcut)}
            busy={busy}
            commands={commands}
            placeholder={exiting ? '  Exiting…' : undefined}
            focus={!exiting}
          />

          {hasBelowExtensions && (
            <ExtensionDisplay
              extensions={projection.uiExtensions}
              notifications={projection.notifications}
              placement="below-editor"
              terminalWidth={width}
              maxRows={belowExtensionRows}
            />
          )}

          <Footer
            busy={busy}
            warning={exitWarning}
            queueCount={queueCount}
            terminalWidth={width}
          />
        </>
      ) : null}
    </Box>
  );
}

export default App;
