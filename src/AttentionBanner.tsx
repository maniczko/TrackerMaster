// Non-blocking banners for returned idle periods and work reminders (TECH-12 / DEV-39).
import { useEffect } from 'react';
import { formatIdleClock, idlePromptText, longTimerReminderText } from './attentionSchedule';
import type { AttentionController } from './useAttention';

type Props = {
  attention: AttentionController;
  reportZone: string;
  now: number;
  hasActiveTimer: boolean;
  onStartFocus?: () => void;
  onOpenApp?: () => void;
  compact?: boolean;
};

export default function AttentionBanner({
  attention,
  reportZone,
  now,
  hasActiveTimer,
  onStartFocus,
  onOpenApp,
  compact = false,
}: Props) {
  const { state, busy, error } = attention;
  const prompt = state.completedIdle;
  const noTimer = !hasActiveTimer ? state.noTimerReminder : null;
  const longTimer = !state.openIdle && hasActiveTimer ? state.longTimerReminder : null;

  useEffect(() => {
    if (!prompt) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === 'Escape' && !busy) {
        void attention.postponeIdle();
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [prompt?.periodId, busy]);

  if (!error && !prompt && !noTimer && !longTimer) return null;

  return (
    <div className={compact ? 'qp-attention' : 'attention-banners'}>
      {error && (
        <div role="alert" className={compact ? 'qp-status' : 'alert error'} data-tone={compact ? 'error' : undefined}>
          <span>{error}</span>
        </div>
      )}
      {prompt && (
        <section
          role="region"
          aria-label="Powrót po bezczynności"
          className={compact ? 'qp-attention-card' : 'alert pending attention-card'}
        >
          <p className={compact ? 'qp-attention-text' : undefined}>
            <strong>{idlePromptText(prompt.startedMs, prompt.endedMs, reportZone)}</strong>
          </p>
          <div className={compact ? 'qp-attention-actions' : 'actions'}>
            <button type="button" className={compact ? 'qp-text-button' : 'primary'} disabled={busy} onClick={() => void attention.decideIdle(true)}>
              Dolicz
            </button>
            <button type="button" className={compact ? 'qp-text-button' : 'secondary'} disabled={busy} onClick={() => void attention.decideIdle(false)}>
              Odrzuć
            </button>
            {hasActiveTimer && (
              <button
                type="button"
                className={compact ? 'qp-text-button' : 'secondary'}
                disabled={busy}
                onClick={() => void attention.stopAtIdleStart()}
              >
                Zatrzymaj o {formatIdleClock(prompt.startedMs, reportZone)}
              </button>
            )}
            <button type="button" className={compact ? 'qp-text-button' : 'secondary'} disabled={busy} onClick={() => void attention.postponeIdle()}>
              Później
            </button>
          </div>
        </section>
      )}
      {noTimer && (
        <section
          role="status"
          aria-label="Przypomnienie o starcie pomiaru"
          className={compact ? 'qp-attention-card' : 'alert attention-card'}
        >
          <p className={compact ? 'qp-attention-text' : undefined}>
            <strong>Nic nie mierzysz.</strong> Uruchom timer, jeśli pracujesz.
          </p>
          <div className={compact ? 'qp-attention-actions' : 'actions'}>
            {onStartFocus && (
              <button type="button" className={compact ? 'qp-text-button' : 'primary'} disabled={busy} onClick={onStartFocus}>
                Start
              </button>
            )}
            <button type="button" className={compact ? 'qp-text-button' : 'secondary'} disabled={busy} onClick={() => void attention.muteToday()}>
              Wycisz na dziś
            </button>
          </div>
        </section>
      )}
      {longTimer && (
        <section
          role="status"
          aria-label="Przypomnienie o długim pomiarze"
          className={compact ? 'qp-attention-card' : 'alert attention-card'}
        >
          <p className={compact ? 'qp-attention-text' : undefined}>
            <strong>{longTimerReminderText(longTimer.startedMs, now)}</strong>
          </p>
          <div className={compact ? 'qp-attention-actions' : 'actions'}>
            <button type="button" className={compact ? 'qp-text-button' : 'primary'} disabled={busy} onClick={() => void attention.stopLongTimer()}>
              Zatrzymaj teraz
            </button>
            <button type="button" className={compact ? 'qp-text-button' : 'secondary'} disabled={busy} onClick={() => void attention.muteLongTimer()}>
              Działa dalej
            </button>
            {onOpenApp && (
              <button type="button" className={compact ? 'qp-text-button' : 'secondary'} disabled={busy} onClick={onOpenApp}>
                Otwórz
              </button>
            )}
          </div>
        </section>
      )}
    </div>
  );
}
