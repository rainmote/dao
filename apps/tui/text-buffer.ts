/**
 * The cursor is a UTF-16 offset because that composes naturally with
 * JavaScript's slice APIs. Every public operation snaps it to an
 * Intl.Segmenter grapheme boundary, so a cursor can never split a surrogate
 * pair, combining sequence, flag, or ZWJ emoji.
 */
export interface TextBufferState {
  readonly text: string;
  readonly cursor: number;
  /** Logical grapheme column retained while moving through shorter lines. */
  readonly preferredColumn: number | null;
}

export type CursorDirection =
  | 'left'
  | 'right'
  | 'up'
  | 'down'
  | 'home'
  | 'end';

export interface CursorLocation {
  readonly line: number;
  readonly column: number;
  readonly lineStart: number;
  readonly lineEnd: number;
}

const graphemeSegmenter = new Intl.Segmenter(undefined, {
  granularity: 'grapheme',
});

export function graphemes(text: string): string[] {
  return Array.from(graphemeSegmenter.segment(text), ({ segment }) => segment);
}

export function graphemeBoundaries(text: string): number[] {
  const boundaries = [0];
  for (const { index, segment } of graphemeSegmenter.segment(text)) {
    const end = index + segment.length;
    if (end !== boundaries[boundaries.length - 1]) {
      boundaries.push(end);
    }
  }
  return boundaries;
}

/** Snap an arbitrary string offset backward to the nearest safe boundary. */
export function normalizeCursor(text: string, cursor: number): number {
  const target = Math.max(0, Math.min(text.length, Math.trunc(cursor)));
  let previous = 0;
  for (const boundary of graphemeBoundaries(text)) {
    if (boundary === target) return boundary;
    if (boundary > target) return previous;
    previous = boundary;
  }
  return text.length;
}

export function createTextBuffer(
  text = '',
  cursor: number = text.length,
): TextBufferState {
  return {
    text,
    cursor: normalizeCursor(text, cursor),
    preferredColumn: null,
  };
}

/** Reconcile controlled text with a cursor retained by the view. */
export function reconcileTextBuffer(
  state: TextBufferState,
  text: string,
): TextBufferState {
  if (state.text === text) {
    const cursor = normalizeCursor(text, state.cursor);
    return cursor === state.cursor ? state : { ...state, cursor };
  }

  return {
    text,
    cursor: normalizeCursor(text, Math.min(state.cursor, text.length)),
    preferredColumn: null,
  };
}

function boundariesAround(text: string, cursor: number): {
  previous: number;
  current: number;
  next: number;
} {
  const current = normalizeCursor(text, cursor);
  const boundaries = graphemeBoundaries(text);
  const index = boundaries.indexOf(current);
  return {
    previous: boundaries[Math.max(0, index - 1)] ?? 0,
    current,
    next: boundaries[Math.min(boundaries.length - 1, index + 1)] ?? text.length,
  };
}

export function insertText(
  state: TextBufferState,
  insertedText: string,
): TextBufferState {
  const cursor = normalizeCursor(state.text, state.cursor);
  // Terminals commonly paste CRLF even on Unix. Internally one newline is one
  // cursor unit and one rendered line break.
  const normalizedText = insertedText.replace(/\r\n?/g, '\n');
  const text =
    state.text.slice(0, cursor) +
    normalizedText +
    state.text.slice(cursor);
  return {
    text,
    cursor: cursor + normalizedText.length,
    preferredColumn: null,
  };
}

export function insertNewline(state: TextBufferState): TextBufferState {
  return insertText(state, '\n');
}

export function deleteBackward(state: TextBufferState): TextBufferState {
  const { previous, current } = boundariesAround(state.text, state.cursor);
  if (current === 0) return state;
  return {
    text: state.text.slice(0, previous) + state.text.slice(current),
    cursor: previous,
    preferredColumn: null,
  };
}

export function deleteForward(state: TextBufferState): TextBufferState {
  const { current, next } = boundariesAround(state.text, state.cursor);
  if (current === state.text.length) return state;
  return {
    text: state.text.slice(0, current) + state.text.slice(next),
    cursor: current,
    preferredColumn: null,
  };
}

export function getCursorLocation(state: TextBufferState): CursorLocation {
  const cursor = normalizeCursor(state.text, state.cursor);
  const lineStart =
    cursor === 0 ? 0 : state.text.lastIndexOf('\n', cursor - 1) + 1;
  const newline = state.text.indexOf('\n', cursor);
  const lineEnd = newline === -1 ? state.text.length : newline;
  const line = graphemes(state.text.slice(0, lineStart)).filter(
    (part) => part === '\n',
  ).length;
  const column = graphemes(state.text.slice(lineStart, cursor)).length;
  return { line, column, lineStart, lineEnd };
}

export function isOnFirstLine(state: TextBufferState): boolean {
  return getCursorLocation(state).lineStart === 0;
}

export function isOnLastLine(state: TextBufferState): boolean {
  return getCursorLocation(state).lineEnd === state.text.length;
}

function offsetAtColumn(text: string, lineStart: number, column: number): number {
  const newline = text.indexOf('\n', lineStart);
  const lineEnd = newline === -1 ? text.length : newline;
  const line = text.slice(lineStart, lineEnd);
  const boundaries = graphemeBoundaries(line);
  return lineStart + boundaries[Math.min(column, boundaries.length - 1)]!;
}

function moveVertical(
  state: TextBufferState,
  direction: 'up' | 'down',
): TextBufferState {
  const location = getCursorLocation(state);
  const preferredColumn = state.preferredColumn ?? location.column;

  if (direction === 'up') {
    if (location.lineStart === 0) return state;
    const previousLineEnd = location.lineStart - 1;
    const previousLineStart =
      previousLineEnd === 0
        ? 0
        : state.text.lastIndexOf('\n', previousLineEnd - 1) + 1;
    return {
      ...state,
      cursor: offsetAtColumn(state.text, previousLineStart, preferredColumn),
      preferredColumn,
    };
  }

  if (location.lineEnd === state.text.length) return state;
  const nextLineStart = location.lineEnd + 1;
  return {
    ...state,
    cursor: offsetAtColumn(state.text, nextLineStart, preferredColumn),
    preferredColumn,
  };
}

export function moveCursor(
  state: TextBufferState,
  direction: CursorDirection,
): TextBufferState {
  if (direction === 'up' || direction === 'down') {
    return moveVertical(state, direction);
  }

  const location = getCursorLocation(state);
  if (direction === 'home') {
    return { ...state, cursor: location.lineStart, preferredColumn: null };
  }
  if (direction === 'end') {
    return { ...state, cursor: location.lineEnd, preferredColumn: null };
  }

  const { previous, current, next } = boundariesAround(
    state.text,
    state.cursor,
  );
  return {
    ...state,
    cursor: direction === 'left' ? previous : next,
    preferredColumn: null,
  };
}

export function replaceText(
  state: TextBufferState,
  text: string,
  cursor: number = text.length,
): TextBufferState {
  return createTextBuffer(text, cursor);
}

export function splitLinesWithOffsets(text: string): Array<{
  readonly text: string;
  readonly start: number;
  readonly end: number;
}> {
  const result: Array<{ text: string; start: number; end: number }> = [];
  let start = 0;
  for (;;) {
    const newline = text.indexOf('\n', start);
    const end = newline === -1 ? text.length : newline;
    result.push({ text: text.slice(start, end), start, end });
    if (newline === -1) break;
    start = newline + 1;
  }
  return result;
}
