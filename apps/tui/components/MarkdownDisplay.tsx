import type { ReactNode } from 'react';
import { Box, Text } from 'ink';
import { qwenTheme } from '../theme.js';

interface MarkdownDisplayProps {
  text: string;
  contentWidth: number;
  /** Retained for callers; Qwen does not append a separate streaming cursor. */
  isPending?: boolean;
  maxLines?: number;
  color?: string;
}

interface MarkdownBlock {
  kind: 'blank' | 'code' | 'heading' | 'quote' | 'list' | 'rule' | 'text';
  text: string;
  language?: string;
  level?: number;
  marker?: string;
  indent?: number;
  checked?: boolean;
}

function sanitize(text: string): string {
  return text
    .replace(/\u001b(?:(?:\[[0-?]*[ -/]*[@-~])|(?:\][^\u0007]*(?:\u0007|\u001b\\)))/g, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .replace(/[\u202a-\u202e\u2066-\u2069]/g, '');
}

function parseBlocks(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  const lines = sanitize(source).replace(/\r\n?/g, '\n').split('\n');
  let fence: { marker: string; language: string; lines: string[] } | undefined;

  for (const line of lines) {
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})\s*([^\s]*)?.*$/);
    if (fence) {
      const isClosingFence = fenceMatch
        && fenceMatch[1]?.[0] === fence.marker[0]
        && fenceMatch[1].length >= fence.marker.length;
      if (isClosingFence) {
        blocks.push({ kind: 'code', text: fence.lines.join('\n'), language: fence.language });
        fence = undefined;
      } else {
        fence.lines.push(line);
      }
      continue;
    }
    if (fenceMatch) {
      fence = { marker: fenceMatch[1], language: fenceMatch[2] ?? '', lines: [] };
      continue;
    }

    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    const quote = line.match(/^\s*>\s?(.*)$/);
    const list = line.match(/^(\s*)([-+*]|\d+[.)])\s+(.+)$/);
    if (!line.trim()) {
      if (blocks.length > 0 && blocks.at(-1)?.kind !== 'blank') {
        blocks.push({ kind: 'blank', text: '' });
      }
    } else if (/^\s*(?:-{3,}|_{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push({ kind: 'rule', text: '' });
    } else if (heading) {
      blocks.push({ kind: 'heading', text: heading[2], level: heading[1].length });
    } else if (quote) {
      blocks.push({ kind: 'quote', text: quote[1] });
    } else if (list) {
      const task = list[3].match(/^\[([ xX])\]\s*(.*)$/);
      blocks.push({
        kind: 'list',
        text: task ? task[2] : list[3],
        marker: list[2],
        indent: list[1].length,
        checked: task ? task[1].toLowerCase() === 'x' : undefined,
      });
    } else {
      blocks.push({ kind: 'text', text: line });
    }
  }
  if (fence) blocks.push({ kind: 'code', text: fence.lines.join('\n'), language: fence.language });
  while (blocks.at(-1)?.kind === 'blank') blocks.pop();
  return blocks;
}

