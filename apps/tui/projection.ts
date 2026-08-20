import type {
  AgentState,
  DurableEvent,
  Envelope,
  HistoryItem,
  HistoryItemAssistant,
  HistoryItemToolGroup,
  Interaction,
  JsonObject,
  Model,
  QueueItem,
  Snapshot,
  ToolCall,
  ToolCallStatus,
  ToolResult,
  UiExtensions,
  UiNotification,
  UiProjection,
} from "./types";

const EMPTY_UI_EXTENSIONS: UiExtensions = {
  statuses: {},
  widgets: {},
  shortcuts: {},
};

function valueAt(source: JsonObject | undefined, ...keys: string[]): unknown {
  for (const key of keys) {
    if (source && source[key] !== undefined) return source[key];
  }
  return undefined;
}

function textAt(source: JsonObject | undefined, ...keys: string[]): string | undefined {
  const value = valueAt(source, ...keys);
  return typeof value === "string" ? value : undefined;
}

function numberAt(source: JsonObject | undefined, ...keys: string[]): number | undefined {
  const value = valueAt(source, ...keys);
  return typeof value === "number" ? value : undefined;
}

function objectValue(value: unknown): JsonObject | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : undefined;
}

function normalizeAgentState(raw: JsonObject | undefined): AgentState {
  const phase = textAt(raw, "phase") || "idle";
  return {
    phase,
    runId: textAt(raw, "runId", "run-id", "run_id") || null,
    partialAssistant:
      textAt(raw, "partialAssistant", "partial-assistant", "partial_assistant") || "",
    partialReasoning:
      textAt(raw, "partialReasoning", "partial-reasoning", "partial_reasoning") || "",
    attempt: numberAt(raw, "attempt") ?? null,
    lastError: textAt(raw, "lastError", "last-error", "last_error") || null,
  };
}

function normalizeInteraction(value: Interaction | JsonObject): Interaction | null {
  const raw = value as unknown as JsonObject;
  const id = textAt(raw, "id");
  if (!id) return null;
  const items = Array.isArray(raw.items)
    ? raw.items.flatMap((item) => {
        const entry = objectValue(item);
        const label = textAt(entry, "label");
        const choice = textAt(entry, "value");
        return label && choice ? [{ label, value: choice }] : [];
      })
    : [];
  const approval =
    items.length > 0 &&
    items.every((item) => ["allow", "allow-session", "deny"].includes(item.value));
  return {
    id,
    kind: approval ? "approval" : textAt(raw, "kind"),
    title: textAt(raw, "title") || "Confirmation required",
    message: textAt(raw, "message") || "",
    createdAt: textAt(raw, "createdAt", "created-at", "created_at"),
    items,
    default: textAt(raw, "default") || items[0]?.value || "deny",
    prompt: { ...raw },
  };
}

function normalizeQueue(value: unknown): QueueItem[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item, index) => {
    const raw = objectValue(item);
    const message = textAt(raw, "message");
    if (!raw || message === undefined) return [];
    const kind = textAt(raw, "kind") || "follow-up";
    const id = textAt(raw, "id") || `${kind}:${message}:${index}`;
    if (seen.has(id)) return [];
    seen.add(id);
    return [{ id, kind, message }];
  });
}

function normalizeInteractions(values: Array<Interaction | JsonObject>): Interaction[] {
  const seen = new Set<string>();
  return values.flatMap((value) => {
    const interaction = normalizeInteraction(value);
    if (!interaction || seen.has(interaction.id)) return [];
    seen.add(interaction.id);
    return [interaction];
  });
}

function normalizeUiExtensions(value: unknown): UiExtensions {
  const snapshot = objectValue(value);
  const registries = objectValue(snapshot?.registries) || snapshot;
  return {
    theme: textAt(snapshot, "theme"),
    statuses: objectValue(registries?.statuses) || {},
    widgets: objectValue(registries?.widgets) || {},
    shortcuts: objectValue(registries?.shortcuts) || {},
  };
}

