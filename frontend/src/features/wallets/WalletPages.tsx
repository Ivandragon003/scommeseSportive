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
import QualityFilters from './QualityFilters';
import { AppSelect } from '../../components/common/AppSelect';

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
    <label className="app-wallet-filter">Periodo<AppSelect aria-label="Periodo" value={custom ? 'custom' : todaySelected ? 'today' : query.period}
      onChange={value => {
        setCustom(value === 'custom');
        if (value === 'today') { onChange({period:'custom',from:today,to:today}); return; }
        if (value !== 'custom') onChange({period:value as ResearchComparisonQuery['period']});
      }} options={[{value:'all',label:'Dall’apertura dei portafogli'},{value:'today',label:'Oggi'},{value:'7d',label:'Ultimi 7 giorni'},{value:'30d',label:'Ultimi 30 giorni'},{value:'90d',label:'Ultimi 90 giorni'},{value:'custom',label:'Periodo personalizzato'}]} /></label>
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

export function FundedWalletBudgetPage({ activeUser }: { activeUser: string }) {
  const [model, setModel] = useState<WalletModelFilter>(() => {
    if (new URLSearchParams(window.location.search).get('model') === 'baseline') return 'A';
    const requested = initialModel();
    return requested === 'all' && new URLSearchParams(window.location.search).get('model') !== 'all' ? 'A' : requested;
  });
  const [query, setQuery] = useState<ResearchComparisonQuery>({ period: 'all' });
  void activeUser; // The authenticated shared ledger is resolved by the backend.
  const [qualities, setQualities] = useState<string[]>([]);
  const { data, loading, error, refresh } = useAppWalletData({ ...query, includeHistory: true, qualities });
  const portfolios = (data?.portfolios || []).filter((row) => model === 'all' || row.family === model);
  const selected = model === 'all' ? null : portfolios[0];
  return <main className="bm-wrap budget-page wallet-budget-page">
    <header className="bm-head">
      <div><span className="fp-section-kicker">I tuoi portafogli</span><h1 className="bm-title">Budget</h1>
        <p className="bm-sub">A deterministico · C machine learning · saldi in euro</p></div>
      <button type="button" className="fp-btn fp-btn-ghost wallet-budget-refresh" aria-label="Aggiorna budget" onClick={refresh} disabled={loading}><RefreshCw size={17} aria-hidden="true" /><span>Aggiorna budget</span></button>
    </header>
    <div className="wallet-budget-controls">
      <div className="wallet-model-tabs" role="group" aria-label="Modello del budget">
        {(['A', 'C', 'all'] as const).map((value) => <button key={value} type="button" aria-label={value === 'all' ? 'Confronta A e C' : `Modello ${value}`} aria-pressed={model === value}
          className={model === value ? 'is-active' : ''} onClick={() => setModel(value)}>
          {value === 'all' ? <span className="wallet-compare-label"><span className="wallet-compare-full">Confronta A e C</span><span className="wallet-compare-short">Confronto</span></span> : <ModelBadge model={value} />}
        </button>)}
      </div>
      <WalletPeriodPicker query={query} onChange={setQuery} />
      <QualityFilters value={qualities} onChange={setQualities} />
    </div>
    <WalletLoadState loading={loading && !data} error={error} refresh={refresh} />
    {!error && data && <>
      {selected && <section className="wallet-budget-model" aria-label={`Portafoglio ${selected.family}`}>
        <div className="wallet-budget-context"><ModelBadge model={selected.family} /><p>{selected.family === 'A' ? 'Budget deterministico' : 'Budget machine learning'}</p></div>
        {selected.initialized === false ? <div className="fp-empty"><p>Portafoglio non disponibile. Nessun saldo viene ricreato da questa pagina.</p></div> : <>
          <div role="group" className="bm-summary" aria-label={`Riepilogo modello ${selected.family}`}>
            <div className="bm-summary__item is-positive"><span className="bm-summary__icon"><WalletCards size={24} aria-hidden="true" /></span>
              <div className="bm-summary__copy"><dl className="bm-summary__values"><dt>Bankroll disponibile</dt><dd>{walletMoney(selected.currentAvailableCents)}</dd></dl><small>Pronto per le prossime giocate</small></div></div>
            <div className="bm-summary__item"><span className="bm-summary__icon"><Lock size={24} aria-hidden="true" /></span>
              <div className="bm-summary__copy"><dl className="bm-summary__values"><dt>Capitale impegnato</dt><dd>{walletMoney(selected.currentCommittedCents)}</dd></dl><small>Importi nelle giocate ancora aperte</small></div></div>
            <div className={`bm-summary__item ${(selected.profitCents ?? 0) < 0 ? 'is-negative' : 'is-positive'}`}><span className="bm-summary__icon"><TrendingUp size={24} aria-hidden="true" /></span>
              <div className="bm-summary__copy"><dl className="bm-summary__values"><dt>Risultato nel periodo</dt><dd>{walletMoney(selected.profitCents)}</dd></dl><strong>{walletPercent(selected.roi)}</strong><small>Rendimento sulle giocate liquidate</small></div></div>
          </div>
          <div className="budget-workspace">
            <section className="wallet-budget-chart" aria-label={`Andamento modello ${selected.family}`}>
              <EquityChart a={selected.family === 'A' ? data.filteredProfitCurves?.A : undefined} c={selected.family === 'C' ? data.filteredProfitCurves?.C : undefined} showData={false} kind="profit" title="Profitto cumulato nel periodo" />
            </section>
            <aside className="budget-management wallet-budget-facts" aria-label={`Capitale modello ${selected.family}`}>
              <h2>Il capitale del modello {selected.family}</h2>
              <div className="budget-current"><span>Patrimonio operativo attuale</span><strong>{walletMoney(selected.currentEquityCents)}</strong></div>
              {selected.family === 'A' && data.historicalAvailableCents != null && <p className="wallet-historical-balance">Saldo dello storico A: <strong>{walletMoney(data.historicalAvailableCents)}</strong>. Gli esiti storici sono inclusi nei risultati A; il capitale operativo per nuove giocate è quello disponibile qui sotto.</p>}
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
        <section className="wallet-budget-chart"><EquityChart a={data.filteredProfitCurves?.A}
          c={data.filteredProfitCurves?.C} showData={false} kind="profit" title="Profitti cumulati A e C nel periodo" /></section>
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
      <p className="app-wallet-help">Ogni giocata automatica usa la percentuale suggerita dal proprio modello sul patrimonio a inizio ciclo Nightly. Il patrimonio comprende disponibile e impegnato; l’importo deve rientrare nel saldo ancora disponibile.</p>
      <p className="app-wallet-help">{qualities.length > 0 && 'Classificazione applicata ai risultati e al profitto cumulato. I saldi disponibili e impegnati restano quelli effettivi. '}I risultati A comprendono anche lo storico deterministico. Il grafico mostra sempre il profitto cumulato, da zero all’inizio del periodo. I saldi mostrano il capitale attuale. Profitto e rendimento comprendono le liquidazioni del periodo, anche per giocate registrate prima.</p>
    </>}
  </main>;
}

export function WalletBudgetPage({ activeUser }: { activeUser: string }) {
  return <FundedWalletBudgetPage activeUser={activeUser} />;
}
