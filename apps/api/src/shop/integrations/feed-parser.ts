/**
 * Task Q4 (part 3): reads a seller's product feed — Google Merchant XML (RSS or Atom), Ceneo XML
 * or a CSV table — into plain rows. The feeds are flat and well known, so a small tolerant reader
 * is enough (no XML library): unknown fields are ignored, a row without a name or key is counted
 * as unreadable.
 */

export type FeedFormat = 'google' | 'ceneo' | 'csv';

export interface FeedRow {
  /** The seller's own id of the product (g:id, Ceneo id, SKU column), unique in the feed. */
  key: string;
  name: string;
  ean: string | null;
  sku: string | null;
  brand: string | null;
  /** In units of the currency (49.99); null = none or unreadable. */
  price: number | null;
  /** ISO code when the feed says it ("49.99 PLN"); null = not said. */
  currency: string | null;
  /** Pieces; null = the feed does not say (Google says only in / out of stock → 0 or null). */
  stock: number | null;
  description: string | null;
  imageUrl: string | null;
}

/** A row before its key is checked. */
type RawRow = Omit<FeedRow, 'key'> & { key: string | null };

export interface ParsedFeed {
  format: FeedFormat;
  rows: FeedRow[];
  /** Rows without a name or key, or a key seen before. */
  unreadable: number;
}

const ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
};

/** Text of an XML node: CDATA kept as is, entities decoded, tags inside dropped. */
function xmlText(raw: string): string {
  let out = '';
  const parts = raw.split(/(<!\[CDATA\[[\s\S]*?\]\]>)/);
  for (const part of parts) {
    if (part.startsWith('<![CDATA[')) {
      out += part.slice(9, -3);
    } else {
      out += part
        .replace(/<[^>]*>/g, '')
        .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, code: string) => {
          if (code[0] === '#') {
            const n =
              code[1] === 'x' || code[1] === 'X'
                ? parseInt(code.slice(2), 16)
                : Number(code.slice(1));
            return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : whole;
          }
          return ENTITIES[code.toLowerCase()] ?? whole;
        });
    }
  }
  return out.trim();
}

const escape = (name: string) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Every `<tag …>inner</tag>` (and `<tag …/>`) at any depth: attributes and inner text. */
function blocks(xml: string, tag: string): { attrs: string; inner: string }[] {
  const re = new RegExp(
    `<${escape(tag)}(\\s[^>]*?)?(?:/>|>([\\s\\S]*?)</${escape(tag)}\\s*>)`,
    'g',
  );
  return [...xml.matchAll(re)].map((m) => ({ attrs: m[1] ?? '', inner: m[2] ?? '' }));
}

/** The text of the first of the named child nodes that has some. */
function field(inner: string, ...names: string[]): string | null {
  for (const name of names) {
    for (const b of blocks(inner, name)) {
      const text = xmlText(b.inner);
      if (text) return text;
    }
  }
  return null;
}

function attr(attrs: string, name: string): string | null {
  const m = new RegExp(`\\s${escape(name)}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`, 'i').exec(` ${attrs}`);
  const value = m ? xmlText(m[1] ?? m[2] ?? '') : '';
  return value || null;
}

/** "49,99 PLN", "49.99", "1 299,00 zł" → amount and currency (when said). */
export function parsePrice(value: string | null): {
  price: number | null;
  currency: string | null;
} {
  if (!value) return { price: null, currency: null };
  const currency =
    /\b([A-Z]{3})\b/.exec(value.toUpperCase())?.[1] ?? (/zł/i.test(value) ? 'PLN' : null);
  const digits = value.replace(/[^\d.,-]/g, '');
  // "1.299,00" or "1,299.00": the last separator is the decimal one.
  const lastSep = Math.max(digits.lastIndexOf(','), digits.lastIndexOf('.'));
  const normal =
    lastSep >= 0 && digits.length - lastSep - 1 <= 2
      ? `${digits.slice(0, lastSep).replace(/[.,]/g, '')}.${digits.slice(lastSep + 1)}`
      : digits.replace(/[.,]/g, '');
  const price = Number(normal);
  const ok = normal !== '' && Number.isFinite(price) && price >= 0;
  return { price: ok ? price : null, currency: ok ? currency : null };
}

const int = (value: string | null): number | null => {
  if (value === null) return null;
  const n = Number(value.replace(',', '.').trim());
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : null;
};

const clean = (value: string | null | undefined): string | null => {
  const v = value?.trim();
  return v ? v : null;
};

function googleRows(xml: string): RawRow[] {
  const items = blocks(xml, 'item');
  const list = items.length > 0 ? items : blocks(xml, 'entry');
  return list.map(({ inner }) => {
    const sale = parsePrice(field(inner, 'g:sale_price'));
    const regular = parsePrice(field(inner, 'g:price', 'price'));
    const priced = sale.price !== null ? sale : regular;
    const availability = field(inner, 'g:availability')?.toLowerCase().replace(/_/g, ' ') ?? null;
    const sku = clean(field(inner, 'g:mpn'));
    return {
      key: clean(field(inner, 'g:id', 'id')),
      name: field(inner, 'g:title', 'title') ?? '',
      ean: clean(field(inner, 'g:gtin', 'g:ean')),
      sku,
      brand: clean(field(inner, 'g:brand')),
      price: priced.price,
      currency: priced.currency,
      stock: availability === 'out of stock' ? 0 : null,
      description: clean(field(inner, 'g:description', 'description', 'summary')),
      imageUrl: clean(field(inner, 'g:image_link')),
    };
  });
}

