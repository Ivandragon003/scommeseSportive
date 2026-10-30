import React, { useEffect, useRef, useState } from 'react';
import API from '../../utils/api';
import { ComparisonBet } from '../research/researchComparisonTypes';
import {
  walletBetFamily, walletBetReturn, walletBetSelection, walletBetStatus, walletDateTime, walletMoney,
} from './AppWallets';

interface RecordedWalletDecision {
  id: string;
  matchId: string;
  family: 'A' | 'C';
  modelVersion: string;
  action: 'BET' | 'ABSTAIN';
  selection?: string;
  betId?: string | null;
  confidence?: string | null;
  recommendationPacket?: {
    selected: { selection: string } | null;
    model?: { version?: string };
  } | null;
}

interface RecordedForecastResponse {
  success: boolean;
  error?: string;
  data?: { matchId: string; decisions: RecordedWalletDecision[] };
}

export async function loadWalletBetEvidence(bet: ComparisonBet, signal?: AbortSignal): Promise<RecordedWalletDecision> {
  const family = walletBetFamily(bet);
  if (!bet.matchId || !family) throw new Error('Il riferimento alla giocata archiviata non è disponibile.');
  const response = await API.get<RecordedForecastResponse>('/research/forecasts', { params: { matchId: bet.matchId }, signal });
  const data = response.data;
  if (!data.success || data.data?.matchId !== bet.matchId || !Array.isArray(data.data.decisions)) {
    throw new Error(data.error || 'Pronostico registrato non disponibile.');
  }
  const decisionId = (bet as ComparisonBet & { effectiveExecutionDecisionId?: string }).effectiveExecutionDecisionId;
  const decision = data.data.decisions.find((row) => row.matchId === bet.matchId && row.family === family
    && row.action === 'BET' && row.modelVersion === bet.modelVersion && row.selection === bet.selection
    && (!row.betId || row.betId === bet.id)
    && (decisionId ? row.id === decisionId : row.betId === bet.id));
  const packet = decision?.recommendationPacket;
  if (!decision || !packet || !packet.selected || packet.selected.selection !== bet.selection
    || (packet.model?.version && packet.model.version !== bet.modelVersion)) {
    throw new Error(`Il pronostico archiviato del modello ${family} non è disponibile per questa giocata.`);
  }
  return decision;
}

const classificationLabel = (value?: string | null): string => ({
  HIGH: 'High', MEDIUM: 'Medium', LOW: 'Low', SPECULATIVE: 'Speculativa',
} as Record<string, string>)[String(value || '').toUpperCase()] || 'Non registrata';

export default function WalletBetEvidence({ bet, onClose }: { bet: ComparisonBet; onClose: () => void }) {
  const sectionRef = useRef<HTMLElement>(null);
  const [decision, setDecision] = useState<RecordedWalletDecision | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const family = walletBetFamily(bet);
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sectionRef.current?.focus();
    return () => { if (previous?.isConnected) previous.focus(); };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setDecision(null); setError(null); setLoading(true);
    loadWalletBetEvidence(bet, controller.signal).then((value) => { if (active) setDecision(value); })
      .catch((failure) => { if (active) setError(failure?.response?.data?.error || failure?.message || 'Pronostico registrato non disponibile.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [bet, retry]);

  return <section ref={sectionRef} tabIndex={-1} className="app-wallet-section" aria-label={`Pronostico registrato modello ${family || 'non disponibile'}`}>
    <div className="app-wallet-head"><h2>Pronostico registrato · Modello {family || 'non disponibile'}</h2>
      <button type="button" className="fp-btn fp-btn-ghost" onClick={onClose}>Chiudi pronostico</button></div>
    <h3>{bet.matchLabel || 'Partita archiviata'}</h3><p>{walletBetSelection(bet)}</p>
    <dl className="app-wallet-period-metrics">
      <div><dt>Importo registrato</dt><dd>{walletMoney(bet.stakeCents)}</dd></div>
      <div><dt>Quota registrata</dt><dd>{Number.isFinite(bet.odds) ? bet.odds.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}</dd></div>
      <div><dt>Bookmaker</dt><dd>{bet.quote?.bookmaker || bet.bookmaker || 'Non disponibile'}</dd></div>
      <div><dt>Esito</dt><dd>{walletBetStatus(bet.status)}</dd></div>
      <div><dt>Ritorno liquidato</dt><dd>{walletMoney(walletBetReturn(bet))}</dd></div>
      <div><dt>Profitto liquidato</dt><dd>{walletMoney(bet.profitCents)}</dd></div>
      <div><dt>Registrata il</dt><dd>{walletDateTime(bet.createdAt)}</dd></div>
      <div><dt>Quota rilevata il</dt><dd>{walletDateTime(bet.quote?.updatedAt || bet.quote?.capturedAt)}</dd></div>
    </dl>
    <p>La quota è quella conservata alla registrazione. Il risultato e il ritorno derivano dalla liquidazione della giocata.</p>
    {loading && <p role="status">Caricamento del pronostico registrato…</p>}
    {error && <div role="alert"><p>{error}</p><button type="button" className="fp-btn fp-btn-ghost" onClick={() => setRetry((value) => value + 1)}>Riprova pronostico</button></div>}
    {decision && <dl className="app-wallet-period-metrics">
      <div><dt>Versione del modello</dt><dd>{decision.modelVersion}</dd></div>
      <div><dt>Classificazione registrata</dt><dd>{classificationLabel(decision.confidence)}</dd></div>
    </dl>}
  </section>;
}