function normalizeNotification(
  value: unknown,
  fallbackId: string,
  timestamp?: string,
): UiNotification {
  const data = objectValue(value) || { text: typeof value === "string" ? value : String(value ?? "") };
  return {
    id: textAt(data, "id") || fallbackId,
    text: textAt(data, "text", "message") || "Notification",
    level: textAt(data, "level") || "info",
    timestamp,
    data,
  };
}

function contentText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!Array.isArray(value)) return value == null ? "" : String(value);
  return value
    .flatMap((part) => {
      if (typeof part === "string") return [part];
      const entry = objectValue(part);
      const text = textAt(entry, "text", "content");
      return text === undefined ? [] : [text];
    })
    .join("");
}

function removeStreamingAssistant(history: HistoryItem[]): HistoryItem[] {
  return history.filter((item) => item.type !== "assistant" || !item.streaming);
}

function syncStreamingAssistant(projection: UiProjection): UiProjection {
  const history = removeStreamingAssistant(projection.history);
  const { partialAssistant: text, partialReasoning: reasoning } = projection.state;
  if (projection.state.phase !== "model" || (!text && !reasoning)) {
    return history === projection.history ? projection : { ...projection, history };
  }
  const item: HistoryItemAssistant = {
    id: `stream:${projection.state.runId || "active"}`,
    type: "assistant",
    text,
    reasoning: reasoning || undefined,
    streaming: true,
  };
  return { ...projection, history: [...history, item] };
}

function addMessage(
  projection: UiProjection,
  event: Pick<DurableEvent, "id" | "at" | "data">,
): UiProjection {
  const message = objectValue(event.data.message);
  const role = textAt(message, "role");
  if (role === "tool" || !role) return projection;
  const text = contentText(message?.content);
  if (role === "user") {
    return {
      ...projection,
      history: [...projection.history, { id: event.id, type: "user", text, timestamp: event.at }],
    };
  }
  if (role !== "assistant") return projection;
  const live = projection.history.find(
    (item): item is HistoryItemAssistant => item.type === "assistant" && Boolean(item.streaming),
  );
  const reasoning =
    textAt(message, "reasoning", "reasoning_content", "reasoning-content") ||
    live?.reasoning ||
    projection.state.partialReasoning;
  const history = removeStreamingAssistant(projection.history);
  const nextState = {
    ...projection.state,
    partialAssistant: "",
    partialReasoning: "",
  };
  if (!text && !reasoning) return { ...projection, history, state: nextState };
  return {
    ...projection,
    state: nextState,
    history: [
      ...history,
      {
        id: event.id,
        type: "assistant",
        text,
        reasoning: reasoning || undefined,
        timestamp: event.at,
      },
    ],
  };
}

function toolStatus(data: JsonObject, completed: boolean): ToolCallStatus {
  if (!completed) return "pending";
  const details = objectValue(data.details);
  const exitCode = numberAt(details, "exit-code", "exit_code", "exitCode");
  return data.ok === false || data["is-error"] === true || data.is_error === true ||
    (exitCode !== undefined && exitCode !== 0)
    ? "error"
    : "success";
}

function findTool(history: HistoryItem[], callId: string): ToolCall | undefined {
  for (const item of history) {
    if (item.type !== "tool-group") continue;
    const tool = item.tools.find((entry) => entry.callId === callId);
    if (tool) return tool;
  }
  return undefined;
}

function updateTool(
  history: HistoryItem[],
  callId: string,
  update: (tool: ToolCall) => ToolCall,
): HistoryItem[] {
  return history.map((item) =>
    item.type === "tool-group" && item.tools.some((tool) => tool.callId === callId)
      ? { ...item, tools: item.tools.map((tool) => (tool.callId === callId ? update(tool) : tool)) }
      : item,
  );
}

