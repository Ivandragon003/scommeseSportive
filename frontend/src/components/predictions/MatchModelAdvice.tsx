import OpportunityQuality from './OpportunityQuality';
import React, { useEffect } from 'react';
import { dateTime, decisionReason, money, stateLabel } from '../../features/research/researchPresentation';
import { AdviceFamily, RecordedModelAdvice } from '../../utils/matchModelAdviceApi';
import { fmtSelection } from './predictionFormatting';
import { ModelAdviceCoordinator, useMatchModelAdvice } from '../../hooks/useMatchModelAdvice';
import ChallengerPreviewCard from './ChallengerPreviewCard';
import './matchModelAdvice.css';
import type { BestValueOpportunity } from './predictionTypes';

interface MatchModelAdviceProps {
  registeredFamilies?: Array<'A' | 'C'>;
  matchId: string;
  fallbackA: React.ReactNode;
  refreshKey?: number;
  onRecordedA?: (matchId: string, available: boolean) => void;
  kickoffAt?: string;
  finished?: boolean;
  coordinator?: ModelAdviceCoordinator;
  renderActions?: (family: AdviceFamily, opportunity: BestValueOpportunity, registered?: boolean, quoteCapturedAt?: string | null) => React.ReactNode;
}

const executionBlocks = new Set(['virtual_exposure_limit', 'insufficient_virtual_capital', 'one_bet_per_portfolio_match']);
const sportingAbstentions = new Set(['app_no_recommendation', 'challenger_no_recommendation', 'model_abstained']);

function reasonLabel(reason?: string): string {
  if (!reason || typeof reason !== 'string') return 'Nessun motivo aggiuntivo registrato.';
  const translated = decisionReason(reason);
  return translated === reason && /^[a-z0-9_]+$/.test(reason)
    ? 'La valutazione non ha superato i controlli richiesti.' : translated;
}

function archivedQuote(decision: RecordedModelAdvice): RecordedModelAdvice['quote'] | null {
  const selected = decision.recommendationPacket?.selected;
  const quote = decision.quote;
  if (!selected || !quote || quote.selection !== selected.selection || typeof quote.odds !== 'number'
    || !Number.isFinite(quote.odds) || quote.odds <= 1 || typeof quote.bookmaker !== 'string' || !quote.bookmaker.trim()
    || typeof quote.source !== 'string' || !quote.source.trim()
    || /model|synthetic|estimated/i.test(quote.source)
    || (selected.bookmakerOdds !== undefined && selected.bookmakerOdds !== quote.odds)
    || (decision.selection && decision.selection !== selected.selection)
    || (selected.bookmakerName && selected.bookmakerName.trim().toLowerCase() !== quote.bookmaker.trim().toLowerCase())) return null;
  return quote;
}

function RecordedAdvice({ decision, renderActions }: { decision: RecordedModelAdvice; renderActions?: MatchModelAdviceProps['renderActions'] }) {
  const packet = decision.recommendationPacket;
  const selected = packet?.selected;
  const blockedExecution = decision.action === 'ABSTAIN' && executionBlocks.has(decision.reason || '');
  const technical = !packet || (decision.action === 'BET' && !selected) || (decision.action === 'ABSTAIN'
    && !blockedExecution && !(sportingAbstentions.has(decision.reason || '') && !selected && packet.decisionStatus === 'NO_BET'));
  const validSelection = !technical && !!selected && (!decision.selection || decision.selection === selected.selection);
  const quote = validSelection ? archivedQuote(decision) : null;
  const funded = !!decision.betId;
  const amount = funded
    ? (typeof decision.stakeCents === 'number' && Number.isSafeInteger(decision.stakeCents) && decision.stakeCents > 0
      ? money(decision.stakeCents) : 'Non disponibile')
    : decision.action === 'ABSTAIN' ? money(0) : 'Non disponibile';
  const status = funded ? stateLabel(decision.betStatus || 'BET')
    : decision.action === 'ABSTAIN' ? 'Nessuna puntata registrata' : 'Registrazione non verificabile';
  return <>
    <p className="match-model-advice__origin">Decisione Nightly archiviata</p>
    <h3>{validSelection ? selected.selectionLabel || fmtSelection(selected.selection)
      : technical || selected ? 'Valutazione non utilizzabile' : 'Nessuna giocata consigliata'}</h3>
    {validSelection && selected && <OpportunityQuality opportunity={selected} />}
    {validSelection && blockedExecution && <p>Il modello ha consigliato questa giocata, ma non è stata registrata.</p>}
    {decision.reason && <p>{reasonLabel(decision.reason)}</p>}
    {technical && !decision.reason && <p>La valutazione non è stata completata o non ha superato i controlli.</p>}
    <dl className="match-model-advice__metrics">
      <div><dt>Quota archiviata</dt><dd>{quote ? quote.odds.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : 'Non disponibile'}</dd></div>
      <div><dt>Bookmaker</dt><dd>{quote?.bookmaker || 'Non disponibile'}</dd></div>
      <div><dt>Importo virtuale registrato</dt><dd>{amount}</dd></div>
      <div><dt>Stato della puntata</dt><dd>{status === 'BET' ? 'Registrata' : status}</dd></div>
      <div><dt>Valutata il</dt><dd>{dateTime(decision.forecastAt || packet?.asOf)}</dd></div>
      <div><dt>Quota rilevata il</dt><dd>{quote ? dateTime(quote.updatedAt || quote.capturedAt) : 'Non disponibile'}</dd></div>
    </dl>
    <p className="match-model-advice__footnote">Le quote archiviate non sono quote correnti.</p>
    {validSelection && !quote && <p role="status">La quota conservata non è disponibile o non corrisponde al consiglio.</p>}
    {validSelection && selected && quote && renderActions?.(decision.family, { ...selected,
      marketName: (selected as BestValueOpportunity).marketName || 'Selezione del modello', bookmakerOdds: quote.odds,
      bookmakerName: quote.bookmaker }, funded, quote.updatedAt || quote.capturedAt)}
  </>;
}

