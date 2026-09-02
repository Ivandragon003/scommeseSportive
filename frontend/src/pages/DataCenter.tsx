import React from 'react';
import { NavLink } from 'react-router-dom';
import { RefreshCw } from 'lucide-react';
import DataManagerPageView from '../components/data-manager/DataManagerPageView';
import ScrapersPageView from '../components/scrapers/ScrapersPageView';
import CompetitionTransitions from './CompetitionTransitions';
import './data-center.css';

type DataTab = 'data' | 'providers' | 'integrity';
const tabs: Array<{ key: DataTab; path: string; label: string; detail: string }> = [
  { key: 'data', path: '/data', label: 'Dati operativi', detail: 'partite, squadre e modelli' },
  { key: 'providers', path: '/scrapers', label: 'Provider e quote', detail: 'fonti, import e qualità' },
  { key: 'integrity', path: '/transitions', label: 'Integrità campionati', detail: 'stagioni e transizioni' },
];

const DataCenter: React.FC<{ initialTab: DataTab; statusRefreshing: boolean; onRefreshStatus: () => void }> = ({ initialTab, statusRefreshing, onRefreshStatus }) => <section className="data-center">
  <header className="data-center__head"><div><p>Centro operativo</p><h1>Centro dati</h1><span>Gestisci fonti, copertura e integrità senza saltare fra sezioni ripetute.</span></div><button type="button" className="fp-btn fp-btn-ghost data-center__refresh" onClick={onRefreshStatus} disabled={statusRefreshing}><RefreshCw size={16} className={statusRefreshing ? 'fp-spin' : ''} />{statusRefreshing ? 'Aggiornamento…' : 'Aggiorna dati e calendario'}</button></header>
  <nav className="data-center__tabs" aria-label="Sezioni Centro dati">{tabs.map((tab) => <NavLink key={tab.key} to={tab.path} className={tab.key === initialTab ? 'active' : ''}><strong>{tab.label}</strong><small>{tab.detail}</small></NavLink>)}</nav>
  <div className="data-center__content">{initialTab === 'data' && <DataManagerPageView />}{initialTab === 'providers' && <ScrapersPageView />}{initialTab === 'integrity' && <CompetitionTransitions />}</div>
</section>;

export default DataCenter;
