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
  MoreHorizontal,
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

type SyncState = 'idle' | 'loading' | 'success' | 'error' | 'warning';

const NAV_ITEMS = [
  { path: '/', label: 'Dashboard', meta: 'stato sistema', icon: LayoutDashboard },
  { path: '/predictions', label: 'Previsioni', meta: 'pick e quote', icon: Target },
  { path: '/budget', label: 'Budget', meta: 'bankroll e storico', icon: Wallet },
  { path: '/backtest', label: 'Backtest', meta: 'validazione', icon: FlaskConical },
  { path: '/data', label: 'Dati', meta: 'squadre e modelli', icon: Database },
  { path: '/scrapers', label: 'Dati & Provider', meta: 'pipeline dati e quote', icon: RadioTower },
];

const MOBILE_PRIMARY_NAV_PATHS = ['/', '/predictions', '/budget'];
const MOBILE_PRIMARY_NAV_ITEMS = NAV_ITEMS.filter((item) => MOBILE_PRIMARY_NAV_PATHS.includes(item.path));
const MOBILE_SECONDARY_NAV_ITEMS = NAV_ITEMS.filter((item) => !MOBILE_PRIMARY_NAV_PATHS.includes(item.path));
const ACTIVE_USER_STORAGE_KEY = 'footpredictor.activeUser';
const DEFAULT_ACTIVE_USER = String(process.env.REACT_APP_DEFAULT_USER ?? 'user1').trim() || 'user1';
const CONFIGURED_USERS = Array.from(new Set(
  String(process.env.REACT_APP_USER_OPTIONS ?? DEFAULT_ACTIVE_USER)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean)
));

const getInitialActiveUser = () => {
  if (typeof window !== 'undefined') {
    const stored = window.localStorage.getItem(ACTIVE_USER_STORAGE_KEY)?.trim();
    if (stored) return stored;
  }
  return CONFIGURED_USERS[0] ?? DEFAULT_ACTIVE_USER;
};

const StatusIcon: React.FC<{ state: SyncState }> = ({ state }) => {
  if (state === 'success') return <CheckCircle2 size={16} />;
  if (state === 'error') return <AlertTriangle size={16} />;
  if (state === 'warning') return <AlertTriangle size={16} />;
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

  const understat = latestByScheduler.get('understat');
  const learning = latestByScheduler.get('learning');
  const odds = latestByScheduler.get('odds');
  const coreRuns = [understat, learning].filter(Boolean);

  if (coreRuns.length === 0 && !odds) {
    return { state: 'loading', label: 'Sistema in attesa' };
  }
  if (coreRuns.some((run) => run?.success === false)) {
    return { state: 'error', label: 'Sistema con errori' };
  }
  if (coreRuns.length < 2) {
    return { state: 'warning', label: 'Sistema parziale' };
  }
  if (odds && odds?.success === false) {
    return { state: 'warning', label: 'Sistema parziale' };
  }
  if (coreRuns.every((run) => run?.success === true)) {
    return { state: 'success', label: 'Sistema OK' };
  }
  return { state: 'warning', label: 'Sistema parziale' };
};

interface AppShellProps {
  activeUser: string;
  availableUsers: string[];
  onChangeActiveUser: (nextUser: string) => void;
  syncStatus: { state: SyncState; message: string };
  systemHealth: { state: SyncState; label: string };
  statusRefreshing: boolean;
  onRefreshStatus: () => void;
}

