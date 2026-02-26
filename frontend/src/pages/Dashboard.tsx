import React, { useEffect, useState } from 'react';
import { getBudget, getBets, getMatches, initBudget } from '../utils/api';

interface DashboardProps {
  activeUser: string;
}

const Dashboard: React.FC<DashboardProps> = ({ activeUser }) => {
  const [budget, setBudget] = useState<any>(null);
  const [recentBets, setRecentBets] = useState<any[]>([]);
  const [matchCount, setMatchCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [initAmount, setInitAmount] = useState('1000');
  const [showInit, setShowInit] = useState(false);

  useEffect(() => {
    loadData();
  }, [activeUser]);

  const loadData = async () => {
    setLoading(true);
    try {
      const [budgetRes, betsRes, matchesRes] = await Promise.all([
        getBudget(activeUser),
        getBets(activeUser),
        getMatches(),
      ]);
      if (budgetRes.data) setBudget(budgetRes.data);
      else setShowInit(true);
      setRecentBets((betsRes.data ?? []).slice(0, 5));
      setMatchCount(matchesRes.count ?? 0);
    } catch {
      setShowInit(true);
    }
    setLoading(false);
  };

  const handleInitBudget = async () => {
    const amount = parseFloat(initAmount);
    if (isNaN(amount) || amount <= 0) return;
    const res = await initBudget(activeUser, amount);
    if (res.data) {
      setBudget(res.data);
      setShowInit(false);
    }
  };

  if (loading) return (
    <div className="loading-spinner"><div className="spinner"></div><span>Caricamento...</span></div>
  );

  const roi = budget?.roi ?? 0;
  const winRate = budget?.win_rate ?? 0;

  return (
    <div>
      <h1 className="page-title">Dashboard</h1>
      <p className="page-subtitle">Panoramica del sistema</p>

      {showInit && (
        <div className="card">
          <div className="card-header"><h2 className="card-title">💰 Inizializza Budget</h2></div>
          <p style={{ marginBottom: 14, color: 'var(--text-secondary)' }}>
            Nessun budget trovato. Imposta il budget iniziale per cominciare.
          </p>
          <div className="form-row" style={{ maxWidth: 400 }}>
            <div className="form-group">
              <label className="form-label">Budget iniziale (€)</label>
              <input
                className="form-input"
                type="number"
                value={initAmount}
                onChange={e => setInitAmount(e.target.value)}
                min="10"
                step="10"
              />
            </div>
          </div>
          <button className="btn btn-primary" onClick={handleInitBudget}>
            Inizializza Budget
          </button>
        </div>
      )}

      {budget && (
        <>
          <div className="grid-4" style={{ marginBottom: 20 }}>
            <div className="stat-box">
              <div className="stat-value">€{budget.available_budget?.toFixed(2)}</div>
              <div className="stat-label">Budget Disponibile</div>
            </div>
            <div className="stat-box">
              <div className="stat-value" style={{ color: roi >= 0 ? 'var(--secondary)' : 'var(--danger)' }}>
                {roi >= 0 ? '+' : ''}{roi?.toFixed(2)}%
              </div>
              <div className="stat-label">ROI</div>
            </div>
            <div className="stat-box">
              <div className="stat-value">{winRate?.toFixed(1)}%</div>
              <div className="stat-label">Win Rate</div>
            </div>
            <div className="stat-box">
              <div className="stat-value">{budget.total_bets ?? 0}</div>
              <div className="stat-label">Scommesse Totali</div>
            </div>
          </div>

          <div className="grid-2">
            <div className="card">
              <div className="card-header"><h2 className="card-title">📊 Riepilogo Finanziario</h2></div>
              <table>
                <tbody>
                  <tr><td>Budget Totale</td><td style={{ fontWeight: 600 }}>€{budget.total_budget?.toFixed(2)}</td></tr>
                  <tr><td>Budget Disponibile</td><td style={{ fontWeight: 600, color: 'var(--primary)' }}>€{budget.available_budget?.toFixed(2)}</td></tr>
                  <tr><td>Totale Puntato</td><td>€{budget.total_staked?.toFixed(2)}</td></tr>
                  <tr><td>Totale Vinto</td><td style={{ color: 'var(--secondary)' }}>€{budget.total_won?.toFixed(2)}</td></tr>
                  <tr><td>Totale Perso</td><td style={{ color: 'var(--danger)' }}>€{budget.total_lost?.toFixed(2)}</td></tr>
                  <tr>
                    <td>Profitto Netto</td>
                    <td style={{ fontWeight: 700, color: (budget.total_won - budget.total_lost) >= 0 ? 'var(--secondary)' : 'var(--danger)' }}>
                      €{((budget.total_won ?? 0) - (budget.total_lost ?? 0)).toFixed(2)}
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>

            <div className="card">
              <div className="card-header"><h2 className="card-title">🗄️ Dati nel Sistema</h2></div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
                <div className="stat-box" style={{ textAlign: 'left', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>Partite nel database</span>
                  <span style={{ fontWeight: 700, fontSize: 18 }}>{matchCount}</span>
                </div>
                <div className="alert alert-info">
                  💡 Importa dati storici dalla sezione <strong>Gestione Dati</strong> per addestrare il modello.
                  Poi usa <strong>Previsioni</strong> per analizzare le prossime partite.
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {recentBets.length > 0 && (
        <div className="card">
          <div className="card-header"><h2 className="card-title">🎯 Ultime Scommesse</h2></div>
          <table>
            <thead>
              <tr>
                <th>Mercato</th>
                <th>Selezione</th>
                <th>Quota</th>
                <th>Puntata</th>
                <th>Nostra P%</th>
                <th>EV</th>
                <th>Stato</th>
                <th>Profitto</th>
              </tr>
            </thead>
            <tbody>
              {recentBets.map((bet: any) => (
                <tr key={bet.bet_id}>
                  <td>{bet.market_name}</td>
                  <td>{bet.selection}</td>
                  <td>{bet.odds?.toFixed(2)}</td>
                  <td>€{bet.stake?.toFixed(2)}</td>
                  <td>{(bet.our_probability * 100)?.toFixed(2)}%</td>
                  <td style={{ color: 'var(--secondary)' }}>+{(bet.expected_value * 100)?.toFixed(2)}%</td>
                  <td>
                    <span className={`badge badge-${bet.status === 'WON' ? 'green' : bet.status === 'LOST' ? 'red' : bet.status === 'PENDING' ? 'blue' : 'gray'}`}>
                      {bet.status}
                    </span>
                  </td>
                  <td style={{ color: bet.profit > 0 ? 'var(--secondary)' : bet.profit < 0 ? 'var(--danger)' : undefined }}>
                    {bet.profit !== null ? `€${bet.profit?.toFixed(2)}` : '-'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

export default Dashboard;