function addToolCall(
  projection: UiProjection,
  event: Pick<DurableEvent, "id" | "at" | "data">,
): UiProjection {
  const callId = textAt(event.data, "call-id", "call_id", "callId");
  if (!callId) return projection;
  const existing = findTool(projection.history, callId);
  if (existing) {
    return {
      ...projection,
      history: updateTool(projection.history, callId, (tool) => ({
        ...tool,
        name: textAt(event.data, "name") || tool.name,
        arguments: valueAt(event.data, "arguments", "args") ?? tool.arguments,
      })),
    };
  }
  const tool: ToolCall = {
    callId,
    name: textAt(event.data, "name") || "unknown-tool",
    arguments: valueAt(event.data, "arguments", "args") ?? {},
    status: "pending",
    updates: [],
  };
  const last = projection.history.at(-1);
  if (last?.type === "tool-group") {
    const group: HistoryItemToolGroup = { ...last, tools: [...last.tools, tool] };
    return { ...projection, history: [...projection.history.slice(0, -1), group] };
  }
  return {
    ...projection,
    history: [
      ...projection.history,
      { id: `tool-group:${event.id}`, type: "tool-group", tools: [tool], timestamp: event.at },
    ],
  };
}

function ensureTool(projection: UiProjection, data: JsonObject, id: string, at?: string): UiProjection {
  const callId = textAt(data, "call-id", "call_id", "callId");
  if (!callId || findTool(projection.history, callId)) return projection;
  return addToolCall(projection, { id, at: at || new Date(0).toISOString(), data });
}

function applyToolUpdate(projection: UiProjection, data: JsonObject, envelopeId: string): UiProjection {
  const callId = textAt(data, "call-id", "call_id", "callId");
  if (!callId) return projection;
  const withTool = ensureTool(projection, data, envelopeId);
  const update = valueAt(data, "update");
  return {
    ...withTool,
    history: updateTool(withTool.history, callId, (tool) => ({
      ...tool,
      name: textAt(data, "name") || tool.name,
      executionId:
        textAt(data, "execution-id", "execution_id", "executionId") || tool.executionId,
      status: "running",
      updates: update === undefined ? tool.updates : [...tool.updates, update],
    })),
  };
}

function applyToolResult(projection: UiProjection, data: JsonObject, envelopeId: string): UiProjection {
  const callId = textAt(data, "call-id", "call_id", "callId");
  if (!callId) return projection;
  const withTool = ensureTool(projection, data, envelopeId);
  const result: ToolResult = {};
  if (typeof data.ok === "boolean") result.ok = data.ok;
  const content = textAt(data, "content");
  const error = textAt(data, "error");
  const durationMs = numberAt(data, "duration-ms", "duration_ms", "durationMs");
  if (content !== undefined) result.content = content;
  if (error !== undefined) result.error = error;
  if (data.details !== undefined) result.details = data.details;
  if (durationMs !== undefined) result.durationMs = durationMs;
  return {
    ...withTool,
    history: updateTool(withTool.history, callId, (tool) => ({
      ...tool,
      name: textAt(data, "name") || tool.name,
      status: toolStatus(data, true),
      result,
    })),
  };
}

function addError(projection: UiProjection, id: string, text: string, timestamp?: string): UiProjection {
  const last = projection.history.at(-1);
  if (
    projection.history.some((item) => item.id === id) ||
    (last?.type === "error" && last.text === text)
  ) {
    return { ...projection, lastRunError: text };
  }
  return {
    ...projection,
    lastRunError: text,
    history: [...projection.history, { id, type: "error", text, timestamp }],
  };
}

function addInfo(projection: UiProjection, id: string, text: string, timestamp?: string): UiProjection {
  if (projection.history.some((item) => item.id === id)) return projection;
  return {
    ...projection,
    history: [...projection.history, { id, type: "info", text, timestamp }],
  };
}

function selectModel(projection: UiProjection, data: JsonObject): UiProjection {
  const providerId = textAt(data, "provider", "id");
  const modelName = textAt(data, "model");
  const catalog = projection.models || { current: null, providers: [] };
  const matched = providerId
    ? catalog.providers.find((entry) => entry.id === providerId) ||
      catalog.providers.find((entry) => entry.provider === providerId)
    : catalog.current;
  if (!providerId && !modelName && !matched) return projection;
  const base = matched || (providerId ? undefined : catalog.current);
  const current: Model = {
    ...(base || {}),
    id: matched?.id || providerId || catalog.current?.id || modelName || "selected",
  };
  if (providerId) current.provider = matched?.provider || providerId;
  if (modelName) current.model = modelName;
  return { ...projection, models: { ...catalog, current } };
}

