import React, { useState } from 'react';
import { ArrowRight, Lock, RefreshCw, TrendingUp, WalletCards } from 'lucide-react';
import { Link } from 'react-router-dom';
import { ResearchComparisonQuery } from '../research/researchComparisonTypes';
import EquityChart from '../research/ResearchEquityChart';
import '../research/research.css';
import {
  useAppWalletData, WalletBalanceCards, WalletBetTable, walletBetFamily, WalletLoadState,
  WalletModelFilter, WalletModelPicker, walletMoney, walletPercent,
} from './AppWallets';
import ModelBadge from './ModelBadge';

const initialModel = (): WalletModelFilter => {
  const value = new URLSearchParams(window.location.search).get('model');
  return value === 'A' || value === 'C' ? value : 'all';
};

export const walletToday = (now = new Date()): string => {
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value || '';
  return `${part('year')}-${part('month')}-${part('day')}`;
};

export function WalletPeriodPicker({ query, onChange }: { query: ResearchComparisonQuery; onChange: (query: ResearchComparisonQuery) => void }) {
  const [custom, setCustom] = useState(query.period === 'custom');
  const [from, setFrom] = useState(query.from || '');
  const [to, setTo] = useState(query.to || '');
  const today = walletToday();
  const todaySelected = !custom && query.period === 'custom' && query.from === today && query.to === today;
  return <div className="app-wallet-toolbar">
    <label className="app-wallet-filter">Periodo<select aria-label="Periodo" value={custom ? 'custom' : todaySelected ? 'today' : query.period}
      onChange={(event) => {
        const value = event.target.value;
        setCustom(value === 'custom');
        if (value === 'today') { onChange({ period: 'custom', from: today, to: today }); return; }
        if (value !== 'custom') onChange({ period: value as ResearchComparisonQuery['period'] });
      }}>
      <option value="all">Dall’apertura dei portafogli</option><option value="today">Oggi</option><option value="7d">Ultimi 7 giorni</option><option value="30d">Ultimi 30 giorni</option><option value="90d">Ultimi 90 giorni</option><option value="custom">Periodo personalizzato</option>
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
      <p className="app-wallet-help">{query.period === 'custom' && query.from === walletToday() && query.to === walletToday() ? 'Giocate registrate oggi' : data.period.label} · Orari italiani. {portfolios.map((row) => `Modello ${row.family}: ${row.betCount ?? '—'} giocate registrate`).join(' · ')}.</p>
      <WalletBetTable rows={rows} model={model} emptyText={data.bets.truncated
        ? 'Nessuna giocata di questo filtro nelle righe caricate. Il riepilogo comprende l’intero periodo.'
        : undefined} />
      {data.bets.truncated && <p role="status">Mostrate fino a {data.bets.rows.length} delle {data.bets.total} giocate, prima dei filtri modello e stato. I riepiloghi comprendono l’intero periodo.</p>}
    </>}
    <LegacyArea>{legacy}</LegacyArea>
  </div>;
}