function ceneoRows(xml: string): RawRow[] {
  return blocks(xml, 'o').map(({ attrs, inner }) => {
    const attributes = new Map(
      blocks(inner, 'a').map((a) => [
        (attr(a.attrs, 'name') ?? '').toLowerCase(),
        xmlText(a.inner),
      ]),
    );
    const main = blocks(inner, 'main')[0];
    const { price, currency } = parsePrice(attr(attrs, 'price'));
    return {
      key: clean(attr(attrs, 'id')),
      name: field(inner, 'name') ?? '',
      ean: clean(attributes.get('ean') ?? attributes.get('gtin')),
      sku: clean(attributes.get('kod_producenta') ?? attributes.get('sku')),
      brand: clean(attributes.get('producent') ?? attributes.get('marka')),
      price,
      currency,
      stock: int(attr(attrs, 'stock')),
      description: clean(field(inner, 'desc')),
      imageUrl: main ? attr(main.attrs, 'url') : null,
    };
  });
}

/** RFC 4180 table: quoted fields may hold separators, quotes ("") and new lines. */
export function parseCsv(text: string, separator: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        cell += ch;
      }
    } else if (ch === '"' && cell === '') {
      quoted = true;
    } else if (ch === separator) {
      row.push(cell);
      cell = '';
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i += 1;
      row.push(cell);
      if (row.some((c) => c.trim() !== '')) rows.push(row);
      row = [];
      cell = '';
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== '')) rows.push(row);
  return rows;
}

/** Column names sellers use (Polish and English, any case, spaces/underscores ignored). */
const COLUMNS: Record<Exclude<keyof FeedRow, 'currency'>, string[]> = {
  key: ['id', 'productid', 'idproduktu'],
  name: ['name', 'nazwa', 'title', 'tytul', 'nazwaproduktu'],
  ean: ['ean', 'gtin', 'kodkreskowy', 'barcode', 'ean13'],
  sku: ['sku', 'symbol', 'kod', 'mpn', 'indeks'],
  brand: ['brand', 'marka', 'producent', 'manufacturer'],
  price: ['price', 'cena', 'cenabrutto', 'pricegross'],
  stock: ['stock', 'quantity', 'ilosc', 'stan', 'stanmagazynowy', 'qty'],
  description: ['description', 'opis'],
  imageUrl: ['image', 'imagelink', 'imageurl', 'zdjecie', 'foto', 'img'],
};

const columnKey = (header: string) =>
  header
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l')
    .replace(/[^a-z0-9]/g, '');

function csvRows(raw: string): RawRow[] {
  const text = raw.replace(/\r\n?/g, '\n');
  const firstLine = text.split(/\r?\n/, 1)[0] ?? '';
  const separator = [';', '\t', ','].reduce((best, sep) =>
    firstLine.split(sep).length > firstLine.split(best).length ? sep : best,
  );
  const [header, ...body] = parseCsv(text, separator);
  if (!header) return [];
  const keys = header.map(columnKey);
  const index = (what: keyof typeof COLUMNS) => keys.findIndex((k) => COLUMNS[what].includes(k));
  const at = Object.fromEntries(
    (Object.keys(COLUMNS) as (keyof typeof COLUMNS)[]).map((k) => [k, index(k)]),
  ) as Record<keyof typeof COLUMNS, number>;
  const cell = (row: string[], what: keyof typeof COLUMNS) =>
    at[what] >= 0 ? clean(row[at[what]]) : null;
  return body.map((row) => {
    const sku = cell(row, 'sku');
    const { price, currency } = parsePrice(cell(row, 'price'));
    return {
      key: cell(row, 'key') ?? sku ?? cell(row, 'ean'),
      name: cell(row, 'name') ?? '',
      ean: cell(row, 'ean'),
      sku,
      brand: cell(row, 'brand'),
      price,
      currency,
      stock: int(cell(row, 'stock')),
      description: cell(row, 'description'),
      imageUrl: cell(row, 'imageUrl'),
    };
  });
}

const withoutBom = (text: string) => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);

/** Which kind of feed the text is: XML with Ceneo offers, other XML (Google), or a table. */
export function detectFeed(text: string): FeedFormat {
  const head = withoutBom(text).trimStart();
  if (!head.startsWith('<')) return 'csv';
  return /<offers[\s>]/.test(head) && /<o\s/.test(head) ? 'ceneo' : 'google';
}

export function parseFeed(text: string): ParsedFeed {
  const body = withoutBom(text);
  const format = detectFeed(body);
  const raw =
    format === 'csv' ? csvRows(body) : format === 'ceneo' ? ceneoRows(body) : googleRows(body);
  const seen = new Set<string>();
  const rows: FeedRow[] = [];
  let unreadable = 0;
  for (const r of raw) {
    const key = r.key?.slice(0, 64) ?? null;
    if (!key || !r.name.trim() || seen.has(key)) {
      unreadable += 1;
      continue;
    }
    seen.add(key);
    rows.push({ ...r, key, name: r.name.trim() });
  }
  return { format, rows, unreadable };
}
