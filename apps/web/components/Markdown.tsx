import type { ReactNode } from 'react';

/**
 * A small Markdown subset for texts written by salons (booking terms, privacy policy):
 * headings (#, ##, ###), paragraphs, numbered and bulleted lists, quotes, **bold**, `code`
 * and plain http(s) links. Everything becomes React elements — no HTML from the text is
 * ever inserted into the page.
 */
export type MarkdownBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; text: string }
  | { kind: 'paragraph'; text: string }
  | { kind: 'quote'; text: string }
  | { kind: 'list'; ordered: boolean; items: string[] };

const HEADING = /^(#{1,3})\s+(.*)$/;
const ORDERED = /^\d+[.)]\s+(.*)$/;
const BULLET = /^[-*]\s+(.*)$/;
const QUOTE = /^>\s?(.*)$/;

export function parseMarkdown(source: string): MarkdownBlock[] {
  const blocks: MarkdownBlock[] = [];
  let current: MarkdownBlock | null = null;
  const close = () => {
    if (current) blocks.push(current);
    current = null;
  };
  for (const raw of source.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trimEnd();
    const trimmed = line.trim();
    if (trimmed === '') {
      close();
      continue;
    }
    const heading = HEADING.exec(trimmed);
    if (heading) {
      close();
      blocks.push({
        kind: 'heading',
        level: heading[1]!.length as 1 | 2 | 3,
        text: heading[2]!.trim(),
      });
      continue;
    }
    const ordered = ORDERED.exec(trimmed);
    const bullet = ordered ? null : BULLET.exec(trimmed);
    const item = ordered ?? bullet;
    if (item) {
      const isOrdered = Boolean(ordered);
      const list = current as MarkdownBlock | null;
      if (list?.kind === 'list' && list.ordered === isOrdered) {
        list.items.push(item[1]!);
      } else {
        close();
        current = { kind: 'list', ordered: isOrdered, items: [item[1]!] };
      }
      continue;
    }
    const quote = QUOTE.exec(trimmed);
    const open = current as MarkdownBlock | null;
    if (quote) {
      if (open?.kind === 'quote') open.text += ` ${quote[1]}`;
      else {
        close();
        current = { kind: 'quote', text: quote[1]! };
      }
      continue;
    }
    // An indented line continues the list item above it; otherwise the paragraph.
    if (open?.kind === 'list' && /^\s/.test(line)) {
      open.items[open.items.length - 1] += ` ${trimmed}`;
    } else if (open?.kind === 'paragraph') {
      open.text += ` ${trimmed}`;
    } else {
      close();
      current = { kind: 'paragraph', text: trimmed };
    }
  }
  close();
  return blocks;
}

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|https?:\/\/[^\s<>()]+[^\s<>().,;:!?])/g;

function inline(text: string): ReactNode[] {
  return text.split(INLINE).map((part, i) => {
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return <code key={i}>{part.slice(1, -1)}</code>;
    }
    if (/^https?:\/\//.test(part)) {
      return (
        <a key={i} href={part} rel="noopener nofollow">
          {part}
        </a>
      );
    }
    return part;
  });
}

export function Markdown({ source }: { source: string }) {
  return (
    <div className="markdown">
      {parseMarkdown(source).map((block, i) => {
        switch (block.kind) {
          case 'heading': {
            const Tag = block.level === 1 ? 'h1' : block.level === 2 ? 'h2' : 'h3';
            return <Tag key={i}>{inline(block.text)}</Tag>;
          }
          case 'quote':
            return <blockquote key={i}>{inline(block.text)}</blockquote>;
          case 'list': {
            const Tag = block.ordered ? 'ol' : 'ul';
            return (
              <Tag key={i}>
                {block.items.map((item, j) => (
                  <li key={j}>{inline(item)}</li>
                ))}
              </Tag>
            );
          }
          default:
            return <p key={i}>{inline(block.text)}</p>;
        }
      })}
    </div>
  );
}
