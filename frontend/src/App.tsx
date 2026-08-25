import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { BrowserRouter as Router, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import {
  Activity,
  Archive,
  ArrowUpDown,
  BarChart3,
  Database,
  FlaskConical,
  HelpCircle,
  LogOut,
  Menu,
  RadioTower,
  RefreshCw,
  SlidersHorizontal,
  Ticket,
  Wallet,
} from 'lucide-react';
import Predictions from './pages/Predictions';
import { GlossaryProvider } from './features/glossary/GlossaryProvider';
import {
  AdminSession,
  getAdminSession,
  getScraperStatus,
  loginSharedAdmin,
  logoutSharedAdmin,
  syncUpcomingKickoffs,
  syncUpcomingPlayerAvailability,
} from './utils/api';
import ToastStack from './components/common/ToastStack';
import { useToastState } from './hooks/useToastState';
import { currentSeason } from './components/predictions/predictionWorkbenchUtils';
import SharedAdminLogin from './features/auth/SharedAdminLogin';
import './footpredictor.css';

// Keep the primary prediction workbench eager; less-frequent route modules are
// loaded only when visited, reducing the initial JavaScript payload.
const BudgetManager = lazy(() => import('./pages/BudgetManager'));
const BetsManager = lazy(() => import('./pages/BetsManager'));
const Backtesting = lazy(() => import('./pages/Backtesting'));
const DataManager = lazy(() => import('./pages/DataManager'));
const Scrapers = lazy(() => import('./pages/Scrapers'));
const CompetitionTransitions = lazy(() => import('./pages/CompetitionTransitions'));
const GlossaryPage = lazy(() => import('./features/glossary/GlossaryPage'));
const PredictionArchivePage = lazy(() => import('./features/prediction-archive/PredictionArchivePage'));

const PRIMARY_NAV_ITEMS = [
  { path: '/predictions', label: 'Partite', meta: 'pronostico e quote', icon: BarChart3 },
  { path: '/bets', label: 'Giocate', meta: 'aperte e storico', icon: Ticket },
  { path: '/budget', label: 'Budget', meta: 'gestione bankroll', icon: Wallet },
];

const ADVANCED_NAV_ITEMS = [
  { path: '/prediction-archive', label: 'Archivio giocate', meta: 'operative e simulate', icon: Archive },
  { path: '/glossary', label: 'Glossario', meta: 'termini e interpretazione', icon: HelpCircle },
  { path: '/backtest', label: 'Backtest', meta: 'validazione', icon: FlaskConical },
  { path: '/data', label: 'Dati', meta: 'squadre e modelli', icon: Database },
  { path: '/scrapers', label: 'Dati & Provider', meta: 'pipeline dati e quote', icon: RadioTower },
  { path: '/transitions', label: 'Transizioni', meta: 'promozioni e retrocessioni', icon: ArrowUpDown },
];

const NAV_ITEMS = [...PRIMARY_NAV_ITEMS, ...ADVANCED_NAV_ITEMS];
const MOBILE_PRIMARY_NAV_PATHS = ['/predictions', '/bets', '/budget'];
const MOBILE_PRIMARY_NAV_ITEMS = NAV_ITEMS.filter((item) => MOBILE_PRIMARY_NAV_PATHS.includes(item.path));
const MOBILE_SECONDARY_NAV_ITEMS = NAV_ITEMS.filter((item) => !MOBILE_PRIMARY_NAV_PATHS.includes(item.path));
interface AppShellProps {
  activeUser: string;
  statusRefreshing: boolean;
  onRefreshStatus: () => void;
  onLogout: () => void;
}

export const AppShell: React.FC<AppShellProps> = ({
  activeUser,
  statusRefreshing,
  onRefreshStatus,
  onLogout,
}) => {
  const location = useLocation();
  const isWorkbench = location.pathname === '/predictions';
  const mainContentClass = isWorkbench ? 'main-content main-content--workbench' : 'main-content main-content--scroll';
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const [desktopToolsOpen, setDesktopToolsOpen] = useState(false);
  const desktopToolsTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileMoreTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileMoreSheetRef = useRef<HTMLDivElement>(null);
  const mobileMoreCloseRef = useRef<HTMLButtonElement>(null);
  const isMoreSectionActive = MOBILE_SECONDARY_NAV_ITEMS.some(({ path }) => location.pathname === path);

  useEffect(() => {
    setMobileMoreOpen(false);
    setDesktopToolsOpen(false);
  }, [location.pathname]);

  useEffect(() => {
    if (!desktopToolsOpen) return undefined;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setDesktopToolsOpen(false);
        desktopToolsTriggerRef.current?.focus();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [desktopToolsOpen]);

  const closeMobileMore = useCallback((restoreFocus = true) => {
    setMobileMoreOpen(false);
    if (restoreFocus) {
      mobileMoreTriggerRef.current?.focus();
    }
  }, []);

  useEffect(() => {
    if (!mobileMoreOpen) return undefined;

    mobileMoreCloseRef.current?.focus();
    const sheet = mobileMoreSheetRef.current;

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeMobileMore();
        return;
      }

      if (event.key !== 'Tab' || !sheet) return;

      const focusable = Array.from(
        sheet.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')
      );
      if (focusable.length === 0) return;

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [closeMobileMore, mobileMoreOpen]);

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

        <nav className="desktop-nav" aria-label="Navigazione principale">
          {PRIMARY_NAV_ITEMS.map(({ path, label }) => (
            <NavLink key={path} to={path} className={({ isActive }) => `desktop-nav__link${isActive ? ' active' : ''}`}>
              {label}
            </NavLink>
          ))}
          <div className="desktop-tools">
            <button
              ref={desktopToolsTriggerRef}
              type="button"
              className={`desktop-nav__link desktop-nav__button${desktopToolsOpen || isMoreSectionActive ? ' active' : ''}`}
              onClick={() => setDesktopToolsOpen((value) => !value)}
              aria-expanded={desktopToolsOpen}
              aria-haspopup="menu"
              aria-label={desktopToolsOpen ? 'Chiudi strumenti' : 'Apri strumenti'}
            >
              Strumenti
              <SlidersHorizontal size={15} aria-hidden="true" />
            </button>
            {desktopToolsOpen && (
              <div className="desktop-tools__menu" role="menu" aria-label="Strumenti">
                {ADVANCED_NAV_ITEMS.map(({ path, label, meta, icon: Icon }) => (
                  <NavLink key={path} to={path} className="desktop-tools__item" role="menuitem">
                    <Icon size={18} aria-hidden="true" />
                    <span><strong>{label}</strong><small>{meta}</small></span>
                  </NavLink>
                ))}
                <button
                  type="button"
                  className="desktop-tools__item desktop-tools__action"
                  onClick={onRefreshStatus}
                  disabled={statusRefreshing}
                  aria-label={statusRefreshing ? 'Aggiornamento sistema in corso' : 'Aggiorna sistema'}
                >
                  <RefreshCw size={18} className={statusRefreshing ? 'fp-spin' : ''} aria-hidden="true" />
                  <span><strong>{statusRefreshing ? 'Aggiornamento...' : 'Aggiorna sistema'}</strong><small>ricarica dati e calendario</small></span>
                </button>
                <button
                  type="button"
                  className="desktop-tools__item desktop-tools__action"
                  onClick={onLogout}
                  role="menuitem"
                >
                  <LogOut size={18} aria-hidden="true" />
                  <span><strong>Esci</strong><small>chiudi la sessione condivisa</small></span>
                </button>
              </div>
            )}
          </div>
        </nav>

        <div className="app-header-right">
          <button
            type="button"
            className="fp-btn fp-btn-ghost fp-btn-sm app-header-glossary"
            onClick={() => window.dispatchEvent(new CustomEvent('glossary-open'))}
            title="Apri glossario rapido"
            aria-label="Apri glossario rapido"
          >
            <HelpCircle size={15} />
            <span className="sr-only">Glossario</span>
          </button>
        </div>
      </header>

      <div className="app-layout">
        <main className={mainContentClass}>
          <Suspense fallback={<div role="status" aria-live="polite">Caricamento pagina…</div>}>
          <Routes>
            <Route path="/" element={<Navigate to="/predictions" replace />} />
            <Route path="/dashboard" element={<Navigate to="/predictions" replace />} />
            <Route path="/predictions" element={<Predictions activeUser={activeUser} />} />
            <Route path="/bets" element={<BetsManager activeUser={activeUser} />} />
            <Route path="/budget" element={<BudgetManager activeUser={activeUser} />} />
            <Route path="/prediction-archive" element={<PredictionArchivePage />} />
            <Route path="/glossary" element={<GlossaryPage />} />
            <Route path="/backtest" element={<Backtesting />} />
            <Route path="/data" element={<DataManager />} />
            <Route path="/scrapers" element={<Scrapers />} />
            <Route path="/transitions" element={<CompetitionTransitions />} />
          </Routes>
          </Suspense>
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
          ref={mobileMoreTriggerRef}
          type="button"
          className={`mobile-nav-item mobile-nav-item--toggle${mobileMoreOpen || isMoreSectionActive ? ' active' : ''}`}
          onClick={() => {
            if (mobileMoreOpen) {
              closeMobileMore();
            } else {
              setMobileMoreOpen(true);
            }
          }}
          aria-expanded={mobileMoreOpen}
          aria-controls="mobile-more-menu"
          aria-label={mobileMoreOpen ? 'Chiudi strumenti mobile' : 'Apri strumenti mobile'}
        >
          <Menu size={18} />
          <span>Strumenti</span>
        </button>
      </nav>
      {mobileMoreOpen && (
        <div
          ref={mobileMoreSheetRef}
          className="mobile-more-sheet"
          id="mobile-more-menu"
          role="dialog"
          aria-modal="true"
          aria-labelledby="mobile-more-title"
        >
          <div className="mobile-more-sheet__header">
            <h2 id="mobile-more-title">Strumenti</h2>
            <button
              ref={mobileMoreCloseRef}
              type="button"
              className="fp-btn fp-btn-ghost fp-btn-sm"
              onClick={() => closeMobileMore()}
              aria-label="Chiudi strumenti"
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
                onClick={() => closeMobileMore(false)}
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
            <button
              type="button"
              className="mobile-more-link mobile-more-link--button"
              onClick={onRefreshStatus}
              disabled={statusRefreshing}
              aria-label={statusRefreshing ? 'Aggiornamento sistema in corso' : 'Aggiorna sistema'}
            >
              <span className="mobile-more-link__icon" aria-hidden="true"><RefreshCw size={18} className={statusRefreshing ? 'fp-spin' : ''} /></span>
              <span className="mobile-more-link__copy">
                <span className="mobile-more-link__label">{statusRefreshing ? 'Aggiornamento...' : 'Aggiorna sistema'}</span>
                <span className="mobile-more-link__meta">ricarica dati e calendario</span>
              </span>
            </button>
            <button
              type="button"
              className="mobile-more-link mobile-more-link--button"
              onClick={onLogout}
            >
              <span className="mobile-more-link__icon" aria-hidden="true"><LogOut size={18} /></span>
              <span className="mobile-more-link__copy">
                <span className="mobile-more-link__label">Esci</span>
                <span className="mobile-more-link__meta">chiudi la sessione condivisa</span>
              </span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};

interface AuthenticatedAppProps {
  activeUser: string;
  onLogout: () => void;
}

const AuthenticatedApp: React.FC<AuthenticatedAppProps> = ({ activeUser, onLogout }) => {
  const [statusRefreshing, setStatusRefreshing] = useState(false);
  const { toasts, showToast, dismissToast } = useToastState();
  const mountedRef = useRef(true);

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
      const statusPayload = await getScraperStatus({ force: !isSilent });
      let kickoffCorrected = 0;
      let kickoffSyncWarning: string | null = null;
      if (!isSilent) {
        try {
          const kickoffPayload = await syncUpcomingKickoffs({ mode: 'top5', season: currentSeason(), limit: 160 });
          kickoffCorrected = Number(kickoffPayload?.data?.corrected ?? 0);
          // The Understat import contains historical rosters. Refresh the
          // current squads in the same user-triggered system update so old
          // transferred players cannot leak into the next prediction.
          await syncUpcomingPlayerAvailability(48);
          window.dispatchEvent(new Event('data-sync-complete'));
        } catch (kickoffError: any) {
          kickoffSyncWarning = kickoffError?.response?.data?.error
            || kickoffError?.message
            || 'Sync calendario non riuscito';
        }
      }
      if (!mountedRef.current) return;
      applyStatus(statusPayload);
      if (!isSilent) {
        if (kickoffSyncWarning) {
          showToast({
            tone: 'warning',
            message: `Sistema aggiornato. Sync calendario non riuscito: ${kickoffSyncWarning}`,
          });
        } else {
          showToast({
            tone: 'success',
            message: kickoffCorrected > 0
              ? `Calendario aggiornato: ${kickoffCorrected} kickoff corretti`
              : 'Sistema aggiornato',
          });
        }
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
      <Router future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <GlossaryProvider>
          <AppShell
            activeUser={activeUser}
            statusRefreshing={statusRefreshing}
            onRefreshStatus={() => { void refreshStatus(); }}
            onLogout={onLogout}
          />
        </GlossaryProvider>
      </Router>
      <ToastStack toasts={toasts} onDismiss={dismissToast} />
    </>
  );
};

const App: React.FC = () => {
  const [session, setSession] = useState<AdminSession | null>(null);
  const [checkingSession, setCheckingSession] = useState(true);

  useEffect(() => {
    let active = true;
    getAdminSession()
      .then((current) => {
        if (active) setSession(current);
      })
      .catch(() => {
        if (active) setSession(null);
      })
      .finally(() => {
        if (active) setCheckingSession(false);
      });
    return () => { active = false; };
  }, []);

  const login = async (password: string) => {
    const current = await loginSharedAdmin(password);
    setSession(current);
  };

  const logout = () => {
    void logoutSharedAdmin().finally(() => setSession(null));
  };

  if (checkingSession) {
    return <main className="shared-login" role="status" aria-live="polite">Verifica accesso…</main>;
  }
  if (!session) return <SharedAdminLogin onLogin={login} />;
  return <AuthenticatedApp activeUser={session.sharedDataUserId} onLogout={logout} />;
};

export default App;
export {
  NAV_ITEMS,
  PRIMARY_NAV_ITEMS,
  ADVANCED_NAV_ITEMS,
  MOBILE_PRIMARY_NAV_ITEMS,
  MOBILE_SECONDARY_NAV_ITEMS,
};