export function WalletBudgetPage({ legacy }: { legacy?: React.ReactNode }) {
  const [model, setModel] = useState<WalletModelFilter>(() => {
    const requested = initialModel();
    return requested === 'all' && new URLSearchParams(window.location.search).get('model') !== 'all' ? 'A' : requested;
  });
  const [query, setQuery] = useState<ResearchComparisonQuery>({ period: 'all' });
  const { data, loading, error, refresh } = useAppWalletData(query);
  const portfolios = (data?.portfolios || []).filter((row) => model === 'all' || row.family === model);
  const selected = model === 'all' ? null : portfolios[0];
  return <main className="bm-wrap budget-page wallet-budget-page">
    <header className="bm-head">
      <div><span className="fp-section-kicker">I tuoi portafogli</span><h1 className="bm-title">Budget</h1>
        <p className="bm-sub">A e C hanno due budget separati. Ogni giocata utilizza solo il capitale del proprio modello.</p></div>
      <button type="button" className="fp-btn fp-btn-ghost wallet-budget-refresh" aria-label="Aggiorna budget" onClick={refresh} disabled={loading}><RefreshCw size={17} aria-hidden="true" /><span>Aggiorna budget</span></button>
    </header>
    <div className="wallet-budget-controls">
      <div className="wallet-model-tabs" role="group" aria-label="Modello del budget">
        {(['A', 'C', 'all'] as WalletModelFilter[]).map((value) => <button key={value} type="button" aria-label={value === 'all' ? 'Confronta A e C' : `Modello ${value}`} aria-pressed={model === value}
          className={model === value ? 'is-active' : ''} onClick={() => setModel(value)}>
          {value === 'all' ? <span className="wallet-compare-label"><span className="wallet-compare-full">Confronta A e C</span><span className="wallet-compare-short">Confronto</span></span> : <ModelBadge model={value} />}
        </button>)}
      </div>
      <WalletPeriodPicker query={query} onChange={setQuery} />
    </div>
    <WalletLoadState loading={loading} error={error} refresh={refresh} />
    {!loading && !error && data && <>
      {selected && <section className="wallet-budget-model" aria-label={`Portafoglio ${selected.family}`}>
        <div className="wallet-budget-context"><ModelBadge model={selected.family} /><p>{selected.family === 'A' ? 'Puntate con l’importo consigliato dal modello.' : 'Puntate con importo pari all’1% del proprio capitale.'} Tutti gli importi sono virtuali.</p></div>
        {selected.initialized === false ? <div className="fp-empty"><p>Portafoglio non disponibile. Nessun saldo viene ricreato da questa pagina.</p></div> : <>
          <dl className="bm-summary" aria-label={`Riepilogo modello ${selected.family}`}>
            <div className="bm-summary__item is-positive"><span className="bm-summary__icon"><WalletCards size={24} aria-hidden="true" /></span>
              <span><dt>Bankroll disponibile</dt><dd>{walletMoney(selected.currentAvailableCents)}</dd><small>Pronto per le prossime giocate</small></span></div>
            <div className="bm-summary__item"><span className="bm-summary__icon"><Lock size={24} aria-hidden="true" /></span>
              <span><dt>Capitale impegnato</dt><dd>{walletMoney(selected.currentCommittedCents)}</dd><small>Importi nelle giocate ancora aperte</small></span></div>
            <div className={`bm-summary__item ${(selected.profitCents ?? 0) < 0 ? 'is-negative' : 'is-positive'}`}><span className="bm-summary__icon"><TrendingUp size={24} aria-hidden="true" /></span>
              <span><dt>Risultato nel periodo</dt><dd>{walletMoney(selected.profitCents)}</dd><strong>{walletPercent(selected.roi)}</strong><small>Rendimento sulle giocate liquidate</small></span></div>
          </dl>
          <div className="budget-workspace">
            <section className="wallet-budget-chart" aria-label={`Andamento modello ${selected.family}`}>
              <EquityChart a={model === 'A' ? selected.equity : undefined} c={model === 'C' ? selected.equity : undefined}
                title={`Andamento del patrimonio · Modello ${selected.family}`} />
            </section>
            <aside className="budget-management wallet-budget-facts" aria-label={`Capitale modello ${selected.family}`}>
              <h2>Il capitale del modello {selected.family}</h2>
              <div className="budget-current"><span>Patrimonio attuale</span><strong>{walletMoney(selected.currentEquityCents)}</strong></div>
              <dl><div><dt>Capitale iniziale</dt><dd>{walletMoney(selected.initialCents)}</dd></div>
                <div><dt>Disponibile</dt><dd>{walletMoney(selected.currentAvailableCents)}</dd></div>
                <div><dt>Impegnato</dt><dd>{walletMoney(selected.currentCommittedCents)}</dd></div></dl>
              <p>Il patrimonio comprende disponibile e impegnato. L’importo impegnato non è una perdita.</p>
              <Link className="budget-open-bets-link" to={`/bets?model=${selected.family}`}>Giocate del modello {selected.family}<ArrowRight size={18} aria-hidden="true" /></Link>
            </aside>
          </div>
        </>}
      </section>}
      {model !== 'all' && !selected && <p className="fp-empty">Portafoglio non disponibile per il modello scelto.</p>}
      {model === 'all' && <section className="wallet-budget-comparison" aria-label="Confronto dei portafogli">
        <WalletBalanceCards portfolios={data.portfolios} model="all" />
        <section className="wallet-budget-chart"><EquityChart a={data.portfolios.find((row) => row.family === 'A')?.equity}
          c={data.portfolios.find((row) => row.family === 'C')?.equity} title="Patrimoni A e C nel tempo" /></section>
      </section>}
      <div className="wallet-budget-results">{portfolios.map((row) => <section className="wallet-budget-result" aria-label={`Risultati modello ${row.family}`} key={row.portfolioId}>
        <header><ModelBadge model={row.family} /><h2>Risultati del periodo</h2><p>{data.period.label}</p></header>
        <dl className="app-wallet-period-metrics">
          <div><dt>Giocate registrate</dt><dd>{row.betCount ?? '—'}</dd></div><div><dt>Importo registrato</dt><dd>{walletMoney(row.stakeCents)}</dd></div>
          <div><dt>Profitto liquidato</dt><dd>{walletMoney(row.profitCents)}</dd></div><div><dt>Rendimento sulle liquidate</dt><dd>{walletPercent(row.roi)}</dd></div>
          <div><dt>Giocate liquidate</dt><dd>{row.settledCount ?? '—'}</dd></div><div><dt>Importo liquidato</dt><dd>{walletMoney(row.settledStakeCents)}</dd></div>
          <div><dt>Vinte, incluse mezze vincite</dt><dd>{row.wonCount ?? '—'}</dd></div><div><dt>Perse, incluse mezze perdite</dt><dd>{row.lostCount ?? '—'}</dd></div>
        </dl>
      </section>)}</div>
      <p className="app-wallet-help">Le statistiche e il grafico riguardano il periodo selezionato; i saldi mostrano il capitale attuale. Profitto e rendimento comprendono le liquidazioni del periodo, anche per giocate registrate prima.</p>
    </>}
    <LegacyArea>{legacy}</LegacyArea>
  </main>;
}
