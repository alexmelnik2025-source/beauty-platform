/**
 * What every email needs before it leaves (launch task L2): the sender shown as the salon,
 * replies going to the salon, and an HTML version next to the plain text.
 */

/** "GESTALT <rezerwacje@hairgestalt.pl>" → { name: "GESTALT", address: "rezerwacje@…" }. */
export function parseMailbox(value: string): { name: string; address: string } {
  const match = /^\s*(?:"?([^"<]*?)"?\s*)?<([^<>\s]+@[^<>\s]+)>\s*$/.exec(value);
  if (match) return { name: (match[1] ?? '').trim(), address: match[2]! };
  return { name: '', address: value.trim() };
}

/**
 * The From header: the platform's sending address (MAIL_FROM, allowed by its SMTP server or
 * provider) with the salon's name in front, so the client sees "Berber Moda" in the inbox.
 */
export function senderMailbox(mailFrom: string, senderName?: string | null): string {
  const { name, address } = parseMailbox(mailFrom);
  // No quotes, angle brackets or line breaks: they could change the header.
  const clean = (senderName ?? '')
    .replace(/["<>\\\r\n]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const display = (clean || name).slice(0, 70);
  return display ? `"${display}" <${address}>` : address;
}

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}

/** A link is shown as a button-like line; only http(s) addresses become links. */
function linkify(escapedLine: string): string {
  return escapedLine.replace(
    /https?:\/\/[^\s<>"']+/g,
    (url) => `<a href="${url}" style="color:#1d1d1b;font-weight:600">${url}</a>`,
  );
}

/**
 * The HTML version of a plain-text email: the same words, paragraphs at blank lines,
 * links clickable. Simple inline styles only — mail apps ignore style sheets.
 */
export function textToHtml(text: string, lang = 'pl'): string {
  const paragraphs = text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((block) => block.trim())
    .filter(Boolean)
    .map(
      (block) =>
        `<p style="margin:0 0 16px">${block
          .split('\n')
          .map((line) => linkify(escapeHtml(line)))
          .join('<br>')}</p>`,
    )
    .join('\n');
  return [
    '<!doctype html>',
    `<html lang="${escapeHtml(lang)}">`,
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>',
    '<body style="margin:0;padding:24px;background:#ffffff;color:#1d1d1b;font:16px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif">',
    `<div style="max-width:560px;margin:0 auto">\n${paragraphs}\n</div>`,
    '</body>',
    '</html>',
  ].join('\n');
}
