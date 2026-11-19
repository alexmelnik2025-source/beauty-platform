'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '@/lib/api';
import { fill, useI18n } from '@/lib/i18n';
import { encodeQr, qrSvg, type QrCode } from '@/lib/qr';
import type { Staff } from '@/lib/types';

/**
 * Short link (Instagram bio, business card), QR code and the booking button for the salon's own
 * site. Task Q2: `staffUrl` (the salon's staff list in the API) adds a QR code for each specialist.
 */
export function ShareBooking({
  slug,
  name,
  staffUrl,
}: {
  slug: string;
  name: string;
  staffUrl?: string;
}) {
  const { t, locale } = useI18n();
  const origin = window.location.origin;
  const shortLink = `${origin}/s/${slug}`;
  const embedCode = `<script src="${origin}/embed.js" data-salon="${slug}" data-lang="${locale}" async></script>`;
  return (
    <section className="section">
      <h2>{t.share.title}</h2>
      <div className="field">
        <span id="share-short">{t.share.shortLink}</span>
        <CopyField value={shortLink} labelledBy="share-short" />
        <small className="muted">{t.share.shortHint}</small>
      </div>
      <QrCard
        id="share-qr"
        title={t.share.qrTitle}
        alt={t.share.qrAlt}
        link={`${shortLink}?utm_source=qr`}
        file={`qr-${slug}`}
        name={name}
        hint={t.share.qrHint}
      />
      {staffUrl ? (
        <StaffQr staffUrl={staffUrl} shortLink={shortLink} slug={slug} name={name} />
      ) : null}
      <div className="field">
        <span id="share-embed">{t.share.embed}</span>
        <CopyField value={embedCode} labelledBy="share-embed" multiline />
        <small className="muted">{t.share.embedHint}</small>
        <small className="muted">{t.share.ownButton}</small>
      </div>
    </section>
  );
}

function CopyField({
  value,
  labelledBy,
  multiline = false,
}: {
  value: string;
  labelledBy: string;
  multiline?: boolean;
}) {
  const { t } = useI18n();
  const [copied, setCopied] = useState(false);
  return (
    <div className={multiline ? 'copy-field copy-field--code' : 'copy-field'}>
      {multiline ? (
        <textarea
          readOnly
          value={value}
          aria-labelledby={labelledBy}
          onFocus={(e) => e.target.select()}
        />
      ) : (
        <input
          className="input"
          readOnly
          value={value}
          aria-labelledby={labelledBy}
          onFocus={(e) => e.target.select()}
        />
      )}
      <button
        type="button"
        className="btn btn--quiet"
        onClick={() => {
          void navigator.clipboard?.writeText(value);
          setCopied(true);
        }}
      >
        {copied ? t.actions.copied : t.actions.copy}
      </button>
    </div>
  );
}

/** Pixels per module in the PNG: a typical salon link (version 4–6) gives ~1200–1500 px, enough for A4. */
const PNG_MODULE_PX = 32;

function download(href: string, filename: string) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function pngBlob(qr: QrCode): Promise<Blob | null> {
  const quiet = 4;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = (qr.size + quiet * 2) * PNG_MODULE_PX;
  const ctx = canvas.getContext('2d');
  if (!ctx) return Promise.resolve(null);
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#000';
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.isDark(x, y)) {
        ctx.fillRect(
          (x + quiet) * PNG_MODULE_PX,
          (y + quiet) * PNG_MODULE_PX,
          PNG_MODULE_PX,
          PNG_MODULE_PX,
        );
      }
    }
  }
  return new Promise((done) => canvas.toBlob(done, 'image/png'));
}

/**
 * Task Q2: a QR code for each specialist — the salon's short link with `utm_source=qr&staff=…`,
 * so the client lands on that specialist's services and times, and the report "Skąd przyszli"
 * knows whose code it was. Nothing is shown until a specialist is chosen (one code at a time).
 */
