import React, { useState } from 'react';
import { ResearchComparisonQuery } from '../research/researchComparisonTypes';
import {
  useAppWalletData, walletBetFamily, WalletBetTable, WalletLoadState, WalletModelFilter, WalletModelPicker,
} from './AppWallets';
import { WalletPeriodPicker } from './WalletPages';
import WalletBetEvidence from './WalletBetEvidence';

const initialModel = (): WalletModelFilter => {
  const model = new URLSearchParams(window.location.search).get('model');
  return model === 'A' || model === 'C' ? model : 'all';
};

function CurrentWalletArchive({ onOpenLegacy }: { onOpenLegacy?: () => void }) {
  const [model, setModel] = useState<WalletModelFilter>(initialModel);
  const [query, setQuery] = useState<ResearchComparisonQuery>({ period: 'all' });
  const [status, setStatus] = useState('all');
  const [selectedBetId, setSelectedBetId] = useState<string | null>(null);
  const { data, loading, error, refresh } = useAppWalletData(query);
  const rows = (data?.bets.rows || []).filter((bet) => (model === 'all' || walletBetFamily(bet) === model)
    && (status === 'all' || (status === 'open' ? bet.status === 'PENDING' : bet.status !== 'PENDING')));
  const selectedBet = rows.find((bet) => bet.id === selectedBetId) ?? null;
  const portfolios = (data?.portfolios || []).filter((portfolio) => model === 'all' || portfolio.family === model);

  return <div className="app-wallet-page pa-page">
    <header className="app-wallet-head"><div><h1>Archivio</h1>
      <p>Giocate dei portafogli A e C, con pronostico, quota e importo conservati al momento della registrazione.</p></div>
      <button type="button" className="fp-btn fp-btn-ghost" disabled={loading} onClick={refresh}>Aggiorna archivio</button>
    </header>
    <div className="app-wallet-toolbar">
      <WalletModelPicker value={model} onChange={(value) => { setModel(value); setSelectedBetId(null); }} />
      <label className="app-wallet-filter">Esito<select aria-label="Esito" value={status}
        onChange={(event) => { setStatus(event.target.value); setSelectedBetId(null); }}>
        <option value="all">Tutte le giocate</option><option value="open">Aperte</option><option value="settled">Liquidate</option>
      </select></label>
    </div>
    <WalletPeriodPicker query={query} onChange={(value) => { setQuery(value); setSelectedBetId(null); }} />
    <WalletLoadState loading={loading} error={error} refresh={refresh} />
    {!loading && !error && data && <>
      <p className="app-wallet-help">{data.period.label} · Europe/Rome.
        {' '}{portfolios.map((portfolio) => `Modello ${portfolio.family}: ${portfolio.betCount ?? '—'} giocate registrate`).join(' · ')}.
      </p>
      <WalletBetTable rows={rows} model={model} emptyText="Nessuna giocata registrata nei filtri scelti." onInspectBet={(bet) => setSelectedBetId(bet.id)} />
      {data.bets.truncated && <p role="status">Mostrate fino a {data.bets.rows.length} delle {data.bets.total} giocate del periodo, prima dei filtri modello ed esito. I conteggi comprendono tutte le registrazioni.</p>}
      {selectedBet && <WalletBetEvidence key={selectedBet.id} bet={selectedBet} onClose={() => setSelectedBetId(null)} />}
    </>}
    {onOpenLegacy && <section className="app-wallet-legacy">
      <button type="button" className="fp-btn fp-btn-ghost" onClick={onOpenLegacy}>Storico precedente</button>
      <p>Consulta le registrazioni precedenti. I loro importi restano distinti dai portafogli A e C.</p>
    </section>}
  </div>;
}

export default function WalletArchivePage({ legacy }: { legacy?: React.ReactNode }) {
  const [showLegacy, setShowLegacy] = useState(false);
  if (showLegacy && legacy) return <>
    <div className="app-wallet-toolbar"><button type="button" className="fp-btn fp-btn-ghost" onClick={() => setShowLegacy(false)}>Torna all’archivio A/C</button>
      <p>Storico precedente: nessun importo è sommato ai portafogli A e C.</p></div>
    {legacy}
  </>;
  return <CurrentWalletArchive onOpenLegacy={legacy ? () => setShowLegacy(true) : undefined} />;
}
