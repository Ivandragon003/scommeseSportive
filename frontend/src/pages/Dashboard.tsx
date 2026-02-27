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

  useEffect(() => { loadData(); }, [activeUser]);

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
    <div className="fp-spinner-wrap" style={{ minHeight: '60vh' }}>
      <div className="fp-spinner" />
      <span className="fp-spinner-text">Caricamento...</span>
    </div>
  );

  const roi = budget?.roi ?? 0;
  const winRate = budget?.win_rate ?? 0;
  const netProfit = (budget?.total_won ?? 0) - (budget?.total_lost ?? 0);

  return (
    <div style={{ padding: '40px 32px', minHeight: '100vh' }}>

      {/* HEADER */}
      <div style={{ marginBottom: 32 }}>
        <h1 className="fp-page-title fp-gradient-blue">
          Dashboard
        </h1>
        <p style={{ fontSize: 12, color: 'var(--text-2)', margin: 0, fontFamily: 'DM Mono, monospace' }}>
          Panoramica del sistema · {activeUser}
        </p>
      </div>

      {/* INIT BUDGET */}
      {showInit && (
        <div className="fp-card" style={{ maxWidth: 520, margin: '0 auto 32px' }}>
          <div className="fp-card-head">
            <div className="fp-card-title">💼 Inizializza Budget</div>
          </div>
          <div className="fp-card-body">
            <p style={{ marginBottom: 18, color: 'var(--text-2)', fontSize: 14, lineHeight: 1.6 }}>
              Nessun budget trovato. Imposta il budget iniziale per cominciare.
            </p>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', maxWidth: 340 }}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label className="fp-label">Budget iniziale (€)</label>
                <input
                  className="fp-input"
                  type="number"
                  value={initAmount}
                  onChange={e => setInitAmount(e.target.value)}
                  min="10"
                  step="10"
                />
              </div>
              <button className="fp-btn fp-btn-solid" onClick={handleInitBudget}>
                Inizializza →
              </button>
            </div>
          </div>
        </div>
      )}

      {budget && (
        <>
          {/* STAT GRID */}
          <div className="fp-grid-4" style={{ marginBottom: 24 }}>
            {[
              {
                icon: '💰', label: 'Budget Disponibile',
                val: `€${budget.available_budget?.toFixed(2)}`,
                c: 'green',
              },
              {
                icon: roi >= 0 ? '📈' : '📉', label: 'ROI',
                val: `${roi >= 0 ? '+' : ''}${roi?.toFixed(2)}%`,
                c: roi >= 0 ? 'green' : 'red',
              },
              {
                icon: '🎯', label: 'Win Rate',
                val: `${winRate?.toFixed(1)}%`,
                c: 'gold',
              },
              {
                icon: '🧾', label: 'Scommesse Totali',
                val: budget.total_bets ?? 0,
                c: 'blue',
              },
            ].map(({ icon, label, val, c }) => (
              <div key={label} className={`fp-stat c-${c}`}>
                <span className="fp-stat-icon">{icon}</span>
                <div className={`fp-stat-val c-${c}`}>{String(val)}</div>
                <div className="fp-stat-label">{label}</div>
              </div>
            ))}
          </div>

          {/* TWO COL */}
          <div className="fp-grid-2" style={{ marginBottom: 24 }}>

            {/* Riepilogo finanziario */}
            <div className="fp-card">
              <div className="fp-card-head">
                <div className="fp-card-title">📊 Riepilogo Finanziario</div>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table className="fp-table">
                  <tbody>
                    {[
                      { label: 'Budget Totale', val: `€${budget.total_budget?.toFixed(2)}`, style: { fontWeight: 700 } },
                      { label: 'Budget Disponibile', val: `€${budget.available_budget?.toFixed(2)}`, style: { color: 'var(--blue)', fontWeight: 700 } },
                      { label: 'Totale Puntato', val: `€${budget.total_staked?.toFixed(2)}`, style: {} },
                      { label: 'Totale Vinto', val: `€${budget.total_won?.toFixed(2)}`, style: { color: 'var(--green)', fontWeight: 600 } },
                      { label: 'Totale Perso', val: `€${budget.total_lost?.toFixed(2)}`, style: { color: 'var(--red)', fontWeight: 600 } },
                      {
                        label: 'Profitto Netto',
                        val: `${netProfit >= 0 ? '+' : ''}€${netProfit.toFixed(2)}`,
                        style: { fontWeight: 800, color: netProfit >= 0 ? 'var(--green)' : 'var(--red)', fontSize: 15 }
                      },
                    ].map(({ label, val, style }) => (
                      <tr key={label}>
                        <td style={{ color: 'var(--text-2)' }}>{label}</td>
                        <td className="fp-mono" style={{ textAlign: 'right', ...style }}>{val}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>

            {/* Dati sistema */}
            <div className="fp-card">
              <div className="fp-card-head">
                <div className="fp-card-title">🗄️ Dati nel Sistema</div>
              </div>
              <div className="fp-card-body">
                <div style={{
                  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                  background: 'var(--surface2)', border: '1px solid var(--border)',
                  borderRadius: 'var(--radius-sm)', padding: '18px 20px',
                  marginBottom: 16,
                }}>
                  <span style={{ color: 'var(--text-2)', fontSize: 14 }}>Partite nel database</span>
                  <span style={{ fontWeight: 800, fontSize: 22, fontFamily: 'DM Mono, monospace', color: 'var(--blue)' }}>
                    {matchCount}
                  </span>
                </div>
                <div className="fp-alert fp-alert-info">
                  💡 Importa dati storici dalla sezione <strong>Gestione Dati</strong> per addestrare il modello.
                  Poi usa <strong>Previsioni</strong> per analizzare le prossime partite.
                </div>
              </div>
            </div>
          </div>
        </>
      )}

      {/* ULTIME SCOMMESSE */}
      {recentBets.length > 0 && (
        <div className="fp-card">
          <div className="fp-card-head">
            <div className="fp-card-title">🎯 Ultime Scommesse</div>
            <span className="fp-badge fp-badge-gray">{recentBets.length} recenti</span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="fp-table">
              <thead>
                <tr>
                  <th>Mercato</th>
                  <th>Selezione</th>
                  <th>Quota</th>
                  <th>Puntata</th>
                  <th>P. Nostra</th>
                  <th>EV</th>
                  <th>Stato</th>
                  <th>Profitto</th>
                </tr>
              </thead>
              <tbody>
                {recentBets.map((bet: any) => (
                  <tr key={bet.bet_id}>
                    <td style={{ fontWeight: 600 }}>{bet.market_name}</td>
                    <td style={{ color: 'var(--text-2)' }}>{bet.selection}</td>
                    <td className="fp-mono">{bet.odds?.toFixed(2)}</td>
                    <td className="fp-mono">€{bet.stake?.toFixed(2)}</td>
                    <td className="fp-mono">{(bet.our_probability * 100)?.toFixed(2)}%</td>
                    <td className="fp-mono" style={{ color: 'var(--green)', fontWeight: 600 }}>
                      +{(bet.expected_value * 100)?.toFixed(2)}%
                    </td>
                    <td>
                      <span className={`fp-badge ${bet.status === 'WON' ? 'fp-badge-green' : bet.status === 'LOST' ? 'fp-badge-red' : bet.status === 'PENDING' ? 'fp-badge-blue' : 'fp-badge-gray'}`}>
                        {bet.status === 'WON' ? '✓ VINTA' : bet.status === 'LOST' ? '✕ PERSA' : bet.status === 'PENDING' ? '⏳ ATTESA' : bet.status}
                      </span>
                    </td>
                    <td className="fp-mono" style={{
                      color: bet.profit > 0 ? 'var(--green)' : bet.profit < 0 ? 'var(--red)' : 'var(--text-2)',
                      fontWeight: 600
                    }}>
                      {bet.profit !== null ? `${bet.profit > 0 ? '+' : ''}€${bet.profit?.toFixed(2)}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export default Dashboard;