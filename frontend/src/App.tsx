import React, { useEffect, useState } from 'react';
import { BrowserRouter as Router, Routes, Route, NavLink } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Predictions from './pages/Predictions';
import BudgetManager from './pages/BudgetManager';
import Backtesting from './pages/Backtesting';
import DataManager from './pages/DataManager';
import Scrapers from './pages/Scrapers';
import { autoRefreshDataOnEnter } from './utils/api';
import './footpredictor.css';

const App: React.FC = () => {
  const activeUser = 'user1';
  const [syncStatus, setSyncStatus] = useState<{
    state: 'idle' | 'loading' | 'success' | 'error';
    message: string;
  }>({
    state: 'loading',
    message: 'Aggiornamento dati in corso...',
  });

  useEffect(() => {
    let active = true;
    const runAutoRefresh = async () => {
      setSyncStatus({ state: 'loading', message: 'Aggiornamento dati in corso...' });
      try {
        const response = await autoRefreshDataOnEnter({
          mode: 'top5',
          yearsBack: 2,
          importPlayers: false,
          includeMatchDetails: false,
          forceRefresh: false,
        });
        if (!active) return;
        if (response?.success) {
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
        const msg = error?.response?.data?.error || error?.message || 'Errore durante aggiornamento automatico.';
        if (String(msg).toLowerCase().includes('gia in corso')) {
          setSyncStatus({
            state: 'loading',
            message: 'Aggiornamento già in corso su un altro processo...',
          });
          return;
        }
        setSyncStatus({
          state: 'error',
          message: msg,
        });
        window.dispatchEvent(new Event('data-sync-error'));
      }
    };

    void runAutoRefresh();
    return () => { active = false; };
  }, []);

  return (
    <Router>
      <div className="app">
        <div style={{
          padding: '8px 16px',
          fontSize: 12,
          borderBottom: '1px solid var(--border)',
          background: syncStatus.state === 'error'
            ? 'var(--red-dim)'
            : syncStatus.state === 'success'
              ? 'var(--green-dim)'
              : 'var(--surface2)',
          color: syncStatus.state === 'error'
            ? 'var(--red)'
            : syncStatus.state === 'success'
              ? 'var(--green)'
              : 'var(--text-2)',
          fontFamily: 'DM Mono, monospace',
        }}>
          {syncStatus.message}
        </div>
        <header className="header">
          <div className="header-brand">
            <span className="header-icon">⚽</span>
            <span className="header-title">FootPredictor</span>
            <span className="header-subtitle">Sistema di Analisi Statistica</span>
          </div>
        </header>

        <nav className="sidebar">
          <NavLink to="/" end className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <span className="nav-icon">📊</span>
            <span>Dashboard</span>
          </NavLink>
          <NavLink to="/predictions" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <span className="nav-icon">🔮</span>
            <span>Previsioni</span>
          </NavLink>
          <NavLink to="/budget" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <span className="nav-icon">💰</span>
            <span>Budget & Scommesse</span>
          </NavLink>
          <NavLink to="/backtest" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <span className="nav-icon">📈</span>
            <span>Backtesting</span>
          </NavLink>
          <NavLink to="/data" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <span className="nav-icon">🗄️</span>
            <span>Gestione Dati</span>
          </NavLink>
          <NavLink to="/scrapers" className={({ isActive }) => `nav-item ${isActive ? 'active' : ''}`}>
            <span className="nav-icon">🌐</span>
            <span>Dati Automatici</span>
          </NavLink>
        </nav>

        <main className="main-content">
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
    </Router>
  );
};

export default App;
