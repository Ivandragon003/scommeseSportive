import React, { useState } from 'react';
import { ResearchComparisonQuery } from '../research/researchComparisonTypes';
import EquityChart from '../research/ResearchEquityChart';
import '../research/research.css';
import {
  useAppWalletData, WalletBalanceCards, WalletBetTable, walletBetFamily, WalletLoadState,
  WalletModelFilter, WalletModelPicker, walletMoney, walletPercent,
} from './AppWallets';

const initialModel = (): WalletModelFilter => {
  const value = new URLSearchParams(window.location.search).get('model');
  return value === 'A' || value === 'C' ? value : 'all';
};

export function WalletPeriodPicker({ query, onChange }: { query: ResearchComparisonQuery; onChange: (query: ResearchComparisonQuery) => void }) {
  const [custom, setCustom] = useState(query.period === 'custom');
  const [from, setFrom] = useState(query.from || '');
  const [to, setTo] = useState(query.to || '');
  return <div className="app-wallet-toolbar">
    <label className="app-wallet-filter">Periodo<select aria-label="Periodo" value={custom ? 'custom' : query.period}
      onChange={(event) => { const value = event.target.value as ResearchComparisonQuery['period']; setCustom(value === 'custom'); if (value !== 'custom') onChange({ period: value }); }}>
      <option value="all">Dall’apertura dei portafogli</option><option value="7d">Ultimi 7 giorni</option><option value="30d">Ultimi 30 giorni</option><option value="90d">Ultimi 90 giorni</option><option value="custom">Periodo personalizzato</option>
    </select></label>
    {custom && <form className="app-wallet-toolbar" onSubmit={(event) => { event.preventDefault(); if (from && to && from <= to) onChange({ period: 'custom', from, to }); }}>
      <label className="app-wallet-filter">Dal<input aria-label="Dal" type="date" required value={from} onChange={(event) => setFrom(event.target.value)} /></label>
      <label className="app-wallet-filter">Al<input aria-label="Al" type="date" required min={from || undefined} value={to} onChange={(event) => setTo(event.target.value)} /></label>
      <button type="submit" className="fp-btn fp-btn-ghost" disabled={!from || !to || from > to}>Applica periodo</button>
    </form>}
  </div>;
}

