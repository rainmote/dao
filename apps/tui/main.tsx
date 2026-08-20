import { render, type Instance } from 'ink';

import { App } from './App.js';
import { openTerminal, type TerminalStreams } from './terminal.js';
import { PluginTransport } from './transport.js';

async function run(): Promise<void> {
  const transport = new PluginTransport({
    input: process.stdin,
    output: process.stdout,
    // Host commands and shortcuts may synchronously wait for a UI prompt.
    // Keep the client deadline just beyond the bridge's default 5 minute
    // interaction timeout so a thoughtful user does not orphan the caller.
    defaultTimeoutMs: 310_000,
  });
  let terminal: TerminalStreams | undefined;
  let view: Instance | undefined;

  const unmount = () => {
    view?.unmount();
  };

  try {
    terminal = openTerminal();
    view = render(
      <App transport={transport} onExit={unmount} />,
      {
        stdin: terminal.input,
        stdout: terminal.output,
        stderr: terminal.output,
        alternateScreen: true,
        incrementalRendering: true,
        exitOnCtrlC: false,
        patchConsole: false,
        interactive: true,
      },
    );

    process.once('SIGTERM', unmount);
    process.once('SIGHUP', unmount);
    await view.waitUntilExit();
  } finally {
    process.off('SIGTERM', unmount);
    process.off('SIGHUP', unmount);
    view?.unmount();
    view?.cleanup();
    transport.close();
    terminal?.close();
  }
}

void run().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  // stdout is exclusively the plugin protocol; diagnostics belong on stderr.
  process.stderr.write(`Ink TUI failed: ${message}\n`);
  process.exitCode = 1;
});
