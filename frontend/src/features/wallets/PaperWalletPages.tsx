import { ReactNode, useCallback, useEffect, useState } from 'react';
import { AppSelect } from '../../components/common/AppSelect';
import { getPaperBets, PaperBet, PaperBetsData, PaperMetrics } from '../../utils/paperBetsApi';
import { opportunityLabel } from '../prediction-archive/predictionArchivePresentation';
import { WalletLoadState, WalletModelFilter, WalletModelPicker, walletBetStatus, walletDateTime, walletMarketLabel } from './AppWallets';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import '../research/research.css';

export const paperUnits = (value: number | null | undefined): string => typeof value === 'number' && Number.isFinite(value)
  ? `${value.toLocaleString('it-IT', { maximumFractionDigits: 4 })} u` : '—';
const percent = (value: number | null) => value == null ? '—' : `${value.toLocaleString('it-IT', { maximumFractionDigits: 2 })}%`;

export function usePaperBetsData() {
  const [data, setData] = useState<PaperBetsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision(value => value + 1), []);
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true); setError(null);
    getPaperBets(controller.signal).then(value => { if (active) setData(value); })
      .catch(failure => { if (active) setError(failure instanceof Error ? failure.message : 'Giocate paper non disponibili.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; controller.abort(); };
  }, [revision]);
  useEffect(() => {
    const onReturn = () => { if (document.visibilityState !== 'hidden') refresh(); };
    window.addEventListener('data-sync-complete', onReturn);
    window.addEventListener('focus', onReturn);
    return () => { window.removeEventListener('data-sync-complete', onReturn); window.removeEventListener('focus', onReturn); };
  }, [refresh]);
  return { data, loading, error, refresh };
}

function PreviousHistory({ children }: { children?: ReactNode }) {
  const [open, setOpen] = useState(false);
  return children ? <section className="app-wallet-legacy">
    <button type="button" className="fp-btn fp-btn-ghost" aria-expanded={open} onClick={() => setOpen(value => !value)}>{open ? 'Chiudi storico precedente' : 'Storico precedente'}</button>
    {open && <><p>Registrazioni precedenti e manuali, con importi originali. Sono separate dalle giocate paper e dai risultati in unità.</p>{children}</>}
  </section> : null;
}

export function PaperMetricsCard({ metrics, family }: { metrics: PaperMetrics; family?: string }) {
  return <section className="app-wallet-card" aria-label={family ? `Risultati paper modello ${family}` : 'Riepilogo giocate paper'}>
    <h2>{family ? `Modello ${family}` : 'Risultati paper'}</h2><p>1 unità per selezione</p>
    <dl className="app-wallet-period-metrics">
      <div><dt>Giocate registrate</dt><dd>{metrics.totalCount}</dd></div>
      <div><dt>Aperte</dt><dd>{metrics.openCount}</dd></div>
      <div><dt>Liquidate</dt><dd>{metrics.settledCount}</dd></div>
      <div><dt>Unità registrate</dt><dd>{paperUnits(metrics.totalStakeUnits)}</dd></div>
      <div><dt>Unità liquidate</dt><dd>{paperUnits(metrics.settledStakeUnits)}</dd></div>
      <div><dt>Ritorno liquidato</dt><dd>{paperUnits(metrics.returnUnits)}</dd></div>
      <div><dt>Profitto liquidato</dt><dd>{paperUnits(metrics.profitUnits)}</dd></div>
      <div><dt>ROI sulle liquidate</dt><dd>{percent(metrics.roiPercent)}</dd></div>
      <div><dt>Percentuale vinte</dt><dd>{percent(metrics.winRatePercent)}</dd></div>
    </dl>
  </section>;
}

