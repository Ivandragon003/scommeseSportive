import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BrowserRouter as Router, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import {
  Activity,
  Database,
  FlaskConical,
  MoreHorizontal,
  RadioTower,
  RefreshCw,
  Target,
  Wallet,
} from 'lucide-react';
import Predictions from './pages/Predictions';
import BudgetManager from './pages/BudgetManager';
import Backtesting from './pages/Backtesting';
import DataManager from './pages/DataManager';
import Scrapers from './pages/Scrapers';
import { getScraperStatus } from './utils/api';
import ToastStack from './components/common/ToastStack';
import { useToastState } from './hooks/useToastState';
import './footpredictor.css';

const NAV_ITEMS = [
  { path: '/predictions', label: 'Previsioni', meta: 'pick e quote', icon: Target },
  { path: '/budget', label: 'Budget', meta: 'bankroll e storico', icon: Wallet },
  { path: '/backtest', label: 'Backtest', meta: 'validazione', icon: FlaskConical },
  { path: '/data', label: 'Dati', meta: 'squadre e modelli', icon: Database },
  { path: '/scrapers', label: 'Dati & Provider', meta: 'pipeline dati e quote', icon: RadioTower },
];

const MOBILE_PRIMARY_NAV_PATHS = ['/predictions', '/budget'];
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

interface AppShellProps {
  activeUser: string;
  statusRefreshing: boolean;
  onRefreshStatus: () => void;
}

export const AppShell: React.FC<AppShellProps> = ({
  activeUser,
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
          <button
            type="button"
            className="fp-btn fp-btn-ghost fp-btn-sm app-header-refresh"
            onClick={onRefreshStatus}
            disabled={statusRefreshing}
            title={statusRefreshing ? 'Aggiornamento sistema in corso' : 'Aggiorna sistema'}
            aria-label={statusRefreshing ? 'Aggiornamento sistema in corso' : 'Aggiorna sistema'}
          >
            <RefreshCw size={14} className={statusRefreshing ? 'fp-spin' : ''} />
            <span>{statusRefreshing ? 'Aggiorno...' : 'Aggiorna Sistema'}</span>
          </button>
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
            <Route path="/" element={<Navigate to="/predictions" replace />} />
            <Route path="/dashboard" element={<Navigate to="/predictions" replace />} />
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
  const [activeUser] = useState(getInitialActiveUser);
  const [statusRefreshing, setStatusRefreshing] = useState(false);
  const { toasts, showToast, dismissToast } = useToastState();
  const mountedRef = useRef(true);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem(ACTIVE_USER_STORAGE_KEY, activeUser);
    }
  }, [activeUser]);

  const applyStatus = useCallback((statusPayload: any) => {
    const scheduler = statusPayload?.data?.understatScheduler ?? null;
    const lastUpdate = statusPayload?.data?.lastUpdate ?? null;
    if (statusPayload?.data?.isUpdating || scheduler?.running) {
      return;
    }

    if (lastUpdate?.success) {
      window.dispatchEvent(new Event('data-sync-complete'));
      return;
    }

    if (lastUpdate?.success === false) {
      window.dispatchEvent(new Event('data-sync-error'));
    }
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
      if (!isSilent) {
        showToast({ tone: 'success', message: 'Sistema aggiornato' });
      }
    } catch (error: any) {
      if (!mountedRef.current) return;
      if (!isSilent) {
        showToast({
          tone: 'error',
          message: error?.response?.data?.error || error?.message || 'Errore aggiornamento',
        });
      }
      window.dispatchEvent(new Event('data-sync-error'));
    } finally {
      if (!isSilent && mountedRef.current) {
        setStatusRefreshing(false);
      }
    }
  }, [applyStatus, showToast]);

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
    <>
      <Router>
        <AppShell
          activeUser={activeUser}
          statusRefreshing={statusRefreshing}
          onRefreshStatus={() => { void refreshStatus(); }}
        />
      </Router>
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </>
  );
};

export default App;
export { NAV_ITEMS, MOBILE_PRIMARY_NAV_ITEMS, MOBILE_SECONDARY_NAV_ITEMS };
