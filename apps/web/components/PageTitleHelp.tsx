'use client';

import { useState, type ReactNode } from 'react';
import { useI18n } from '@/lib/i18n';

/**
 * A cabinet page title with a "?" next to it; the page's explanation opens under it
 * (owner 19.11 and Q6: explanations only under "?", the page starts with what matters).
 */
export function PageTitleHelp({
  id,
  title,
  help,
  actions,
}: {
  id: string;
  title: string;
  help: ReactNode;
  actions?: ReactNode;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  return (
    <>
      <div className="page-head">
        <div className="title-help">
          <h1>{title}</h1>
          <button
            type="button"
            className="help-btn"
            aria-label={t.common.howItWorks}
            title={t.common.howItWorks}
            aria-expanded={open}
            aria-controls={id}
            onClick={() => setOpen((v) => !v)}
          >
            ?
          </button>
        </div>
        {actions}
      </div>
      {open ? (
        <div className="page page-help" id={id}>
          <p className="small muted help-box">{help}</p>
        </div>
      ) : null}
    </>
  );
}
