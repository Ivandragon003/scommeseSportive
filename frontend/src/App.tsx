import React, { useState } from 'react';
import { BrowserRouter as Router, Routes, Route, NavLink } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Predictions from './pages/Predictions';
import BudgetManager from './pages/BudgetManager';
import Backtesting from './pages/Backtesting';
import DataManager from './pages/DataManager';
import Scrapers from './pages/Scrapers';
import './App.css';

const App: React.FC = () => {
  const [activeUser, setActiveUser] = useState<'user1' | 'user2'>('user1');

  return (
    <Router>
      <div className="app">
        <header className="header">
          <div className="header-brand">
            <span className="header-icon">⚽</span>
            <span className="header-title">FootPredictor</span>
            <span className="header-subtitle">Sistema di Analisi Statistica</span>
          </div>
          <div className="header-user">
            <span className="user-label">Utente attivo:</span>
            <div className="user-toggle">
              <button
                className={`user-btn ${activeUser === 'user1' ? 'active' : ''}`}
                onClick={() => setActiveUser('user1')}
              >
                Giocatore 1
              </button>
              <button
                className={`user-btn ${activeUser === 'user2' ? 'active' : ''}`}
                onClick={() => setActiveUser('user2')}
              >
                Giocatore 2
              </button>
            </div>
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
