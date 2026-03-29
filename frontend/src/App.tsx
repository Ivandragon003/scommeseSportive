import React, { useCallback, useEffect, useRef, useState } from 'react';
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
  RefreshCw,
  Target,
  Wallet,
} from 'lucide-react';
import Dashboard from './pages/Dashboard';
import Predictions from './pages/Predictions';
import BudgetManager from './pages/BudgetManager';
import Backtesting from './pages/Backtesting';
import DataManager from './pages/DataManager';
import Scrapers from './pages/Scrapers';
import { getScraperStatus } from './utils/api';
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

const formatSyncDateTime = (iso?: string | null) => {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString('it-IT', {
    weekday: 'short',
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
};

const getSystemHealthFromRuns = (runs: any[]): { state: SyncState; label: string } => {
  const latestByScheduler = new Map<string, any>();
  for (const run of Array.isArray(runs) ? runs : []) {
    const key = String(run?.schedulerName ?? '').trim();
    if (!key || latestByScheduler.has(key)) continue;
    latestByScheduler.set(key, run);
  }

  const requiredRuns = ['understat', 'odds', 'learning']
    .map((key) => latestByScheduler.get(key))
    .filter(Boolean);

  if (requiredRuns.length === 0) {
    return { state: 'loading', label: 'Sistema in attesa' };
  }
  if (requiredRuns.some((run) => run?.success === false)) {
    return { state: 'error', label: 'Sistema con errori' };
  }
  if (requiredRuns.length === 3 && requiredRuns.every((run) => run?.success === true)) {
    return { state: 'success', label: 'Sistema OK' };
  }
  return { state: 'loading', label: 'Sistema parziale' };
};

const AppShell: React.FC<{
  activeUser: string;
  syncStatus: { state: SyncState; message: string };
  systemHealth: { state: SyncState; label: string };
  statusRefreshing: boolean;
  onRefreshStatus: () => void;
}> = ({ activeUser, syncStatus, systemHealth, statusRefreshing, onRefreshStatus }) => {
  const location = useLocation();
  const isWorkbench = location.pathname === '/predictions';
  const mainContentClass = isWorkbench ? 'main-content main-content--workbench' : 'main-content main-content--scroll';

  return (
    <div className="app-shell">
      <div className={`sync-banner sync-banner--${syncStatus.state}`}>
        <div className="sync-banner__row">
          <span className="sync-banner__label">Sync Notturna</span>
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
          <button
            type="button"
            className="fp-btn fp-btn-ghost fp-btn-sm app-header-refresh"
            onClick={onRefreshStatus}
            disabled={statusRefreshing}
            title="Ricarica subito lo stato scheduler"
          >
            <RefreshCw size={14} className={statusRefreshing ? 'fp-spin' : ''} />
            <span>{statusRefreshing ? 'Aggiorno...' : 'Aggiorna stato'}</span>
          </button>
          <div className={`app-status-chip is-${systemHealth.state}`}>
            <span className="app-status-dot" />
            <StatusIcon state={systemHealth.state} />
            <span>{systemHealth.label}</span>
          </div>
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
            <Route path="/" element={<Dashboard activeUser={activeUser} onRefreshStatus={onRefreshStatus} />} />
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
    message: 'Verifica stato sincronizzazione notturna...',
  });
  const [systemHealth, setSystemHealth] = useState<{ state: SyncState; label: string }>({
    state: 'loading',
    label: 'Sistema in attesa',
  });
  const [statusRefreshing, setStatusRefreshing] = useState(false);
  const mountedRef = useRef(true);

  const applyStatus = useCallback((statusPayload: any) => {
      const scheduler = statusPayload?.data?.understatScheduler ?? null;
      const lastUpdate = statusPayload?.data?.lastUpdate ?? null;
      setSystemHealth(getSystemHealthFromRuns(statusPayload?.data?.recentSchedulerRuns ?? []));
      if (statusPayload?.data?.isUpdating || scheduler?.running) {
        const nextMessage = scheduler?.lastRunAt
          ? `Sincronizzazione notturna Understat in corso. Avviata ${formatSyncDateTime(scheduler.lastRunAt) ?? 'di recente'}.`
          : 'Sincronizzazione notturna Understat in corso...';
        setSyncStatus({ state: 'loading', message: nextMessage });
        return;
      }

      if (lastUpdate?.success) {
        const nextRun = formatSyncDateTime(scheduler?.nextRunAt);
        setSyncStatus({
          state: 'success',
          message: nextRun
            ? `${lastUpdate?.message || 'Dati aggiornati correttamente.'} Prossima sync: ${nextRun}.`
            : lastUpdate?.message || 'Dati aggiornati correttamente.',
        });
        window.dispatchEvent(new Event('data-sync-complete'));
        return;
      }

      if (lastUpdate?.success === false) {
        setSyncStatus({
          state: 'error',
          message: lastUpdate?.message || 'Ultima sincronizzazione non completata.',
        });
        window.dispatchEvent(new Event('data-sync-error'));
        return;
      }

      const nextRun = formatSyncDateTime(scheduler?.nextRunAt);
      if (scheduler?.enabled && nextRun) {
        setSyncStatus({
          state: 'success',
          message: `Sync notturna programmata alle ${scheduler?.time ?? '01:00'}. Prossimo avvio: ${nextRun}.`,
        });
        return;
      }

      setSyncStatus({
        state: 'success',
        message: 'Sincronizzazione automatica non pianificata. Usa la pagina Scrapers per un refresh manuale.',
      });
  }, []);

  const refreshStatus = useCallback(async (options?: { silent?: boolean }) => {
      const isSilent = options?.silent === true;
      if (!isSilent && mountedRef.current) {
        setStatusRefreshing(true);
      }
      try {
        const statusPayload = await getScraperStatus();
        if (!mountedRef.current) return;
        applyStatus(statusPayload);
      } catch (error: any) {
        if (!mountedRef.current) return;
        setSyncStatus({
          state: 'error',
          message: error?.response?.data?.error || error?.message || 'Impossibile leggere lo stato del sync automatico.',
        });
        setSystemHealth({ state: 'error', label: 'Sistema non raggiungibile' });
        window.dispatchEvent(new Event('data-sync-error'));
      } finally {
        if (!isSilent && mountedRef.current) {
          setStatusRefreshing(false);
        }
      }
  }, [applyStatus]);

  useEffect(() => {
    mountedRef.current = true;
    const safeRefresh = async (options?: { silent?: boolean }) => {
      await refreshStatus(options);
    };

    void safeRefresh({ silent: true });
    const interval = setInterval(() => { void safeRefresh({ silent: true }); }, 60000);
    const onManualRefresh = () => { void safeRefresh(); };
    window.addEventListener('scraper-status-refresh', onManualRefresh);
    return () => {
      mountedRef.current = false;
      clearInterval(interval);
      window.removeEventListener('scraper-status-refresh', onManualRefresh);
    };
  }, [refreshStatus]);

  return (
    <Router>
      <AppShell
        activeUser={activeUser}
        syncStatus={syncStatus}
        systemHealth={systemHealth}
        statusRefreshing={statusRefreshing}
        onRefreshStatus={() => { void refreshStatus(); }}
      />
    </Router>
  );
};

export default App;