export default function MatchModelAdvice({ matchId, fallbackA, refreshKey = 0, onRecordedA, kickoffAt, finished = false, coordinator: controlled, renderActions, registeredFamilies = [] }: MatchModelAdviceProps) {
  const internal = useMatchModelAdvice();
  const coordinator = controlled ?? internal;
  const { prepare, cancel } = internal;
  useEffect(() => {
    if (controlled) return;
    void prepare({ matchId, kickoffAt, finished });
    return cancel;
  }, [controlled, prepare, cancel, matchId, kickoffAt, finished, refreshKey]);
  const state = coordinator.state;
  useEffect(() => { onRecordedA?.(matchId, state.matchId === matchId && !!state.data?.A); }, [onRecordedA, matchId, state.matchId, state.data]);
  const current: typeof state = state.matchId === matchId ? state : { matchId, loading: true };
  const familyCard = (family: AdviceFamily) => {
    const decision = current.data?.[family];
    const error = current.data?.errors?.[family] || current.error;
    if (family === 'A' && !decision) return <div className="match-model-advice__fallback" key={family}>
      {fallbackA}
      {current.loading && <p role="status">Verifica del consiglio Nightly A archiviato…</p>}
      {error && <p role="alert">{error} Il consiglio A mostrato sopra rimane distinto da questo archivio.</p>}
    </div>;
    return <section key={family} className="match-model-advice__card" aria-label={`Consiglio modello ${family}`}>
      <h2>Modello {family}</h2>
      {decision ? <RecordedAdvice decision={decision} renderActions={renderActions} /> : current.loading ? <p role="status">Caricamento del consiglio Nightly {family}…</p>
        : error ? <p role="alert">{error}</p> : <ChallengerPreviewCard registered={registeredFamilies.includes('C')} preview={current.preview} loading={current.previewLoading}
          error={current.previewError} ineligible={current.ineligible} onRetry={() => coordinator.retry()}
          actions={current.preview?.status === 'RECOMMENDED' && current.preview.quote && current.preview.recommendationPacket?.selected
            ? renderActions?.('C', { ...current.preview.recommendationPacket.selected, marketName: 'Selezione del modello C',
              bookmakerOdds: current.preview.quote.odds, bookmakerName: current.preview.quote.bookmaker }, false, current.preview.quote.updatedAt || current.preview.quote.capturedAt) : undefined} />}
    </section>;
  };
  return <div className="match-model-advice">
    <div className="match-model-advice__grid">{familyCard('A')}{familyCard('C')}</div>
    {(current.error || current.data?.errors?.A || current.data?.errors?.C) && <button type="button" className="fp-btn fp-btn-ghost fp-btn-sm" onClick={() => coordinator.retry()}>Riprova consigli A/C</button>}
  </div>;
}
