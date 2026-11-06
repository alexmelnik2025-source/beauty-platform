import { useI18n } from '@/lib/i18n';

/** Task 211: the salon's public answer under a review (salon page, the client's visit, cabinet). */
export function SalonReply({ text }: { text: string | null }) {
  const { t } = useI18n();
  if (!text) return null;
  return (
    <blockquote className="review-reply" aria-label={t.reviews.salonReply}>
      <strong className="small">{t.reviews.salonReply}</strong>
      <span className="review-text">{text}</span>
    </blockquote>
  );
}
