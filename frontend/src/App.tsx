import React, { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { BrowserRouter as Router, Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { Activity, Archive, BarChart3, Database, FlaskConical, HelpCircle, LogOut, Menu, Moon, Sun, Ticket, Wallet } from 'lucide-react';
import Predictions from './pages/Predictions';
import { GlossaryProvider } from './features/glossary/GlossaryProvider';
import { AdminSession, getAdminSession, getScraperStatus, loginSharedAdmin, logoutSharedAdmin, syncUpcomingKickoffs, syncUpcomingPlayerAvailability } from './utils/api';
import ToastStack from './components/common/ToastStack';
import { useToastState } from './hooks/useToastState';
import { currentSeason } from './components/predictions/predictionWorkbenchUtils';
import SharedAdminLogin from './features/auth/SharedAdminLogin';
import './footpredictor.css';

const BudgetManager = lazy(() => import('./pages/BudgetManager'));
const BetsManager = lazy(() => import('./pages/BetsManager'));
const Backtesting = lazy(() => import('./pages/Backtesting'));
const DataCenter = lazy(() => import('./pages/DataCenter'));
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
  { path: '/data', label: 'Centro dati', meta: 'dati, quote e integrità', icon: Database },
];
const NAV_ITEMS = [...PRIMARY_NAV_ITEMS, ...ADVANCED_NAV_ITEMS];
const MOBILE_PRIMARY_NAV_ITEMS = PRIMARY_NAV_ITEMS;
const MOBILE_SECONDARY_NAV_ITEMS = ADVANCED_NAV_ITEMS;
export type Theme = 'light' | 'dark';
export const getInitialTheme = (): Theme => {
  const stored = window.localStorage.getItem('footpredictor-theme');
  if (stored === 'light' || stored === 'dark') return stored;
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
};
export const applyTheme = (theme: Theme) => {
  document.documentElement.dataset.theme = theme;
  window.localStorage.setItem('footpredictor-theme', theme);
};

interface AppShellProps { activeUser: string; statusRefreshing: boolean; onRefreshStatus: () => void; onLogout: () => void; theme: Theme; onThemeToggle: () => void; }
export const AppShell: React.FC<AppShellProps> = ({ activeUser, statusRefreshing, onRefreshStatus, onLogout, theme, onThemeToggle }) => {
  const location = useLocation();
  const [mobileMoreOpen, setMobileMoreOpen] = useState(false);
  const mobileMoreTriggerRef = useRef<HTMLButtonElement>(null);
  const mobileMoreSheetRef = useRef<HTMLDivElement>(null);
  const mobileMoreCloseRef = useRef<HTMLButtonElement>(null);
  const isMoreSectionActive = MOBILE_SECONDARY_NAV_ITEMS.some(({ path }) => location.pathname === path) || ['/scrapers', '/transitions'].includes(location.pathname);
  const mainContentClass = location.pathname === '/predictions' ? 'main-content main-content--workbench' : 'main-content main-content--scroll';

  useEffect(() => { setMobileMoreOpen(false); }, [location.pathname]);
  const closeMobileMore = useCallback((restoreFocus = true) => { setMobileMoreOpen(false); if (restoreFocus) mobileMoreTriggerRef.current?.focus(); }, []);
  useEffect(() => {
    if (!mobileMoreOpen) return undefined;
    mobileMoreCloseRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); closeMobileMore(); return; }
      if (event.key !== 'Tab' || !mobileMoreSheetRef.current) return;
      const focusable = Array.from(
        mobileMoreSheetRef.current.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])')
      ) as HTMLElement[];
      if (!focusable.length) return;
      const first = focusable[0]; const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [closeMobileMore, mobileMoreOpen]);
  const ThemeButton = () => <button type="button" className="theme-toggle" onClick={onThemeToggle} aria-label={theme === 'light' ? 'Attiva tema scuro' : 'Attiva tema chiaro'} title={theme === 'light' ? 'Tema scuro' : 'Tema chiaro'}>{theme === 'light' ? <Moon size={18} aria-hidden="true" /> : <Sun size={18} aria-hidden="true" />}<span>{theme === 'light' ? 'Scuro' : 'Chiaro'}</span></button>;
  const ToolLinks = ({ mobile = false }: { mobile?: boolean }) => <>{ADVANCED_NAV_ITEMS.map(({ path, label, meta, icon: Icon }) => <NavLink key={path} to={path} className={({ isActive }) => { const active = isActive || (path === '/data' && ['/scrapers', '/transitions'].includes(location.pathname)); return mobile ? `mobile-more-link${active ? ' active' : ''}` : `desktop-tools__item${active ? ' active' : ''}`; }} onClick={() => mobile && closeMobileMore(false)}><span className={mobile ? 'mobile-more-link__icon' : ''}><Icon size={18} aria-hidden="true" /></span><span className={mobile ? 'mobile-more-link__copy' : ''}><strong className={mobile ? 'mobile-more-link__label' : undefined}>{label}</strong><small className={mobile ? 'mobile-more-link__meta' : undefined}>{meta}</small></span></NavLink>)}</>;
  return <div className="app-shell">
    <aside className="sidebar" aria-label="Navigazione principale">
      <div className="sidebar-brand"><span className="app-brand-mark"><Activity size={22} /></span><span><strong>Foot<span>Predictor</span></strong><small>Control room</small></span></div>
      <nav className="sidebar-nav">{PRIMARY_NAV_ITEMS.map(({ path, label, meta, icon: Icon }) => <NavLink key={path} to={path} className={({ isActive }) => `nav-item${isActive ? ' active' : ''}`}><span className="nav-icon-wrap"><Icon size={19} /></span><span className="nav-copy"><span className="nav-label">{label}</span><span className="nav-meta">{meta}</span></span></NavLink>)}</nav>
      <nav className="sidebar-nav sidebar-nav--secondary" aria-label="Strumenti e archivi"><ToolLinks /></nav>
      <div className="sidebar-footer"><button type="button" className="sidebar-logout" onClick={onLogout}><LogOut size={17} /> Esci</button></div>
    </aside>
    <header className="app-header"><div className="app-brand"><div className="app-brand-copy"><div className="app-brand-name">Foot<span>Predictor</span></div><div className="app-brand-tag">Decisioni rapide su pick, quote e bankroll</div></div></div><div className="app-header-right"><button type="button" className="fp-btn fp-btn-ghost fp-btn-sm app-header-glossary" onClick={() => window.dispatchEvent(new CustomEvent('glossary-open'))} aria-label="Apri glossario rapido"><HelpCircle size={17} /></button><ThemeButton /></div></header>
    <div className="app-layout"><main className={mainContentClass}><Suspense fallback={<div className="page-loading" role="status">Caricamento pagina…</div>}><Routes><Route path="/" element={<Navigate to="/predictions" replace />} /><Route path="/dashboard" element={<Navigate to="/predictions" replace />} /><Route path="/predictions" element={<Predictions activeUser={activeUser} />} /><Route path="/bets" element={<BetsManager activeUser={activeUser} />} /><Route path="/budget" element={<BudgetManager activeUser={activeUser} />} /><Route path="/prediction-archive" element={<PredictionArchivePage />} /><Route path="/glossary" element={<GlossaryPage />} /><Route path="/backtest" element={<Backtesting />} /><Route path="/data" element={<DataCenter initialTab="data" statusRefreshing={statusRefreshing} onRefreshStatus={onRefreshStatus} />} /><Route path="/scrapers" element={<DataCenter initialTab="providers" statusRefreshing={statusRefreshing} onRefreshStatus={onRefreshStatus} />} /><Route path="/transitions" element={<DataCenter initialTab="integrity" statusRefreshing={statusRefreshing} onRefreshStatus={onRefreshStatus} />} /></Routes></Suspense></main></div>
    <nav className="mobile-nav" aria-label="Navigazione rapida">{MOBILE_PRIMARY_NAV_ITEMS.map(({ path, label, icon: Icon }) => <NavLink key={path} to={path} className={({ isActive }) => `mobile-nav-item${isActive ? ' active' : ''}`}><Icon size={18} /><span>{label}</span></NavLink>)}<button ref={mobileMoreTriggerRef} type="button" className={`mobile-nav-item mobile-nav-item--toggle${mobileMoreOpen || isMoreSectionActive ? ' active' : ''}`} onClick={() => mobileMoreOpen ? closeMobileMore() : setMobileMoreOpen(true)} aria-expanded={mobileMoreOpen} aria-controls="mobile-more-menu"><Menu size={18} /><span>Strumenti</span></button></nav>
    {mobileMoreOpen && <div ref={mobileMoreSheetRef} className="mobile-more-sheet" id="mobile-more-menu" role="dialog" aria-modal="true" aria-labelledby="mobile-more-title"><div className="mobile-more-sheet__header"><h2 id="mobile-more-title">Strumenti</h2><button ref={mobileMoreCloseRef} type="button" className="fp-btn fp-btn-ghost fp-btn-sm" onClick={() => closeMobileMore()}>Chiudi</button></div><div className="mobile-more-sheet__grid"><ToolLinks mobile /><button type="button" className="mobile-more-link mobile-more-link--button" onClick={onLogout}><span className="mobile-more-link__icon"><LogOut size={18} /></span><span className="mobile-more-link__copy"><strong className="mobile-more-link__label">Esci</strong><small className="mobile-more-link__meta">chiudi la sessione condivisa</small></span></button></div></div>}
  </div>;
};