const INLINE_MARKDOWN = /(\*\*[^*\n]+\*\*|__[^_\n]+__|~~[^~\n]+~~|`+[^`\n]+`+|\[[^\]\n]+\]\([^)\n]+\)|\*[^*\n]+\*|(?<![\w/])_[^_\n]+_(?!\w))/g;

function inline(text: string, color?: string): ReactNode[] {
  const result: ReactNode[] = [];
  let cursor = 0;
  for (const match of text.matchAll(INLINE_MARKDOWN)) {
    const index = match.index;
    if (index > cursor) result.push(text.slice(cursor, index));
    const token = match[0];
    const key = `${index}-${token}`;
    if ((token.startsWith('**') && token.endsWith('**'))
        || (token.startsWith('__') && token.endsWith('__'))) {
      result.push(<Text key={key} bold color={color}>{token.slice(2, -2)}</Text>);
    } else if (token.startsWith('~~')) {
      result.push(<Text key={key} strikethrough color={color}>{token.slice(2, -2)}</Text>);
    } else if (token.startsWith('`')) {
      const fenceLength = token.match(/^`+/)?.[0].length ?? 1;
      result.push(
        <Text key={key} color={qwenTheme.text.code}>
          {token.slice(fenceLength, -fenceLength)}
        </Text>,
      );
    } else if (token.startsWith('[')) {
      const link = token.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
      result.push(
        <Text key={key} color={qwenTheme.text.link} underline>
          {link?.[1] ?? token}
        </Text>,
      );
      if (link && link[1] !== link[2]) {
        result.push(<Text key={`${key}-url`} dimColor>{` (${link[2]})`}</Text>);
      }
    } else {
      result.push(<Text key={key} italic color={color}>{token.slice(1, -1)}</Text>);
    }
    cursor = index + token.length;
  }
  if (cursor < text.length) result.push(text.slice(cursor));
  return result;
}

function truncateBlocks(blocks: MarkdownBlock[], maxLines?: number): { blocks: MarkdownBlock[]; hidden: number } {
  if (maxLines === undefined || maxLines < 1 || blocks.length <= maxLines) {
    return { blocks, hidden: 0 };
  }
  return { blocks: blocks.slice(0, maxLines), hidden: blocks.length - maxLines };
}

function ListBlock({ block, color }: { block: MarkdownBlock; color?: string }) {
  const indent = Math.max(0, block.indent ?? 0);
  const marker = block.checked === true
    ? '✓'
    : block.checked === false
      ? '○'
      : block.marker ?? '-';
  const prefix = `${marker} `;
  return (
    <Box marginLeft={indent}>
      <Box width={prefix.length} flexShrink={0}>
        <Text color={block.checked === true ? qwenTheme.status.success : color}>{prefix}</Text>
      </Box>
      <Text color={color} wrap="wrap">{inline(block.text, color)}</Text>
    </Box>
  );
}

export function MarkdownDisplay({
  text,
  contentWidth,
  maxLines,
  color = qwenTheme.text.primary,
}: MarkdownDisplayProps) {
  const parsed = parseBlocks(text);
  const { blocks, hidden } = truncateBlocks(parsed, maxLines);
  const width = Math.max(8, contentWidth);

  return (
    <Box flexDirection="column" width={width}>
      {blocks.map((block, index) => {
        const key = `${index}-${block.kind}`;
        if (block.kind === 'blank') return <Text key={key}> </Text>;
        if (block.kind === 'rule') return <Text key={key} dimColor color={qwenTheme.text.secondary}>---</Text>;
        if (block.kind === 'heading') {
          return (
            <Text
              key={key}
              bold={(block.level ?? 1) <= 3}
              italic={block.level === 4}
              color={color}
            >
              {inline(block.text, color)}
            </Text>
          );
        }
        if (block.kind === 'quote') {
          return (
            <Box key={key} marginLeft={1}>
              <Box width={2} flexShrink={0}><Text color={qwenTheme.text.secondary}>│ </Text></Box>
              <Text italic color={color} wrap="wrap">{inline(block.text, color)}</Text>
            </Box>
          );
        }
        if (block.kind === 'list') return <ListBlock key={key} block={block} color={color} />;
        if (block.kind === 'code') {
          return (
            <Box key={key} flexDirection="column" paddingLeft={1} width={width}>
              {block.language && <Text dimColor color={qwenTheme.text.secondary}>{block.language}</Text>}
              <Text color={qwenTheme.colors.lightBlue} wrap="wrap">{block.text || ' '}</Text>
            </Box>
          );
        }
        return <Text key={key} color={color} wrap="wrap">{inline(block.text, color)}</Text>;
      })}
      {hidden > 0 && <Text dimColor color={qwenTheme.text.secondary}>{`... ${hidden} more lines`}</Text>}
    </Box>
  );
}
