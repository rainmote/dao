export type JsonObject = Record<string, unknown>;

export interface DurableEvent {
  id: string;
  seq: number;
  at: string;
  type: string;
  data: JsonObject;
  parent_id?: string;
  run_id?: string;
}

export interface AgentState {
  phase: "idle" | "model" | "tool" | "retry" | "compacting" | string;
  runId: string | null;
  partialAssistant: string;
  partialReasoning: string;
  attempt: number | null;
  lastError: string | null;
}

export interface QueueItem {
  id: string;
  kind: "steer" | "follow-up" | string;
  message: string;
}

export interface InteractionChoice {
  label: string;
  value: "allow" | "allow-session" | "deny" | string;
}

export interface Interaction {
  id: string;
  kind?: "approval" | "select" | "confirm" | "input" | "custom" | string;
  title: string;
  message: string;
  createdAt?: string;
  items: InteractionChoice[];
  default: InteractionChoice["value"];
  prompt?: JsonObject;
}

export interface Model {
  id: string;
  provider?: string;
  model?: string;
  description?: string;
}

export interface UiExtensions {
  theme?: string;
  statuses: JsonObject;
  widgets: JsonObject;
  shortcuts: JsonObject;
}

export interface UiNotification {
  id: string;
  text: string;
  level: string;
  timestamp?: string;
  data: JsonObject;
}

export interface Snapshot {
  session_id: string;
  path: string;
  cursor: number;
  events: DurableEvent[];
  state: JsonObject;
  models: { current: Model | null; providers: Model[] } | null;
  interactions: Array<Interaction | JsonObject>;
}

export interface Envelope {
  type?: "event" | "run-result" | "response" | "ready" | string;
  version?: number;
  hostSeq?: number;
  event?: string;
  event_id?: string;
  session_id?: string;
  run_id?: string;
  seq?: number;
  durable?: boolean;
  at?: string;
  data?: JsonObject;
  ok?: boolean;
  result?: unknown;
  error?: { message?: string; data?: unknown };
}

export type ToolCallStatus = "pending" | "running" | "success" | "error";

export interface ToolResult {
  ok?: boolean;
  content?: string;
  error?: string;
  details?: unknown;
  durationMs?: number;
}

export interface ToolCall {
  callId: string;
  name: string;
  arguments: unknown;
  status: ToolCallStatus;
  updates: unknown[];
  executionId?: string;
  result?: ToolResult;
}

interface HistoryItemBase {
  id: string;
  timestamp?: string;
}

export interface HistoryItemUser extends HistoryItemBase {
  type: "user";
  text: string;
}

export interface HistoryItemAssistant extends HistoryItemBase {
  type: "assistant";
  text: string;
  reasoning?: string;
  streaming?: boolean;
}

export interface HistoryItemToolGroup extends HistoryItemBase {
  type: "tool-group";
  tools: ToolCall[];
}

export interface HistoryItemInfo extends HistoryItemBase {
  type: "info";
  text: string;
}

export interface HistoryItemError extends HistoryItemBase {
  type: "error";
  text: string;
}

export type HistoryItem =
  | HistoryItemUser
  | HistoryItemAssistant
  | HistoryItemToolGroup
  | HistoryItemInfo
  | HistoryItemError;

export interface UiProjection {
  sessionId: string;
  cursor: number;
  history: HistoryItem[];
  state: AgentState;
  queue: QueueItem[];
  interactions: Interaction[];
  models: { current: Model | null; providers: Model[] } | null;
  uiExtensions: UiExtensions;
  notifications: UiNotification[];
  lastRunError: string | null;
  seenEventIds: ReadonlySet<string>;
}