export function PaperBetTable({ rows }: { rows: PaperBet[] }) {
  if (!rows.length) return <p className="app-wallet-empty">Nessuna giocata paper nei filtri scelti.</p>;
  return <div className="app-wallet-bets" aria-label="Giocate paper registrate">{rows.map(bet => {
    const [home, away] = (bet.matchLabel || '').split(/\s+[–—-]\s+/);
    return <article className="app-wallet-bet" key={bet.id} aria-label={`${bet.family} · ${bet.matchLabel || bet.matchId}`}>
      <div className="app-wallet-bet-main"><span className={`app-wallet-model app-wallet-model--${bet.family}`}>Modello {bet.family}</span>
        <div className="app-wallet-match"><h3>{bet.matchLabel || bet.matchId}</h3><p>{bet.league}{bet.kickoffAt ? ` · ${walletDateTime(bet.kickoffAt)}` : ''}</p>
          <strong>{opportunityLabel(bet.market, bet.selection, home, away, bet.quote)}</strong><small>{walletMarketLabel(bet.market)}</small></div>
        <div><small>Quota registrata</small><strong>{bet.odds.toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</strong><small>{bet.quote?.bookmaker || bet.bookmaker || 'Bookmaker non disponibile'}</small></div>
        <div><small>Unità</small><strong>{paperUnits(bet.stakeUnits)}</strong></div>
        <span className={`app-wallet-status is-${bet.status.toLowerCase()}`}>{walletBetStatus(bet.status)}</span>
      </div><details className="app-wallet-bet-detail"><summary>Dettagli della giocata</summary><dl>
        <div><dt>Registrata</dt><dd>{walletDateTime(bet.createdAt || bet.placedAt)}</dd></div>
        <div><dt>Classificazione registrata</dt><dd>{bet.classification || bet.confidence || 'Non registrata'}</dd></div>
        <div><dt>Ritorno liquidato</dt><dd>{paperUnits(bet.returnUnits)}</dd></div>
        <div><dt>Profitto liquidato</dt><dd>{paperUnits(bet.profitUnits)}</dd></div>
      </dl><p>Quota reale archiviata alla registrazione, non un prezzo corrente.</p></details>
    </article>;
  })}</div>;
}

function PaperProfitChart({ data, model }: { data: PaperBetsData; model: WalletModelFilter }) {
  const portfolios = data.portfolios.filter(row => model === 'all' || row.family === model);
  const points = new Map<string, { at: string; A?: number; C?: number }>();
  const first = portfolios.flatMap(row => row.history).map(point => point.at).sort()[0];
  if (!first) return <p>Nessuna liquidazione paper: il grafico comparirà con i primi risultati.</p>;
  const initialAt = new Date(Date.parse(first) - 1).toISOString();
  points.set(initialAt, { at: initialAt, ...Object.fromEntries(portfolios.map(row => [row.family, 0])) });
  portfolios.forEach(row => row.history.forEach(point => points.set(point.at, { ...points.get(point.at), at: point.at, [row.family]: point.profitUnits })));
  return <figure className="research-chart" aria-label="Profitto cumulato in unità"><figcaption>Profitto cumulato in unità</figcaption>
    <p>Solo liquidazioni paper. Ogni selezione vale 1 unità.</p><div className="research-chart__plot"><ResponsiveContainer width="100%" height="100%"><LineChart data={Array.from(points.values()).sort((a, b) => a.at.localeCompare(b.at))}>
      <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" /><XAxis dataKey="at" tickFormatter={value => new Date(value).toLocaleDateString('it-IT')} /><YAxis tickFormatter={value => `${value} u`} />
      <Tooltip formatter={(value: number) => paperUnits(value)} labelFormatter={value => walletDateTime(String(value))} /><Legend />
      {portfolios.map(row => <Line key={row.family} dataKey={row.family} name={`Modello ${row.family}`} type="stepAfter" stroke={row.family === 'A' ? 'var(--blue)' : 'var(--purple)'} connectNulls isAnimationActive={false} />)}
    </LineChart></ResponsiveContainer></div></figure>;
}

export default function PaperWalletPage({ kind, legacy }: { kind: 'bets' | 'budget' | 'archive'; legacy?: ReactNode }) {
  const requested = new URLSearchParams(window.location.search).get('model');
  const [model, setModel] = useState<WalletModelFilter>(requested === 'A' || requested === 'C' ? requested : 'all');
  const [status, setStatus] = useState(kind === 'archive' ? 'closed' : 'all');
  const [page, setPage] = useState(0);
  const { data, loading, error, refresh } = usePaperBetsData();
  const title = kind === 'budget' ? 'Budget' : kind === 'archive' ? 'Archivio' : 'Giocate';
  const rows = (data?.bets || []).filter(bet => (model === 'all' || bet.family === model)
    && (status === 'all' || (status === 'open' ? bet.status === 'PENDING' : bet.status !== 'PENDING')));
  const pageSize = 50;
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const currentPage = Math.min(page, pages - 1);
  return <main className={`bm-wrap app-wallet-page ${kind === 'budget' ? 'wallet-budget-page' : ''}`}>
    <header className="app-wallet-head"><div><h1 className="bm-title">{title}</h1><p>Giocate automatiche paper A e C · 1 unità per selezione.</p></div>
      <button type="button" className="fp-btn fp-btn-ghost" disabled={loading} onClick={refresh}>Aggiorna {title.toLowerCase()}</button></header>
    <div className="app-wallet-toolbar"><WalletModelPicker value={model} onChange={value => { setModel(value); setPage(0); }} />
      {kind !== 'budget' && <label className="app-wallet-filter">Stato<AppSelect aria-label="Stato" value={status} onChange={value => { setStatus(value); setPage(0); }} options={[{value:'all',label:'Tutte'},{value:'open',label:'Aperte'},{value:'closed',label:'Liquidate'}]} /></label>}</div>
    <WalletLoadState loading={loading} error={error} refresh={refresh} />
    {!loading && !error && data && <><div className="app-wallet-balances">{data.portfolios.filter(row => model === 'all' || row.family === model).map(row => <PaperMetricsCard key={row.family} family={row.family} metrics={row} />)}</div>
      <p className="app-wallet-help">Risultati dall’apertura del registro paper. ROI = profitto / unità liquidate. La percentuale vinte esclude i rimborsi e include le mezze vincite. Nessuna registrazione viene creata aprendo questa pagina.</p>
      {kind === 'budget' ? <section className="wallet-budget-chart"><PaperProfitChart data={data} model={model} /></section> : <>
        <p role="status">{rows.length} giocate nei filtri · Pagina {currentPage + 1} di {pages}</p>
        <PaperBetTable rows={rows.slice(currentPage * pageSize, (currentPage + 1) * pageSize)} />
        {pages > 1 && <nav className="app-wallet-toolbar" aria-label="Pagine giocate"><button type="button" className="fp-btn fp-btn-ghost" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Pagina precedente</button><button type="button" className="fp-btn fp-btn-ghost" disabled={currentPage + 1 >= pages} onClick={() => setPage(currentPage + 1)}>Pagina successiva</button></nav>}
      </>}
    </>}
    <PreviousHistory>{legacy}</PreviousHistory>
  </main>;
}