function addNotification(
  projection: UiProjection,
  value: unknown,
  fallbackId: string,
  timestamp?: string,
): UiProjection {
  const notification = normalizeNotification(value, fallbackId, timestamp);
  if (projection.notifications.some((entry) => entry.id === notification.id)) return projection;
  return {
    ...projection,
    notifications: [...projection.notifications, notification].slice(-20),
  };
}

function applyDurableEvent(projection: UiProjection, event: DurableEvent): UiProjection {
  switch (event.type) {
    case "message":
      return addMessage(projection, event);
    case "tool/call":
      return addToolCall(projection, event);
    case "tool/result":
      return applyToolResult(projection, event.data, event.id);
    case "agent/error":
      return addError(
        projection,
        event.id,
        textAt(event.data, "message") || "Agent run failed",
        event.at,
      );
    case "agent/aborted":
      return {
        ...projection,
        history: [
          ...projection.history,
          { id: event.id, type: "info", text: "Agent run aborted", timestamp: event.at },
        ],
      };
    case "session/clear":
      return { ...projection, history: [] };
    case "session/compaction": {
      const replacements = valueAt(event.data, "replacement_messages", "replacement-messages");
      if (!Array.isArray(replacements)) return projection;
      return replacements.reduce<UiProjection>(
        (current, message, index) =>
          addMessage(current, {
            id: `${event.id}:message:${index}`,
            at: event.at,
            data: { message },
          }),
        { ...projection, history: [] },
      );
    }
    default:
      return projection;
  }
}

function envelopeKey(envelope: Envelope): string | null {
  return typeof envelope.hostSeq === "number" ? `host:${envelope.hostSeq}` : null;
}

function withSeen(projection: UiProjection, ...ids: Array<string | null>): UiProjection {
  const seenEventIds = new Set(projection.seenEventIds);
  ids.forEach((id) => {
    if (id) seenEventIds.add(id);
  });
  return { ...projection, seenEventIds };
}

export function fromSnapshot(snapshot: Snapshot): UiProjection {
  let projection: UiProjection = {
    sessionId: snapshot.session_id,
    cursor: snapshot.cursor,
    history: [],
    state: normalizeAgentState(snapshot.state),
    queue: normalizeQueue(valueAt(snapshot.state, "queue")),
    interactions: normalizeInteractions(snapshot.interactions || []),
    models: snapshot.models,
    uiExtensions: EMPTY_UI_EXTENSIONS,
    notifications: [],
    lastRunError: null,
    seenEventIds: new Set<string>(),
  };
  const events = [...snapshot.events].sort((left, right) => left.seq - right.seq);
  for (const event of events) {
    if (projection.seenEventIds.has(event.id)) continue;
    projection = applyDurableEvent(projection, event);
    projection = withSeen(projection, event.id);
    projection = { ...projection, cursor: Math.max(projection.cursor, event.seq) };
  }
  return syncStreamingAssistant(projection);
}

