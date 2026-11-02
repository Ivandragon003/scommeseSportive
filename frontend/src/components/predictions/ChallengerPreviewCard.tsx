import { useEffect, useState } from 'react';
import { ChallengerPreview, challengerPreviewExpired } from '../../utils/challengerPreviewApi';
import { dateTime, decisionReason } from '../../features/research/researchPresentation';
import { fmtSelection } from './predictionFormatting';

const reasons: Record<string, string> = {
  challenger_preview_expired: 'L’anteprima è scaduta o la partita è iniziata. Aggiorna per una nuova valutazione.',
  challenger_preview_quote_expired: 'Le quote dell’anteprima non sono più aggiornate.',
  challenger_preview_quote_unavailable: 'Quote reali coerenti con il consiglio non disponibili.',
  challenger_preview_unavailable: 'Non è stato possibile completare l’anteprima C.',
  adoption_state_unavailable: 'La versione operativa del modello C non è verificabile.',
  challenger_deployment_suspended: 'Il modello C è temporaneamente sospeso.',
  nightly_decision_available: 'È stata archiviata una decisione Nightly. Ricarica i consigli della partita.',
  match_started: 'La partita è già iniziata: l’anteprima pre-partita non è disponibile.',
  match_finished: 'La partita è conclusa: l’anteprima pre-partita non è disponibile.',
  unsupported_competition: 'Questa competizione non è supportata dal modello C.',
  match_kickoff_unverified: 'L’orario della partita non è verificabile.',
  match_not_found: 'La partita non è disponibile.',
  fixture_changed: 'I dati della partita sono cambiati. Aggiorna per una nuova valutazione.',
  deployment_changed: 'La versione operativa di C è cambiata. Aggiorna l’anteprima.',
  odds_cache_only: 'Non sono disponibili quote aggiornate nella cache.',
  odds_credit_budget_exhausted: 'Il budget disponibile per aggiornare le quote è esaurito.',
};

function previewReason(reason: string | null): string | null {
  if (!reason) return null;
  if (reasons[reason]) return reasons[reason];
  const translated = decisionReason(reason);
  return translated === reason && /^[a-z0-9_]+$/.test(reason)
    ? 'Dati o quote non hanno superato i controlli richiesti.' : translated;
}

interface ChallengerPreviewCardProps {
  preview?: ChallengerPreview;
  loading?: boolean;
  error?: string;
  ineligible?: boolean;
  onRetry: () => void;
  actions?: React.ReactNode;
}

export default function ChallengerPreviewCard({ preview, loading, error, ineligible, onRetry, actions }: ChallengerPreviewCardProps) {
  const [, setClock] = useState(0);
  useEffect(() => {
    if (!preview || !['RECOMMENDED', 'NO_BET'].includes(preview.status)) return;
    const expires = Math.min(Date.parse(preview.kickoffAt || ''), Date.parse(preview.expiresAt || ''));
    if (!Number.isFinite(expires) || expires <= Date.now()) return;
    const timer = window.setTimeout(() => setClock((value) => value + 1), Math.min(2_147_483_647, expires - Date.now() + 1));
    return () => window.clearTimeout(timer);
  }, [preview]);
  const expired = preview ? challengerPreviewExpired(preview) : false;
  const selected = !expired && preview?.status === 'RECOMMENDED' ? preview.recommendationPacket?.selected : null;
  const quote = selected ? preview?.quote : null;
  const unavailable = error || ineligible || expired || !preview || ['UNAVAILABLE', 'NOT_ELIGIBLE', 'ARCHIVED'].includes(preview.status);
  return <div className="challenger-preview">
    <p className="match-model-advice__origin">Anteprima C · non registrata</p>
    {loading ? <p role="status">Calcolo dell’anteprima C…</p> : <>
      <h3>{selected ? selected.selectionLabel || fmtSelection(selected.selection)
        : expired ? 'Anteprima scaduta' : preview?.status === 'NO_BET' ? 'Nessuna giocata consigliata' : 'Consiglio non ancora disponibile'}</h3>
      {error && <p role="alert">{error}</p>}
      {ineligible && <p>L’anteprima C è disponibile solo prima dell’inizio della partita.</p>}
      {expired && <p role="status">{reasons.challenger_preview_expired}</p>}
      {!expired && preview?.reason && <p>{previewReason(preview.reason)}</p>}
      {selected && quote && <dl className="match-model-advice__metrics">
        <div><dt>Quota dell’anteprima</dt><dd>{quote.odds.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</dd></div>
        <div><dt>Bookmaker</dt><dd>{quote.bookmaker}</dd></div>
        <div><dt>Valutata il</dt><dd>{dateTime(preview?.asOf)}</dd></div>
        <div><dt>Quota rilevata il</dt><dd>{dateTime(quote.updatedAt)}</dd></div>
      </dl>}
      {preview?.status === 'NO_BET' && !expired && <>
        <p>La valutazione C non ha selezionato una giocata con le quote disponibili.</p>
        <p className="match-model-advice__footnote">Valutata il {dateTime(preview.asOf)}.</p>
      </>}
      <p className="challenger-preview__registration">Nessuna puntata registrata.</p>
      {selected && <p>Stake indicativo: 1%. L’anteprima non addebita il portafoglio.</p>}
      {selected && quote && actions}

      {unavailable && !ineligible && <button type="button" className="fp-btn fp-btn-ghost fp-btn-sm" onClick={onRetry}>Riprova anteprima C</button>}
    </>}
  </div>;
}