export const AppShell: React.FC<AppShellProps> = ({
  activeUser,
  availableUsers,
  onChangeActiveUser,
  syncStatus,
  systemHealth,
  statusRefreshing,
  onRefreshStatus,
}) => {
  const location = useLocation();
  const isWorkbench = location.pathname === '/predictions';
  const mainContentClass = isWorkbench ? 'main-content main-content--workbench' : 'main-content main-content--scroll';
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const isMoreSectionActive = MOBILE_SECONDARY_NAV_ITEMS.some(({ path }) => location.pathname === path);

  useEffect(() => {
    setMobileMoreOpen(false);
  }, [location.pathname]);

  return (
    <div className="app-shell">
      <div className={`sync-banner sync-banner--${syncStatus.state}`}>
        <div className="sync-banner__row">
          <span className="sync-banner__label">Sync Notturna</span>
          <span className="sync-banner__message">{syncStatus.message}</span>
        </div>
      </div>

      <header className="app-header">
        <div className="app-brand">
          <div className="app-brand-mark" aria-hidden="true">
            <Activity size={24} />
          </div>
          <div className="app-brand-copy">
            <div className="app-brand-name" translate="no">FootPredictor</div>
            <div className="app-brand-tag">Decisioni rapide su pick, quote, bankroll e validazione</div>
          </div>
        </div>

        <div className="app-header-right">
          {availableUsers.length > 1 ? (
            <label className="app-user-picker">
              <span className="app-user-picker__label">Workspace</span>
              <select
                className="app-user-picker__select"
                value={activeUser}
                onChange={(event) => onChangeActiveUser(event.target.value)}
                aria-label="Workspace attivo"
              >
                {availableUsers.map((user) => (
                  <option key={user} value={user}>
                    {user}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <div className="app-user-chip">
              <span className="app-user-chip__label">Workspace</span>
              <strong className="app-user-chip__value" translate="no">{activeUser}</strong>
            </div>
          )}
          <button
            type="button"
            className="fp-btn fp-btn-ghost fp-btn-sm app-header-refresh"
            onClick={onRefreshStatus}
            disabled={statusRefreshing}
            title={statusRefreshing ? 'Aggiornamento stato sistema in corso' : 'Ricarica stato sync e salute del sistema'}
            aria-label={statusRefreshing ? 'Aggiornamento stato in corso' : 'Aggiorna stato sistema'}
          >
            <RefreshCw size={14} className={statusRefreshing ? 'fp-spin' : ''} />
            <span>{statusRefreshing ? 'Aggiorno…' : 'Aggiorna Sistema'}</span>
          </button>
          <div className={`app-status-chip is-${systemHealth.state}`}>
            <span className="app-status-dot" />
            <StatusIcon state={systemHealth.state} />
            <span>{systemHealth.label}</span>
          </div>
          <div className={`app-status-chip is-${syncStatus.state}`}>
            <span className="app-status-dot" />
            <StatusIcon state={syncStatus.state} />
            <span>
              {syncStatus.state === 'error'
                ? 'Sync errore'
                : syncStatus.state === 'success'
                  ? 'Sync OK'
                  : syncStatus.state === 'warning'
                    ? 'Sync parziale'
                    : 'Sync in corso'}
            </span>
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
        {MOBILE_PRIMARY_NAV_ITEMS.map(({ path, label, icon: Icon }) => (
          <NavLink key={path} to={path} end={path === '/'} className={({ isActive }) => `mobile-nav-item${isActive ? ' active' : ''}`}>
            <Icon size={18} />
            <span>{label}</span>
          </NavLink>
        ))}
        <button
          type="button"
          className={`mobile-nav-item mobile-nav-item--toggle${mobileMoreOpen || isMoreSectionActive ? ' active' : ''}`}
          onClick={() => setMobileMoreOpen((current) => !current)}
          aria-expanded={mobileMoreOpen}
          aria-controls="mobile-more-menu"
          aria-label="Apri altre sezioni"
        >
          <MoreHorizontal size={18} />
          <span>Altro</span>
        </button>
      </nav>
      {mobileMoreOpen && (
        <div className="mobile-more-sheet" id="mobile-more-menu">
          <div className="mobile-more-sheet__header">
            <span>Altre Sezioni</span>
            <button
              type="button"
              className="fp-btn fp-btn-ghost fp-btn-sm"
              onClick={() => setMobileMoreOpen(false)}
              aria-label="Chiudi menu altre sezioni"
            >
              Chiudi
            </button>
          </div>
          <div className="mobile-more-sheet__grid">
            {MOBILE_SECONDARY_NAV_ITEMS.map(({ path, label, meta, icon: Icon }) => (
              <NavLink
                key={path}
                to={path}
                end={path === '/'}
                className={({ isActive }) => `mobile-more-link${isActive ? ' active' : ''}`}
                onClick={() => setMobileMoreOpen(false)}
              >
                <span className="mobile-more-link__icon" aria-hidden="true">
                  <Icon size={18} />
                </span>
                <span className="mobile-more-link__copy">
                  <span className="mobile-more-link__label">{label}</span>
                  <span className="mobile-more-link__meta">{meta}</span>
                </span>
              </NavLink>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

const App: React.FC = () => {
  const [activeUser, setActiveUser] = useState(getInitialActiveUser);
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
  const availableUsers = Array.from(new Set([...CONFIGURED_USERS, activeUser].filter(Boolean)));

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(ACTIVE_USER_STORAGE_KEY, activeUser);
    }
  }, [activeUser]);

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
        availableUsers={availableUsers}
        onChangeActiveUser={setActiveUser}
        syncStatus={syncStatus}
        systemHealth={systemHealth}
        statusRefreshing={statusRefreshing}
        onRefreshStatus={() => { void refreshStatus(); }}
      />
    </Router>
  );
};

export default App;
export { NAV_ITEMS, MOBILE_PRIMARY_NAV_ITEMS, MOBILE_SECONDARY_NAV_ITEMS };