function StaffQr({
  staffUrl,
  shortLink,
  slug,
  name,
}: {
  staffUrl: string;
  shortLink: string;
  slug: string;
  name: string;
}) {
  const { t } = useI18n();
  const [staff, setStaff] = useState<Staff[]>([]);
  const [staffId, setStaffId] = useState('');
  useEffect(() => {
    api<Staff[]>(staffUrl)
      .then((list) => setStaff(list.filter((s) => s.active)))
      // Only an extra: without the list the salon's own code is still there.
      .catch(() => setStaff([]));
  }, [staffUrl]);
  if (staff.length === 0) return null;
  const chosen = staff.find((s) => s.id === staffId);
  return (
    <div className="field">
      <label className="field">
        <span>{t.share.staffQrTitle}</span>
        <select
          className="input"
          value={staffId}
          onChange={(e) => setStaffId(e.target.value)}
          aria-label={t.share.staffQrPick}
        >
          <option value="">{t.share.staffQrNone}</option>
          {staff.map((s) => (
            <option key={s.id} value={s.id}>
              {s.displayName}
            </option>
          ))}
        </select>
      </label>
      {chosen ? (
        <QrCard
          id={`share-qr-staff`}
          alt={fill(t.share.staffQrAlt, { name: chosen.displayName })}
          link={`${shortLink}?utm_source=qr&staff=${chosen.id}`}
          file={`qr-${slug}-${fileName(chosen.displayName)}`}
          name={chosen.displayName}
          sub={name}
        />
      ) : null}
      <small className="muted">{t.share.staffQrHint}</small>
    </div>
  );
}

/** "Anna Kowalska-Nowak" → "anna-kowalska-nowak" for the downloaded file's name. */
function fileName(text: string): string {
  const plain = text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/ł/g, 'l')
    .replace(/Ł/g, 'L')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return plain || 'specjalista';
}

/**
 * QR code of a link for a mirror, the counter, the door or a business card: PNG, SVG and a
 * printable card (only this card is printed — `html.print-qr` and `.qr-print--printing` in
 * globals.css). `name` is the big line of the card, `sub` a smaller one under it.
 */
function QrCard({
  id,
  title,
  alt,
  link,
  file,
  name,
  sub,
  hint,
}: {
  id: string;
  title?: string;
  alt: string;
  link: string;
  file: string;
  name: string;
  sub?: string;
  hint?: string;
}) {
  const { t } = useI18n();
  const qr = useMemo(() => encodeQr(link), [link]);
  const svg = useMemo(() => qrSvg(qr, link), [qr, link]);
  const card = useRef<HTMLElement>(null);
  useEffect(() => {
    const done = () => {
      document.documentElement.classList.remove('print-qr');
      card.current?.classList.remove('qr-print--printing');
    };
    window.addEventListener('afterprint', done);
    return () => window.removeEventListener('afterprint', done);
  }, []);
  return (
    <div className="field">
      {title ? <span id={id}>{title}</span> : null}
      <div className="salon-qr">
        <figure
          ref={card}
          className="qr-print"
          aria-labelledby={title ? id : undefined}
          aria-label={title ? undefined : alt}
        >
          <div
            className="qr-print__code"
            role="img"
            aria-label={alt}
            data-qr-version={qr.version}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
          <figcaption>
            <strong>{name}</strong>
            {sub ? <span>{sub}</span> : null}
            <span>{t.share.qrScan}</span>
            <small>{link.replace(/^https?:\/\//, '').replace(/\?.*$/, '')}</small>
          </figcaption>
        </figure>
        <div className="salon-qr__actions">
          <button
            type="button"
            className="btn btn--quiet"
            onClick={() => {
              void pngBlob(qr).then((blob) => {
                if (!blob) return;
                const url = URL.createObjectURL(blob);
                download(url, `${file}.png`);
                setTimeout(() => URL.revokeObjectURL(url), 1000);
              });
            }}
          >
            {t.share.qrPng}
          </button>
          <button
            type="button"
            className="btn btn--quiet"
            onClick={() => {
              const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
              download(url, `${file}.svg`);
              setTimeout(() => URL.revokeObjectURL(url), 1000);
            }}
          >
            {t.share.qrSvg}
          </button>
          <button
            type="button"
            className="btn btn--quiet"
            onClick={() => {
              // Straight on the DOM: the print dialog takes the page before React re-renders.
              card.current?.classList.add('qr-print--printing');
              document.documentElement.classList.add('print-qr');
              window.print();
            }}
          >
            {t.share.qrPrint}
          </button>
        </div>
      </div>
      {hint ? <small className="muted">{hint}</small> : null}
    </div>
  );
}