interface AuthenticatedAppProps { activeUser: string; onLogout: () => void; theme: Theme; onThemeToggle: () => void; }
const AuthenticatedApp: React.FC<AuthenticatedAppProps> = ({ activeUser, onLogout, theme, onThemeToggle }) => {
  const [statusRefreshing, setStatusRefreshing] = useState(false); const { toasts, showToast, dismissToast } = useToastState(); const mountedRef = useRef(true);
  const applyStatus = useCallback((payload: any) => { const scheduler = payload?.data?.understatScheduler; const lastUpdate = payload?.data?.lastUpdate; if (payload?.data?.isUpdating || scheduler?.running) return; if (lastUpdate?.success) window.dispatchEvent(new Event('data-sync-complete')); if (lastUpdate?.success === false) window.dispatchEvent(new Event('data-sync-error')); }, []);
  const refreshStatus = useCallback(async (options?: { silent?: boolean }) => { const silent = options?.silent === true; if (!silent && mountedRef.current) setStatusRefreshing(true); try { const status = await getScraperStatus({ force: !silent }); let corrected = 0; let warning: string | null = null; if (!silent) { try { const kickoff = await syncUpcomingKickoffs({ mode: 'top5', season: currentSeason(), limit: 160 }); corrected = Number(kickoff?.data?.corrected ?? 0); await syncUpcomingPlayerAvailability(48); window.dispatchEvent(new Event('data-sync-complete')); } catch (error: any) { warning = error?.response?.data?.error || error?.message || 'Sync calendario non riuscito'; } } if (!mountedRef.current) return; applyStatus(status); if (!silent) showToast({ tone: warning ? 'warning' : 'success', message: warning ? `Sistema aggiornato. Sync calendario non riuscito: ${warning}` : corrected > 0 ? `Calendario aggiornato: ${corrected} kickoff corretti` : 'Sistema aggiornato' }); } catch (error: any) { if (!mountedRef.current) return; if (!silent) showToast({ tone: 'error', message: error?.response?.data?.error || error?.message || 'Errore aggiornamento' }); window.dispatchEvent(new Event('data-sync-error')); } finally { if (!silent && mountedRef.current) setStatusRefreshing(false); } }, [applyStatus, showToast]);
  useEffect(() => { mountedRef.current = true; void refreshStatus({ silent: true }); const interval = setInterval(() => void refreshStatus({ silent: true }), 60000); const manual = () => void refreshStatus(); window.addEventListener('scraper-status-refresh', manual); return () => { mountedRef.current = false; clearInterval(interval); window.removeEventListener('scraper-status-refresh', manual); }; }, [refreshStatus]);
  return <><Router future={{ v7_startTransition: true, v7_relativeSplatPath: true }}><GlossaryProvider><AppShell activeUser={activeUser} statusRefreshing={statusRefreshing} onRefreshStatus={() => void refreshStatus()} onLogout={onLogout} theme={theme} onThemeToggle={onThemeToggle} /></GlossaryProvider></Router><ToastStack toasts={toasts} onDismiss={dismissToast} /></>;
};
const App: React.FC = () => { const [theme, setTheme] = useState<Theme>(() => { const initial = getInitialTheme(); applyTheme(initial); return initial; }); const [session, setSession] = useState<AdminSession | null>(null); const [checkingSession, setCheckingSession] = useState(true); useEffect(() => { applyTheme(theme); }, [theme]); useEffect(() => { let active = true; getAdminSession().then((current) => active && setSession(current)).catch(() => active && setSession(null)).finally(() => active && setCheckingSession(false)); return () => { active = false; }; }, []); const login = async (password: string) => setSession(await loginSharedAdmin(password)); const logout = () => { void logoutSharedAdmin().finally(() => setSession(null)); }; const toggleTheme = () => setTheme((current) => current === 'light' ? 'dark' : 'light'); if (checkingSession) return <main className="shared-login" role="status">Verifica accesso…</main>; return session ? <AuthenticatedApp activeUser={session.sharedDataUserId} onLogout={logout} theme={theme} onThemeToggle={toggleTheme} /> : <SharedAdminLogin onLogin={login} theme={theme} onThemeToggle={toggleTheme} />; };
export default App;
export { NAV_ITEMS, PRIMARY_NAV_ITEMS, ADVANCED_NAV_ITEMS, MOBILE_PRIMARY_NAV_ITEMS, MOBILE_SECONDARY_NAV_ITEMS };
