import type { AgentState, DurableEvent, HostEvent, Interaction, SessionSnapshot } from "./types";

export interface Projection {
  events: DurableEvent[];
  state: AgentState;
  interactions: Interaction[];
  liveTools: Record<string, Record<string, unknown>>;
  lastRunError: string | null;
}

export function fromSnapshot(snapshot: SessionSnapshot): Projection {
  return {
    events: [...snapshot.events].sort((a, b) => a.seq - b.seq),
    state: snapshot.state,
    interactions: snapshot.interactions || [],
    liveTools: {},
    lastRunError: null,
  };
}

export function applyHostEvent(projection: Projection, envelope: HostEvent): Projection {
  if (envelope.durable && envelope.event_id && envelope.seq) {
    if (projection.events.some((event) => event.id === envelope.event_id)) return projection;
    const event: DurableEvent = {
      id: envelope.event_id,
      seq: envelope.seq,
      at: envelope.at || new Date().toISOString(),
      type: envelope.event || "unknown",
      data: envelope.data || {},
    };
    return { ...projection, events: [...projection.events, event].sort((a, b) => a.seq - b.seq) };
  }
  if (envelope.event === "agent/state") {
    return { ...projection, state: { phase: "idle", ...envelope.data } as unknown as AgentState };
  }
  if (envelope.event === "interaction/request") {
    const interaction = envelope.data as unknown as Interaction;
    return projection.interactions.some((entry) => entry.id === interaction.id)
      ? projection
      : { ...projection, interactions: [...projection.interactions, interaction] };
  }
  if (envelope.event === "interaction/resolved") {
    return {
      ...projection,
      interactions: projection.interactions.filter((entry) => entry.id !== envelope.data?.id),
    };
  }
  if (envelope.event === "tool.execution/update") {
    const callId = String(envelope.data?.["call-id"] || envelope.data?.call_id || "");
    return callId ? {
      ...projection,
      liveTools: { ...projection.liveTools, [callId]: envelope.data || {} },
    } : projection;
  }
  if (envelope.event === "remote/run-result" && envelope.data?.ok === false) {
    const error = envelope.data.error as { message?: string } | undefined;
    return { ...projection, lastRunError: error?.message || "Agent run failed" };
  }
  return projection;
}

export function visibleEvents(events: DurableEvent[]): DurableEvent[] {
  let start = 0;
  events.forEach((event, index) => {
    if (event.type === "session/clear") start = index + 1;
  });
  return events.slice(start).filter((event) => !event.type.startsWith("session/"));
}
