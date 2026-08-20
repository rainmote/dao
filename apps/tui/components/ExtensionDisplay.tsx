import { Box, Text } from "ink";
import { qwenTheme } from "../theme.js";
import type { UiExtensions, UiNotification } from "../types.js";

export type ExtensionPlacement = "above-editor" | "below-editor";

export interface ExtensionDisplayProps {
  extensions: UiExtensions;
  notifications: readonly UiNotification[];
  placement: ExtensionPlacement;
  terminalWidth: number;
  maxNotifications?: number;
  maxRows?: number;
}

interface WidgetEntry {
  value: unknown;
  options?: { placement?: unknown };
}

function sanitize(value: string): string {
  return value
    .replace(/\u001b(?:(?:\[[0-?]*[ -/]*[@-~])|(?:\][^\u0007]*(?:\u0007|\u001b\\)))/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

function jsonText(value: unknown): string | null {
  try {
    const rendered = JSON.stringify(value);
    if (rendered === undefined || rendered === "null" || rendered === "{}" || rendered === "[]") {
      return null;
    }
    return sanitize(rendered);
  } catch {
    return null;
  }
}

function visibleLines(value: unknown): string[] {
  if (typeof value === "string") {
    return sanitize(value)
      .replace(/\r\n?/g, "\n")
      .split("\n")
      .filter((line) => line.trim().length > 0);
  }
  if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
    return value.flatMap((entry) => visibleLines(entry));
  }
  const rendered = jsonText(value);
  return rendered ? [rendered] : [];
}

function widgetEntry(value: unknown): WidgetEntry {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(record, "value")) {
      const options = record.options !== null && typeof record.options === "object"
        ? record.options as { placement?: unknown }
        : undefined;
      return { value: record.value, options };
    }
  }
  return { value };
}

function placementOf(entry: WidgetEntry): ExtensionPlacement {
  return entry.options?.placement === "below-editor" ? "below-editor" : "above-editor";
}

function statusValue(value: unknown): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(record, "value")) return record.value;
  }
  return value;
}

function notificationColor(level: string): string {
  switch (level.toLowerCase()) {
    case "error":
      return qwenTheme.status.error;
    case "warning":
    case "warn":
      return qwenTheme.status.warning;
    case "success":
      return qwenTheme.status.success;
    case "info":
      return qwenTheme.text.link;
    default:
      return qwenTheme.text.secondary;
  }
}

export function ExtensionDisplay({
  extensions,
  notifications,
  placement,
  terminalWidth,
  maxNotifications = 2,
  maxRows,
}: ExtensionDisplayProps) {
  const width = Number.isFinite(terminalWidth)
    ? Math.max(1, Math.floor(terminalWidth))
    : 80;
  const notificationLimit = Number.isFinite(maxNotifications)
    ? Math.max(0, Math.floor(maxNotifications))
    : 2;
  const widgetLines = Object.values(extensions.widgets).flatMap((raw) => {
    const entry = widgetEntry(raw);
    return placementOf(entry) === placement ? visibleLines(entry.value) : [];
  });
  const statuses = Object.entries(extensions.statuses).flatMap(([id, raw]) => {
    const lines = visibleLines(statusValue(raw));
    return lines.length > 0 ? [`${sanitize(id)}: ${lines.join(" ")}`] : [];
  });
  const validNotifications = notifications.filter(
    (notification) => typeof notification.text === "string" && notification.text.trim(),
  );
  const latestNotifications = notificationLimit > 0
    ? validNotifications.slice(-notificationLimit)
    : [];

  if (
    widgetLines.length === 0 &&
    (placement !== "above-editor" || latestNotifications.length === 0) &&
    (placement !== "below-editor" || statuses.length === 0)
  ) {
    return null;
  }

  return (
    <Box
      width={width}
      flexDirection="column"
      paddingX={width > 4 ? 2 : 0}
      maxHeight={maxRows === undefined ? undefined : Math.max(1, Math.floor(maxRows))}
      overflow="hidden"
    >
      {placement === "above-editor" && latestNotifications.map((notification) => (
        <Text
          key={notification.id}
          color={notificationColor(notification.level)}
          wrap="truncate"
        >
          {`• ${sanitize(notification.text)}`}
        </Text>
      ))}
      {widgetLines.map((line, index) => (
        <Text key={`${placement}-widget-${index}`} wrap="wrap">
          {line}
        </Text>
      ))}
      {placement === "below-editor" && statuses.length > 0 && (
        <Text color={qwenTheme.text.secondary} wrap="truncate">
          {statuses.join("  ·  ")}
        </Text>
      )}
    </Box>
  );
}