function LegacyArea({ children }: { children?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  if (!children) return null;
  return <section className="app-wallet-legacy"><button type="button" className="fp-btn fp-btn-ghost" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
    {open ? 'Chiudi storico precedente' : 'Storico precedente'}</button>
    {open && <><p>Gestione precedente, in sola lettura. Questi importi non vengono sommati ai portafogli A e C.</p>{children}</>}
  </section>;
}

export function WalletBetsPage({ legacy }: { legacy?: React.ReactNode }) {
  const [model, setModel] = useState<WalletModelFilter>(initialModel);
  const [query, setQuery] = useState<ResearchComparisonQuery>({ period: 'all' });
  const [status, setStatus] = useState('all');
  const { data, loading, error, refresh } = useAppWalletData(query);
  const portfolios = (data?.portfolios || []).filter((row) => model === 'all' || row.family === model);
  const rows = (data?.bets.rows || []).filter((bet) => (model === 'all' || walletBetFamily(bet) === model)
    && (status === 'all' || (status === 'open' ? bet.status === 'PENDING' : bet.status !== 'PENDING')));
  return <div className="bm-wrap app-wallet-page">
    <header className="app-wallet-head"><div><h1 className="bm-title">Giocate</h1><p>Giocate registrate e contabilizzate nei portafogli A e C. Tutti gli importi sono virtuali.</p></div>
      <button type="button" className="fp-btn fp-btn-ghost" onClick={refresh} disabled={loading}>Aggiorna giocate</button></header>
    <div className="app-wallet-toolbar"><WalletModelPicker value={model} onChange={setModel} /><label className="app-wallet-filter">Stato<select aria-label="Stato" value={status} onChange={(event) => setStatus(event.target.value)}><option value="all">Tutte</option><option value="open">Aperte</option><option value="closed">Liquidate</option></select></label></div>
    <WalletPeriodPicker query={query} onChange={setQuery} />
    <WalletLoadState loading={loading} error={error} refresh={refresh} />
    {!loading && !error && data && <>
      <WalletBalanceCards portfolios={data.portfolios} model={model} />
      <p className="app-wallet-help">{data.period.label} · Europe/Rome. {portfolios.map((row) => `Modello ${row.family}: ${row.betCount ?? '—'} giocate registrate`).join(' · ')}.</p>
      <WalletBetTable rows={rows} model={model} emptyText={data.bets.truncated
        ? 'Nessuna giocata di questo filtro nelle righe caricate. Il riepilogo comprende l’intero periodo.'
        : undefined} />
      {data.bets.truncated && <p role="status">Mostrate fino a {data.bets.rows.length} delle {data.bets.total} giocate, prima dei filtri modello e stato. I riepiloghi comprendono l’intero periodo.</p>}
    </>}
    <LegacyArea>{legacy}</LegacyArea>
  </div>;
}

export function WalletBudgetPage({ legacy }: { legacy?: React.ReactNode }) {
  const [model, setModel] = useState<WalletModelFilter>(initialModel);
  const [query, setQuery] = useState<ResearchComparisonQuery>({ period: 'all' });
  const { data, loading, error, refresh } = useAppWalletData(query);
  const portfolios = (data?.portfolios || []).filter((row) => model === 'all' || row.family === model);
  return <div className="bm-wrap app-wallet-page">
    <header className="app-wallet-head"><div><h1 className="bm-title">Budget</h1><p>Due portafogli indipendenti, aggiornati dalle giocate e dalle liquidazioni dell’app.</p></div>
      <button type="button" className="fp-btn fp-btn-ghost" onClick={refresh} disabled={loading}>Aggiorna budget</button></header>
    <WalletModelPicker value={model} onChange={setModel} />
    <WalletLoadState loading={loading} error={error} refresh={refresh} />
    {!loading && !error && data && <>
      <WalletBalanceCards portfolios={data.portfolios} model={model} />
      <p className="app-wallet-help">Il patrimonio è disponibile più impegnato. L’impegnato non è una perdita. I capitali A e C restano separati; esposizione massima 5% per ciascuno.</p>
      <WalletPeriodPicker query={query} onChange={setQuery} />
      <div className="app-wallet-balances">{portfolios.map((row) => <section className="app-wallet-section" aria-label={`Risultati modello ${row.family}`} key={row.portfolioId}>
        <h2>Risultati {row.family}</h2><p>{data.period.label}</p><dl className="app-wallet-period-metrics">
          <div><dt>Giocate registrate</dt><dd>{row.betCount ?? '—'}</dd></div><div><dt>Importo registrato</dt><dd>{walletMoney(row.stakeCents)}</dd></div>
          <div><dt>Profitto liquidato</dt><dd>{walletMoney(row.profitCents)}</dd></div><div><dt>ROI sulle liquidate</dt><dd>{walletPercent(row.roi)}</dd></div>
          <div><dt>Giocate liquidate</dt><dd>{row.settledCount ?? '—'}</dd></div><div><dt>Importo liquidato</dt><dd>{walletMoney(row.settledStakeCents)}</dd></div>
          <div><dt>Vinte, incluse mezze vincite</dt><dd>{row.wonCount ?? '—'}</dd></div><div><dt>Perse, incluse mezze perdite</dt><dd>{row.lostCount ?? '—'}</dd></div>
        </dl>
      </section>)}</div>
      <p className="app-wallet-help">Le statistiche usano tutte le registrazioni del periodo. Profitto e ROI comprendono le liquidazioni avvenute nel periodo, anche per giocate registrate prima.</p>
      {model === 'all' && <section className="app-wallet-section"><h2>Andamento A/C</h2><EquityChart
        a={data.portfolios.find((row) => row.family === 'A')?.equity}
        c={data.portfolios.find((row) => row.family === 'C')?.equity}
        title="Patrimoni A e C nel tempo" /></section>}
    </>}
    <LegacyArea>{legacy}</LegacyArea>
  </div>;
}