export function applyEnvelope(projection: UiProjection, envelope: Envelope): UiProjection {
  const hostKey = envelopeKey(envelope);
  if (hostKey && projection.seenEventIds.has(hostKey)) return projection;

  if (envelope.durable) {
    const eventId =
      envelope.event_id ||
      (typeof envelope.seq === "number"
        ? `durable:${envelope.session_id || projection.sessionId}:${envelope.seq}`
        : null);
    if (!eventId || projection.seenEventIds.has(eventId)) {
      return hostKey ? withSeen(projection, hostKey) : projection;
    }
    const event: DurableEvent = {
      id: eventId,
      seq: envelope.seq ?? projection.cursor,
      at: envelope.at || new Date().toISOString(),
      type: envelope.event || "unknown",
      data: envelope.data || {},
      run_id: envelope.run_id,
    };
    const applied = applyDurableEvent(projection, event);
    return withSeen(
      { ...applied, cursor: Math.max(applied.cursor, event.seq) },
      eventId,
      hostKey,
    );
  }

  let next = projection;
  const data = envelope.data || {};
  switch (envelope.event) {
    case "agent/state":
      next = syncStreamingAssistant({ ...projection, state: normalizeAgentState(data) });
      break;
    case "llm/stream": {
      const streamType = textAt(data, "type");
      const delta = textAt(data, "delta");
      if (delta && (streamType === "text/delta" || streamType === "reasoning/delta")) {
        const field = streamType === "text/delta" ? "partialAssistant" : "partialReasoning";
        next = syncStreamingAssistant({
          ...projection,
          state: {
            ...projection.state,
            phase: "model",
            [field]: projection.state[field] + delta,
          },
        });
      }
      break;
    }
    case "tool.execution/update":
      next = applyToolUpdate(
        projection,
        data,
        hostKey || `live:${textAt(data, "call-id", "call_id", "callId") || "tool"}`,
      );
      break;
    case "tool.execution/end":
      next = applyToolResult(
        projection,
        data,
        hostKey || `live:${textAt(data, "call-id", "call_id", "callId") || "tool"}`,
      );
      break;
    case "queue/changed":
      next = { ...projection, queue: normalizeQueue(data.queue) };
      break;
    case "interaction/request": {
      const interaction = normalizeInteraction(data);
      if (interaction && !projection.interactions.some((entry) => entry.id === interaction.id)) {
        next = { ...projection, interactions: [...projection.interactions, interaction] };
      }
      break;
    }
    case "interaction/resolved": {
      const id = textAt(data, "id");
      if (id) {
        next = {
          ...projection,
          interactions: projection.interactions.filter((entry) => entry.id !== id),
        };
      }
      break;
    }
    case "llm/model-selected":
      next = selectModel(projection, data);
      break;
    case "ui/extensions": {
      const kind = textAt(data, "kind");
      if (kind === "snapshot") {
        next = {
          ...projection,
          uiExtensions: normalizeUiExtensions(data.snapshot),
        };
      } else if (kind === "notification") {
        next = addNotification(
          projection,
          data.notification,
          `notification:${hostKey || textAt(objectValue(data.notification), "id") || "latest"}`,
          envelope.at,
        );
      }
      break;
    }
    case "ui/run-error": {
      const error = objectValue(data.error);
      const message = textAt(data, "message") || textAt(error, "message") || "UI action failed";
      next = addError(
        projection,
        `ui-run-error:${textAt(data, "id") || hostKey || message}`,
        message,
        envelope.at,
      );
      break;
    }
    case "subagent/start": {
      const id = textAt(data, "id") || hostKey || "unknown";
      const label = textAt(data, "label") || id;
      next = addInfo(
        projection,
        `subagent:${id}:start`,
        `Subagent ${label} started`,
        envelope.at,
      );
      break;
    }
    case "subagent/end": {
      const id = textAt(data, "id") || hostKey || "unknown";
      const reason = textAt(data, "stop-reason", "stop_reason", "stopReason") || "completed";
      const error = textAt(data, "error");
      next = addInfo(
        projection,
        `subagent:${id}:end`,
        error ? `Subagent ${id} ended with ${reason}: ${error}` : `Subagent ${id} ${reason}`,
        envelope.at,
      );
      break;
    }
    case "remote/run-result": {
      if (data.ok === false) {
        const error = objectValue(data.error);
        next = addError(
          projection,
          `run-error:${textAt(data, "request_id", "request-id") || hostKey || "latest"}`,
          textAt(error, "message") || "Agent run failed",
          envelope.at,
        );
      } else if (data.ok === true) {
        next = { ...projection, lastRunError: null };
      }
      break;
    }
  }

  if (envelope.type === "run-result") {
    if (envelope.ok === false) {
      next = addError(
        next,
        `run-error:${hostKey || "latest"}`,
        envelope.error?.message || "Agent run failed",
        envelope.at,
      );
    } else if (envelope.ok === true) {
      next = { ...next, lastRunError: null };
    }
  }
  return hostKey ? withSeen(next, hostKey) : next;
}
