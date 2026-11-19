'use client';

import { useEffect, useMemo, useState } from 'react';
import { api } from '@/lib/api';
import { fill, useI18n } from '@/lib/i18n';
import { encodeQr, qrSvg, type QrCode } from '@/lib/qr';
import type { Staff } from '@/lib/types';
import { useSession } from './Session';

/** Short link (Instagram bio, business card), QR code and the booking button for the salon's own site. */
export function ShareBooking({ slug, name }: { slug: string; name: string }) {
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
      <SalonQr link={`${shortLink}?utm_source=qr`} slug={slug} name={name} />
      <StaffQr shortLink={shortLink} slug={slug} name={name} />
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
 * QR code of the short link for a mirror, the counter, the door or a business card: PNG, SVG and
 * a printable card (only the card is printed — `html.print-qr` in globals.css).
 */
function SalonQr({
  link,
  slug,
  name,
  staffName,
  id = 'share-qr',
}: {
  link: string;
  slug: string;
  name: string;
  /** Task Q2: the QR code of one specialist — their name on the card, their id in the file name. */
  staffName?: string;
  id?: string;
}) {
  const { t } = useI18n();
  const file = staffName
    ? `qr-${slug}-${staffName.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-')}`
    : `qr-${slug}`;
  const qr = useMemo(() => encodeQr(link), [link]);
  const svg = useMemo(() => qrSvg(qr, link), [qr, link]);
  useEffect(() => {
    const done = () => document.documentElement.classList.remove('print-qr');
    window.addEventListener('afterprint', done);
    return () => window.removeEventListener('afterprint', done);
  }, []);
  return (
    <div className="field">
      <span id={id}>
        {staffName ? fill(t.share.staffQrTitle, { name: staffName }) : t.share.qrTitle}
      </span>
      <div className="salon-qr">
        <figure className="qr-print" aria-labelledby={id}>
          <div
            className="qr-print__code"
            role="img"
            aria-label={staffName ? fill(t.share.staffQrAlt, { name: staffName }) : t.share.qrAlt}
            data-qr-version={qr.version}
            dangerouslySetInnerHTML={{ __html: svg }}
          />
          <figcaption>
            <strong>{name}</strong>
            {staffName ? <strong>{staffName}</strong> : null}
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
              document.documentElement.classList.add('print-qr');
              window.print();
            }}
          >
            {t.share.qrPrint}
          </button>
        </div>
      </div>
      {staffName ? null : <small className="muted">{t.share.qrHint}</small>}
    </div>
  );
}

/**
 * Task Q2 (part 3): a QR code for each specialist — on their mirror or business card. Its link
 * carries `utm_source=qr&staff=…`, so the booking page offers that specialist first and the
 * report's "Skąd przyszli" counts the visits that came through this very code.
 */
function StaffQr({ shortLink, slug, name }: { shortLink: string; slug: string; name: string }) {
  const { t } = useI18n();
  const session = useSession();
  const [staff, setStaff] = useState<Staff[] | null>(null);
  const [open, setOpen] = useState('');
  useEffect(() => {
    api<Staff[]>(`/v1/organizations/${session.orgId}/locations/${session.location.id}/staff`)
      .then((list) => setStaff(list.filter((s) => s.active)))
      .catch(() => setStaff([]));
  }, [session.orgId, session.location.id]);
  if (!staff || staff.length === 0) return null;
  const chosen = staff.find((s) => s.id === open);
  return (
    <div className="field" data-testid="staff-qr">
      <span id="share-staff-qr">{t.share.staffQr}</span>
      <div className="chips tag-filter" role="group" aria-labelledby="share-staff-qr">
        {staff.map((s) => (
          <button
            key={s.id}
            type="button"
            aria-pressed={s.id === open}
            onClick={() => setOpen((v) => (v === s.id ? '' : s.id))}
          >
            {s.displayName}
          </button>
        ))}
      </div>
      {chosen ? (
        <SalonQr
          id="share-staff-qr-code"
          link={`${shortLink}?utm_source=qr&staff=${chosen.id}`}
          slug={slug}
          name={name}
          staffName={chosen.displayName}
        />
      ) : null}
      <small className="muted">{t.share.staffQrHint}</small>
    </div>
  );
}
