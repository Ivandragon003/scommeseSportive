import React, { useEffect, useState } from 'react';
import { BrowserRouter as Router, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  Database,
  FlaskConical,
  LayoutDashboard,
  Loader2,
  RadioTower,
  Target,
  Wallet,
} from 'lucide-react';
import Dashboard from './pages/Dashboard';
import Predictions from './pages/Predictions';
import BudgetManager from './pages/BudgetManager';
import Backtesting from './pages/Backtesting';
import DataManager from './pages/DataManager';
import Scrapers from './pages/Scrapers';
import { autoRefreshDataOnEnter, getScraperStatus } from './utils/api';
import './footpredictor.css';

type SyncState = 'idle' | 'loading' | 'success' | 'error';

const NAV_ITEMS = [
  { path: '/', label: 'Dashboard', meta: 'stato sistema', icon: LayoutDashboard },
  { path: '/predictions', label: 'Previsioni', meta: 'pick e quote', icon: Target },
  { path: '/budget', label: 'Budget', meta: 'bankroll e storico', icon: Wallet },
  { path: '/backtest', label: 'Backtest', meta: 'validazione', icon: FlaskConical },
  { path: '/data', label: 'Dati', meta: 'squadre e modelli', icon: Database },
  { path: '/scrapers', label: 'Scrapers', meta: 'sync automatiche', icon: RadioTower },
];

const StatusIcon: React.FC<{ state: SyncState }> = ({ state }) => {
  if (state === 'success') return <CheckCircle2 size={16} />;
  if (state === 'error') return <AlertTriangle size={16} />;
  return <Loader2 size={16} className="fp-spin" />;
};

