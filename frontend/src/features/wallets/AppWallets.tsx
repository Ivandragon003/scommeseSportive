import React, { useCallback, useEffect, useRef, useState } from 'react';
import { getAppWallets } from '../../utils/walletApi';
import { opportunityLabel, opportunityMarketLabel } from '../prediction-archive/predictionArchivePresentation';
import { ComparisonBet, ComparisonPortfolio, ResearchComparison, ResearchComparisonQuery } from '../research/researchComparisonTypes';
import './wallets.css';

export type WalletModelFilter = 'all' | 'A' | 'C';

export const walletMoney = (cents: unknown): string => typeof cents === 'number' && Number.isFinite(cents)
  ? new Intl.NumberFormat('it-IT', { style: 'currency', currency: 'EUR' }).format(cents / 100) : '—';
export const walletPercent = (value: unknown): string => typeof value === 'number' && Number.isFinite(value)
  ? `${(value * 100).toLocaleString('it-IT', { maximumFractionDigits: 2 })}%` : '—';
export const walletDateTime = (value?: string | null): string => {
  if (!value || !Number.isFinite(Date.parse(value))) return '—';
  return new Intl.DateTimeFormat('it-IT', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Europe/Rome' }).format(new Date(value));
};
export const walletBetFamily = (bet: ComparisonBet): 'A' | 'C' | null => bet.family === 'A' || bet.family === 'C'
  ? bet.family : bet.portfolioId === 'shadow_A' ? 'A' : bet.portfolioId === 'shadow_C' ? 'C' : null;
export const walletBetReturn = (bet: ComparisonBet): number | null => ['WON', 'LOST', 'VOID', 'HALF_WON', 'HALF_LOST', 'SETTLED'].includes(bet.status)
  && typeof bet.profitCents === 'number' && Number.isFinite(bet.profitCents)
  ? bet.stakeCents + bet.profitCents : null;
export const walletBetSelection = (bet: ComparisonBet): string => {
  const [home, away] = (bet.matchLabel || '').split(/\s+[–—-]\s+/);
  return opportunityLabel(bet.market || '', bet.selection, home, away);
};
export const walletBetStatus = (status: string): string => ({
  PENDING: 'Aperta', WON: 'Vinta', LOST: 'Persa', VOID: 'Rimborsata',
  HALF_WON: 'Mezza vincita', HALF_LOST: 'Mezza perdita', SETTLED: 'Liquidata',
} as Record<string, string>)[status] || 'Esito non disponibile';

export function useAppWalletData(query: ResearchComparisonQuery) {
  const [data, setData] = useState<ResearchComparison | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const lastFetchAt = useRef(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  const { period, from, to } = query;
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    lastFetchAt.current = Date.now();
    setLoading(true); setError(null); setData(null);
    getAppWallets({ period, ...(from ? { from } : {}), ...(to ? { to } : {}) }, controller.signal)
      .then((value) => { if (active) setData(value); })
      .catch((failure) => { if (active) setError(failure?.response?.data?.error || failure?.message || 'Portafogli non disponibili.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [period, from, to, revision]);
  useEffect(() => {
    let pending: ReturnType<typeof setTimeout> | null = null;
    const queueRefresh = (afterSync = false) => {
      if (document.visibilityState === 'hidden' || pending !== null) return;
      if (!afterSync && Date.now() - lastFetchAt.current < 30_000) return;
      pending = setTimeout(() => { pending = null; refresh(); }, 100);
    };
    const onReturn = () => queueRefresh();
    const onSync = () => queueRefresh(true);
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener('data-sync-complete', onSync);
    return () => {
      if (pending !== null) clearTimeout(pending);
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener('data-sync-complete', onSync);
    };
  }, [refresh]);
  return { data, loading, error, refresh };
}

export function WalletModelPicker({ value, onChange }: { value: WalletModelFilter; onChange: (value: WalletModelFilter) => void }) {
  return <label className="app-wallet-filter">Modello<select aria-label="Modello" value={value}
    onChange={(event) => onChange(event.target.value as WalletModelFilter)}>
    <option value="all">A e C a confronto</option><option value="A">Modello A</option><option value="C">Modello C</option>
  </select></label>;
}

export function WalletLoadState({ loading, error, refresh }: { loading: boolean; error: string | null; refresh: () => void }) {
  if (loading) return <p role="status">Caricamento portafogli e giocate…</p>;
  if (error) return <div role="alert" className="app-wallet-error"><p>{error}</p><button type="button" className="fp-btn fp-btn-solid" onClick={refresh}>Riprova</button></div>;
  return null;
}

export function WalletBalanceCards({ portfolios, model }: { portfolios: ComparisonPortfolio[]; model: WalletModelFilter }) {
  return <div className="app-wallet-balances">{portfolios.filter((row) => model === 'all' || row.family === model).map((row) =>
    <section className="app-wallet-card" key={row.portfolioId} aria-label={`Portafoglio ${row.family}`}>
      <h2>Portafoglio {row.family}</h2><p>{row.family === 'A' ? 'Modello statistico · importo del consiglio' : 'Modello ibrido · Challenger · stake fisso 1%'}</p>
      {row.initialized === false ? <p>Portafoglio non disponibile. Nessun saldo viene ricreato da questa pagina.</p> : <dl>
        <div><dt>Disponibile</dt><dd>{walletMoney(row.currentAvailableCents)}</dd></div>
        <div><dt>Impegnato</dt><dd>{walletMoney(row.currentCommittedCents)}</dd></div>
        <div><dt>Patrimonio attuale</dt><dd>{walletMoney(row.currentEquityCents)}</dd></div>
        <div><dt>Capitale iniziale</dt><dd>{walletMoney(row.initialCents)}</dd></div>
      </dl>}
    </section>)}</div>;
}

export function WalletBetTable({ rows, model, emptyText = 'Nessuna giocata registrata nel periodo.', onInspectBet }: {
  rows: ComparisonBet[]; model: WalletModelFilter; emptyText?: string; onInspectBet?: (bet: ComparisonBet) => void;
}) {
  const visible = rows.filter((bet) => model === 'all' || walletBetFamily(bet) === model);
  if (!visible.length) return <p className="app-wallet-empty">{emptyText}</p>;
  return <div className="app-wallet-bets" aria-label="Giocate registrate">{visible.map((bet) => {
    const family = walletBetFamily(bet);
    const returned = walletBetReturn(bet);
    const bookmaker = bet.quote?.bookmaker || bet.bookmaker || 'Bookmaker non disponibile';
    return <article className="app-wallet-bet" key={bet.id} aria-label={`${family || 'Modello non disponibile'} · ${bet.matchLabel || bet.matchId || 'Partita non disponibile'}`}>
      <div className="app-wallet-bet-main"><span className="app-wallet-model">Modello {family || 'non disponibile'}</span>
        <div className="app-wallet-match"><h3>{bet.matchLabel || bet.matchId || 'Partita non disponibile'}</h3><p>{bet.league}{bet.kickoffAt ? ` · ${walletDateTime(bet.kickoffAt)}` : ''}</p>
          <strong>{walletBetSelection(bet)}</strong><small>{opportunityMarketLabel(bet.market)}</small></div>
        <div><small>Quota registrata</small><strong>{Number.isFinite(bet.odds) ? bet.odds.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'}</strong><small>{bookmaker}</small></div>
        <div><small>Importo</small><strong>{walletMoney(bet.stakeCents)}</strong></div>
        <span className={`app-wallet-status is-${bet.status.toLowerCase()}`}>{walletBetStatus(bet.status)}</span>
      </div>
      <details className="app-wallet-bet-detail"><summary>Dettagli della giocata</summary><dl>
        <div><dt>Registrata</dt><dd>{walletDateTime(bet.createdAt)}</dd></div>
        <div><dt>Quota rilevata</dt><dd>{walletDateTime(bet.quote?.updatedAt || bet.quote?.capturedAt)}</dd></div>
        <div><dt>Ritorno liquidato</dt><dd>{walletMoney(returned)}</dd></div>
        <div><dt>Profitto liquidato</dt><dd>{walletMoney(bet.profitCents)}</dd></div>
      </dl><p>Quota archiviata alla registrazione, non un prezzo corrente.</p>
        {bet.quote?.source && <p>Fonte quota: {bet.quote.source} · {bookmaker}</p>}
        {onInspectBet && <button type="button" className="fp-btn fp-btn-ghost" onClick={() => onInspectBet(bet)}>Apri pronostico registrato</button>}
      </details>
    </article>;
  })}</div>;
}
