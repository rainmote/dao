# Qwen-style Ink TUI plugin

## Goal

Move the interactive terminal surface to TypeScript, React, and Ink while
keeping the Babashka kernel as the sole owner of the agent runtime, session,
tools, policy, approvals, and plugin lifecycle. The new frontend should follow
Qwen Code's current information architecture and interaction model without
importing its core-specific configuration and command code.

## Decision

The frontend is a child process owned by `agent.plugins.tui-ink`:

```text
bb agent
  └─ Babashka kernel
       ├─ session / runtime / tools / policy
       ├─ remote method registry
       └─ tui-ink plugin
            └─ Node + React + Ink renderer
```

The child process uses the controlling terminal directly for Ink input and
rendering. Its stdin and stdout are reserved for a private, line-delimited JSON
channel to the plugin. This keeps one agent context and one session writer,
unlike a frontend that starts a second RPC worker.

The Clojure TUI remains available as `agent.plugins.tui` during migration. A
profile selects exactly one interactive frontend plugin.

## Boundary

The transport has three parent-to-child envelopes:

- `ready`: protocol version, session id, and registered method names;
- `response`: success or failure for a request id;
- `event`: durable session or live runtime event.

The child sends only `request` envelopes containing an id, method, and params.
Methods are dispatched through `:remote/registry`, so WebUI and TUI share the
same frontend-neutral commands. Frontend lifecycle controls that do not belong
in the public remote API may be handled by the plugin adapter itself.

The terminal process never receives credentials, model adapters, executable
tool functions, or unrestricted filesystem services.

## UI state

The TypeScript frontend reduces the replayable `session.snapshot` plus live
events into a UI-only projection:

- durable user and assistant messages;
- tool call/update/result groups keyed by call id;
- pending assistant text and reasoning;
- run phase, steer and follow-up queues;
- pending approvals and other interactions;
- selected model, notices, and run errors.

React components consume this projection. They do not understand Clojure
plugin contexts or provider implementations.

## Implemented Qwen alignment

The current surface includes:

- a scrolling six-row wordmark/header panel and Qwen's default dark semantic tokens;
- `>`, `◆`, `∵`, and `∴` message hierarchy;
- full-width horizontal composer rules, `> ` prompt, and software cursor;
- dialogs that replace the composer/footer control region while open;
- Markdown assistant rendering;
- per-model-step tool batches with one mixed search/read/list sentence, Qwen display names for action tools, and full `Ctrl+O` detail;
- six-state pending/confirming/running/success/error/canceled projection with exactly-once live completion and model-ordered durable results;
- animated response/tool indicators, elapsed time, phrase rotation, and a static approval-wait row;
- streaming assistant and reasoning display;
- multiline Unicode-safe input and software cursor;
- slash completion and input history;
- steer, follow-up, abort, model selection, and approvals;
- bounded selectors that fit the terminal;
- alternate-screen rendering and terminal restoration;
- snapshot replay and live event deduplication;
- JSON-safe status, widget, and notification projection;
- host-side registered shortcut invocation over the remote method boundary;
- measured, bounded long-history virtualization and scroll-follow behavior;
- Qwen Code's built-in theme registry, live highlight preview, cancel rollback,
  and host-synchronized theme selection.

Mouse input, path completion, image clipboard input, voice, embedded shell,
and Qwen-specific commands remain separate follow-up layers. They must extend
this projection/transport boundary instead of coupling
the UI to the agent runtime. Statuses, widgets, and notifications cross the
boundary as JSON-safe display values. Registered shortcut handlers remain in
the host and the child invokes them by name. Host message, entry, and tool
renderer functions are not dynamically executable React components in the
current child; function-valued fields use an explicit unavailable placeholder.
Select, confirm, single-line input, and custom JSON prompts cross the
frontend-neutral prompt boundary.

## Failure and cleanup

- If the child cannot start, plugin startup fails with the attempted command.
- Invalid child JSON receives an error response and does not terminate the
  agent unless the stream itself closes.
- EOF or child exit aborts the active turn and resolves pending approvals as
  deny.
- Plugin disposal closes subscriptions, asks the UI to shut down, restores the
  terminal, and then terminates a child that did not exit.
- stdout remains protocol-only; diagnostics use stderr.
- The child defaults to production Ink rendering with `TERM=xterm-256color`
  and `FORCE_COLOR=1`, while explicit plugin `:env` values remain authoritative.

## Verification

1. Pure projection and text-buffer tests.
2. Transport tests with in-memory streams and out-of-order responses.
3. Ink component snapshots for history, tools, dialogs, and constrained sizes.
4. Babashka tests for plugin registration, RPC dispatch, interaction cleanup,
   and child lifecycle.
5. A pseudo-terminal smoke test using the offline mock profile.
