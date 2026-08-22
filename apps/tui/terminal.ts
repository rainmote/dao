import { openSync } from "node:fs";
import { ReadStream, WriteStream } from "node:tty";

export interface TerminalStreams {
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  close(): void;
}

interface ListenerLimitEmitter {
  getMaxListeners(): number;
  setMaxListeners(count: number): unknown;
}

/**
 * Ink's virtualized rows each own a resize listener through useBoxMetrics.
 * Temporarily disable Node's generic listener-count warning for this one
 * stream, then restore its previous limit after Ink has removed the listeners.
 */
export function allowOwnedResizeListeners(
  output: ListenerLimitEmitter,
): () => void {
  const previousLimit = output.getMaxListeners();
  output.setMaxListeners(0);
  let restored = false;
  return () => {
    if (restored) return;
    restored = true;
    output.setMaxListeners(previousLimit);
  };
}

/**
 * Open the controlling terminal while process stdin/stdout remain dedicated to
 * the plugin protocol. Ink needs real tty streams for raw input, dimensions,
 * resize events, and cursor restoration.
 */
export function openTerminal(): TerminalStreams {
  const opened: number[] = [];
  let input: NodeJS.ReadStream;
  let output: NodeJS.WriteStream;

  if (process.stdin.isTTY) {
    input = process.stdin;
  } else {
    const fd = openSync(process.platform === "win32" ? "CONIN$" : "/dev/tty", "r");
    opened.push(fd);
    input = new ReadStream(fd);
  }

  if (process.stderr.isTTY) {
    output = process.stderr;
  } else if (process.stdout.isTTY) {
    output = process.stdout;
  } else {
    const fd = openSync(process.platform === "win32" ? "CONOUT$" : "/dev/tty", "w");
    opened.push(fd);
    output = new WriteStream(fd);
  }

  let closed = false;
  return {
    input,
    output,
    close() {
      if (closed) return;
      closed = true;
      if (input !== process.stdin) input.destroy();
      if (output !== process.stdout && output !== process.stderr) output.end();
      // tty streams own and close their descriptors when destroyed/ended.
      opened.length = 0;
    },
  };
}