const AppShell: React.FC<{
  activeUser: string;
  syncStatus: { state: SyncState; message: string };
}> = ({ activeUser, syncStatus }) => {
  const location = useLocation();
  const isWorkbench = location.pathname === '/predictions';
  const mainContentClass = isWorkbench ? 'main-content main-content--workbench' : 'main-content main-content--scroll';

  return (
    <div className="app-shell">
      <div className={`sync-banner sync-banner--${syncStatus.state}`}>
        <div className="sync-banner__row">
          <span className="sync-banner__label">Auto Sync</span>
          <span className="sync-banner__message">{syncStatus.message}</span>
        </div>
        <div className="sync-banner__row">
          <span className="sync-banner__label">Utente</span>
          <span className="sync-banner__message">{activeUser}</span>
        </div>
      </div>

      <header className="app-header">
        <div className="app-brand">
          <div className="app-brand-mark" aria-hidden="true">
            <Activity size={24} />
          </div>
          <div className="app-brand-copy">
            <div className="app-brand-name">FootPredictor</div>
            <div className="app-brand-tag">Workspace operativo per quote, statistiche, bankroll e validazione</div>
          </div>
        </div>

        <div className="app-header-right">
          <div className={`app-status-chip is-${syncStatus.state}`}>
            <span className="app-status-dot" />
            <StatusIcon state={syncStatus.state} />
            <span>{syncStatus.state === 'error' ? 'Sync bloccata' : syncStatus.state === 'success' ? 'Sync pronta' : 'Sync in corso'}</span>
          </div>
        </div>
      </header>

      <div className="app-layout">
        <aside className="sidebar" aria-label="Navigazione principale">
          <div className="sidebar-section-title">Workspace</div>
          <nav className="sidebar-nav">
            {NAV_ITEMS.map(({ path, label, meta, icon: Icon }) => (
              <NavLink key={path} to={path} end={path === '/'} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}>
                <span className="nav-icon-wrap" aria-hidden="true">
                  <Icon size={18} />
                </span>
                <span className="nav-copy">
                  <span className="nav-label">{label}</span>
                  <span className="nav-meta">{meta}</span>
                </span>
              </NavLink>
            ))}
          </nav>
        </aside>

        <main className={mainContentClass}>
          <Routes>
            <Route path="/" element={<Dashboard activeUser={activeUser} />} />
            <Route path="/predictions" element={<Predictions activeUser={activeUser} />} />
            <Route path="/budget" element={<BudgetManager activeUser={activeUser} />} />
            <Route path="/backtest" element={<Backtesting />} />
            <Route path="/data" element={<DataManager />} />
            <Route path="/scrapers" element={<Scrapers />} />
          </Routes>
        </main>
      </div>

      <nav className="mobile-nav" aria-label="Navigazione rapida">
        {NAV_ITEMS.map(({ path, label, icon: Icon }) => (
          <NavLink key={path} to={path} end={path === '/'} className={({ isActive }) => `mobile-nav-item${isActive ? ' active' : ''}`}>
            <Icon size={18} />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </div>
  );
};

const App: React.FC = () => {
  const activeUser = 'user1';
  const [syncStatus, setSyncStatus] = useState<{ state: SyncState; message: string }>({
    state: 'loading',
    message: 'Aggiornamento dati Understat in corso...',
  });

  useEffect(() => {
    let active = true;
    let pollTimer: ReturnType<typeof setTimeout> | null = null;

    const clearPollTimer = () => {
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    };

    const finalizeFromStatus = (statusPayload: any) => {
      const lastUpdate = statusPayload?.data?.lastUpdate ?? null;
      if (lastUpdate?.success) {
        setSyncStatus({
          state: 'success',
          message: lastUpdate?.message || 'Dati aggiornati correttamente.',
        });
        window.dispatchEvent(new Event('data-sync-complete'));
        return;
      }

      setSyncStatus({
        state: 'error',
        message: lastUpdate?.message || 'Aggiornamento non completato.',
      });
      window.dispatchEvent(new Event('data-sync-error'));
    };

    const pollBackendSync = async () => {
      try {
        const statusPayload = await getScraperStatus();
        if (!active) return;
        if (statusPayload?.data?.isUpdating) {
          setSyncStatus({
            state: 'loading',
            message: 'Aggiornamento backend gia in corso. Attendo completamento...',
          });
          pollTimer = setTimeout(() => { void pollBackendSync(); }, 5000);
          return;
        }

        finalizeFromStatus(statusPayload);
      } catch (error: any) {
        if (!active) return;
        setSyncStatus({
          state: 'error',
          message: error?.response?.data?.error || error?.message || 'Impossibile leggere lo stato del sync automatico.',
        });
        window.dispatchEvent(new Event('data-sync-error'));
      }
    };

    const runAutoRefresh = async () => {
      setSyncStatus({ state: 'loading', message: 'Verifica stato aggiornamento automatico...' });
      try {
        const statusPayload = await getScraperStatus().catch(() => null);
        if (!active) return;

        const lastUpdateAt = statusPayload?.data?.lastUpdate?.at
          ? new Date(statusPayload.data.lastUpdate.at).getTime()
          : null;
        const updatedRecently = Boolean(
          statusPayload?.data?.lastUpdate?.success &&
          lastUpdateAt &&
          Number.isFinite(lastUpdateAt) &&
          Date.now() - lastUpdateAt < 10 * 60 * 1000
        );

        if (statusPayload?.data?.isUpdating) {
          setSyncStatus({
            state: 'loading',
            message: 'Aggiornamento backend gia in corso. Attendo completamento...',
          });
          void pollBackendSync();
          return;
        }

        if (updatedRecently) {
          setSyncStatus({
            state: 'success',
            message: statusPayload?.data?.lastUpdate?.message || 'Dati gia aggiornati di recente.',
          });
          window.dispatchEvent(new Event('data-sync-complete'));
          return;
        }

        setSyncStatus({ state: 'loading', message: 'Aggiornamento dati Understat in corso...' });
        const response = await autoRefreshDataOnEnter({
          mode: 'top5',
          yearsBack: 1,
          importPlayers: true,
          includeMatchDetails: true,
          forceRefresh: false,
        });

        if (!active) return;

        if (response?.success) {
          if (response?.data?.alreadyRunning || response?.data?.inProgress) {
            setSyncStatus({
              state: 'loading',
              message: response?.data?.message || 'Aggiornamento gia in corso su un altro processo...',
            });
            return;
          }

          setSyncStatus({
            state: 'success',
            message: response?.data?.message || 'Dati aggiornati correttamente.',
          });
          window.dispatchEvent(new Event('data-sync-complete'));
          return;
        }

        setSyncStatus({
          state: 'error',
          message: response?.error || 'Aggiornamento non completato.',
        });
        window.dispatchEvent(new Event('data-sync-error'));
      } catch (error: any) {
        if (!active) return;
        const message = error?.response?.data?.error || error?.message || 'Errore durante aggiornamento automatico.';
        const normalizedMessage = String(message)
          .toLowerCase()
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '');
        if (normalizedMessage.includes('gia in corso')) {
          setSyncStatus({
            state: 'loading',
            message: 'Aggiornamento gia in corso su un altro processo...',
          });
          return;
        }
        setSyncStatus({
          state: 'error',
          message,
        });
        window.dispatchEvent(new Event('data-sync-error'));
      }
    };

    void runAutoRefresh();
    return () => {
      active = false;
      clearPollTimer();
    };
  }, []);

  return (
    <Router>
      <AppShell activeUser={activeUser} syncStatus={syncStatus} />
    </Router>
  );
};

export default App;
