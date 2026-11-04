'use client';

import { useI18n } from '@/lib/i18n';
import {
  DRINK_ICON,
  MOOD_ICON,
  MOODS,
  type OfferedDrink,
  type VisitDrink,
  type VisitWishes,
} from './wishes';

export interface WishQuestions {
  mood: boolean;
  drinks: OfferedDrink[];
  note: boolean;
}

export function asksWishes(q: WishQuestions | null | undefined): q is WishQuestions {
  return Boolean(q && (q.mood || q.drinks.length > 0 || q.note));
}

/**
 * Task 80: the client's wishes — big emoji buttons, one tap each (a second tap clears it),
 * and a short note. Only the questions the salon asks.
 */
export function WishesPicker({
  questions,
  value,
  onChange,
}: {
  questions: WishQuestions;
  value: VisitWishes;
  onChange: (value: VisitWishes) => void;
}) {
  const { t } = useI18n();
  const drinks: VisitDrink[] = questions.drinks.length > 0 ? [...questions.drinks, 'none'] : [];
  return (
    <div className="wishes stack">
      {questions.mood ? (
        <div className="field" role="group" aria-labelledby="wish-mood">
          <span id="wish-mood">{t.wishStep.moodQ}</span>
          <div className="wish-options">
            {MOODS.map((m) => (
              <button
                key={m}
                type="button"
                className="wish-option"
                aria-pressed={value.mood === m}
                onClick={() => onChange({ ...value, mood: value.mood === m ? null : m })}
              >
                <span className="wish-option__icon" aria-hidden="true">
                  {MOOD_ICON[m]}
                </span>
                <span>{t.wishStep.mood[m]}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {drinks.length > 0 ? (
        <div className="field" role="group" aria-labelledby="wish-drink">
          <span id="wish-drink">{t.wishStep.drinkQ}</span>
          <div className="wish-options">
            {drinks.map((d) => (
              <button
                key={d}
                type="button"
                className="wish-option"
                aria-pressed={value.drink === d}
                onClick={() => onChange({ ...value, drink: value.drink === d ? null : d })}
              >
                <span className="wish-option__icon" aria-hidden="true">
                  {DRINK_ICON[d]}
                </span>
                <span>{t.wishStep.drink[d]}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {questions.note ? (
        <label className="field">
          <span>{t.wishStep.noteQ}</span>
          <textarea
            rows={2}
            maxLength={200}
            placeholder={t.wishStep.notePlaceholder}
            value={value.note ?? ''}
            onChange={(e) => onChange({ ...value, note: e.target.value || null })}
          />
          <small className="muted">{(value.note ?? '').length} / 200</small>
        </label>
      ) : null}
    </div>
  );
}
