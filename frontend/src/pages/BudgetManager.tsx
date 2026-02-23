import React, { useEffect, useState } from 'react';
import { getBudget, getBets, settleBet, initBudget } from '../utils/api';

interface BudgetManagerProps {
  activeUser: string;
}

const BudgetManager: React.FC<BudgetManagerProps> = ({ activeUser }) => {
  const [budget, setBudget] = useState<any>(null);
  const [bets, setBets] = useState<any[]>([]);
  const [filter, setFilter] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [settlingId, setSettlingId] = useState<string | null>(null);
  const [initAmount, setInitAmount] = useState('1000');
  const [showReset, setShowReset] = useState(false);

  useEffect(() => {
    loadAll();
  }, [activeUser, filter]);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [budgetRes, betsRes] = await Promise.all([
        getBudget(activeUser),
        getBets(activeUser, filter || undefined),
      ]);
      setBudget(budgetRes.data);
      setBets(betsRes.data ?? []);
    } catch {
      setBudget(null);
    }
    setLoading(false);
  };

  const handleSettle = async (betId: string, won: boolean) => {
    setSettlingId(betId);
    try {
      await settleBet(betId, won);
      await loadAll();
    } catch (e: any) {
      alert('Errore: ' + e.message);
    }
    setSettlingId(null);
  };

  const handleReset = async () => {
    const amount = parseFloat(initAmount);
    if (isNaN(amount) || amount <= 0) return;
    await initBudget(activeUser, amount);
    await loadAll();
    setShowReset(false);
  };

  if (loading) return <div className="loading-spinner"><div className="spinner"></div></div>;

  const pendingBets = bets.filter(b => b.status === 'PENDING');
  const settledBets = bets.filter(b => b.status !== 'PENDING');

  return (
    <div>
      <h1 className="page-title">💰 Budget & Scommesse</h1>
      <p className="page-subtitle">Gestione bankroll e registro scommesse per {activeUser === 'user1' ? 'Giocatore 1' : 'Giocatore 2'}</p>

      {!budget ? (
        <div className="card">
          <div className="card-header"><h2 className="card-title">Inizializza Budget</h2></div>
          <div className="form-group" style={{ maxWidth: 300 }}>
            <label className="form-label">Budget iniziale (€)</label>
            <input className="form-input" type="number" value={initAmount} onChange={e => setInitAmount(e.target.value)} />
          </div>
          <button className="btn btn-primary" onClick={handleReset}>Crea Budget</button>
        </div>
      ) : (
        <>
          {/* Budget overview */}
          <div className="grid-4" style={{ marginBottom: 20 }}>
            <div className="stat-box">
              <div className="stat-value">€{budget.available_budget?.toFixed(2)}</div>
              <div className="stat-label">Budget Disponibile</div>
            </div>
            <div className="stat-box">
              <div className="stat-value" style={{ color: budget.roi >= 0 ? 'var(--secondary)' : 'var(--danger)' }}>
                {budget.roi >= 0 ? '+' : ''}{budget.roi?.toFixed(2)}%
              </div>
              <div className="stat-label">ROI</div>
            </div>
            <div className="stat-box">
              <div className="stat-value">{budget.win_rate?.toFixed(1)}%</div>
              <div className="stat-label">Win Rate</div>
            </div>
            <div className="stat-box">
              <div className="stat-value">{pendingBets.length}</div>
              <div className="stat-label">Scommesse in Attesa</div>
            </div>
          </div>

          <div className="grid-2" style={{ marginBottom: 20 }}>
            <div className="card">
              <div className="card-header">
                <h2 className="card-title">📊 Dettaglio Finanziario</h2>
                <button className="btn btn-secondary btn-sm" onClick={() => setShowReset(!showReset)}>
                  ⚙️ Reset Budget
                </button>
              </div>
              {showReset && (
                <div style={{ marginBottom: 14, padding: 12, background: 'var(--bg)', borderRadius: 6 }}>
                  <div className="form-row">
                    <div className="form-group" style={{ marginBottom: 0 }}>
                      <label className="form-label">Nuovo importo (€)</label>
                      <input className="form-input" type="number" value={initAmount} onChange={e => setInitAmount(e.target.value)} />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'flex-end' }}>
                      <button className="btn btn-danger" onClick={handleReset}>Conferma Reset</button>
                    </div>
                  </div>
                  <div className="alert alert-warning" style={{ marginTop: 8 }}>
                    ⚠️ Il reset azzera tutte le statistiche per questo utente.
                  </div>
                </div>
              )}
              <table>
                <tbody>
                  <tr><td>Budget Iniziale</td><td>€{budget.total_budget?.toFixed(2)}</td></tr>
                  <tr><td>Disponibile</td><td style={{ color: 'var(--primary)', fontWeight: 700 }}>€{budget.available_budget?.toFixed(2)}</td></tr>
                  <tr><td>Totale Puntato</td><td>€{budget.total_staked?.toFixed(2)}</td></tr>
                  <tr><td>Totale Vinto</td><td style={{ color: 'var(--secondary)' }}>€{budget.total_won?.toFixed(2)}</td></tr>
                  <tr><td>Totale Perso</td><td style={{ color: 'var(--danger)' }}>€{budget.total_lost?.toFixed(2)}</td></tr>
                  <tr>
                    <td style={{ fontWeight: 600 }}>Profitto Netto</td>
                    <td style={{ fontWeight: 700, color: (budget.total_won - budget.total_lost) >= 0 ? 'var(--secondary)' : 'var(--danger)' }}>
                      €{((budget.total_won ?? 0) - (budget.total_lost ?? 0)).toFixed(2)}
                    </td>
                  </tr>
                  <tr><td>Scommesse totali</td><td>{budget.total_bets}</td></tr>
                  <tr><td>Win Rate</td><td>{budget.win_rate?.toFixed(2)}%</td></tr>
                  <tr><td>ROI</td><td style={{ fontWeight: 700, color: budget.roi >= 0 ? 'var(--secondary)' : 'var(--danger)' }}>{budget.roi?.toFixed(2)}%</td></tr>
                </tbody>
              </table>
            </div>

            {/* Progress bar visual */}
            <div className="card">
              <div className="card-header"><h2 className="card-title">💹 Performance Visiva</h2></div>
              <div style={{ marginBottom: 20 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 13 }}>
                  <span>Budget utilizzato</span>
                  <span>{(((budget.total_budget - budget.available_budget) / budget.total_budget) * 100).toFixed(1)}%</span>
                </div>
                <div style={{ background: '#f0f0f0', borderRadius: 8, height: 24, overflow: 'hidden' }}>
                  <div
                    style={{
                      height: '100%',
                      background: 'var(--primary)',
                      width: `${Math.min(100, ((budget.total_budget - budget.available_budget) / budget.total_budget) * 100)}%`,
                      borderRadius: 8,
                      transition: 'width 0.5s ease',
                    }}
                  />
                </div>
              </div>
              <div style={{ marginBottom: 20 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4, fontSize: 13 }}>
                  <span>Win Rate</span>
                  <span>{budget.win_rate?.toFixed(1)}%</span>
                </div>
                <div style={{ background: '#f0f0f0', borderRadius: 8, height: 24, overflow: 'hidden' }}>
                  <div
                    style={{
                      height: '100%',
                      background: budget.win_rate >= 50 ? 'var(--secondary)' : 'var(--warning)',
                      width: `${Math.min(100, budget.win_rate ?? 0)}%`,
                      borderRadius: 8,
                    }}
                  />
                </div>
              </div>
            </div>
          </div>

          {/* Pending bets */}
          {pendingBets.length > 0 && (
            <div className="card">
              <div className="card-header">
                <h2 className="card-title">⏳ Scommesse in Attesa ({pendingBets.length})</h2>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Mercato</th>
                    <th>Selezione</th>
                    <th>Quota</th>
                    <th>Puntata</th>
                    <th>P. Nostra</th>
                    <th>EV</th>
                    <th>Data</th>
                    <th>Azioni</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingBets.map((bet: any) => (
                    <tr key={bet.bet_id}>
                      <td>{bet.market_name}</td>
                      <td style={{ fontWeight: 600 }}>{bet.selection}</td>
                      <td>{bet.odds?.toFixed(2)}</td>
                      <td>€{bet.stake?.toFixed(2)}</td>
                      <td>{(bet.our_probability * 100)?.toFixed(2)}%</td>
                      <td style={{ color: 'var(--secondary)', fontWeight: 600 }}>+{(bet.expected_value * 100)?.toFixed(2)}%</td>
                      <td>{new Date(bet.placed_at).toLocaleDateString('it-IT')}</td>
                      <td>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            className="btn btn-success btn-sm"
                            disabled={settlingId === bet.bet_id}
                            onClick={() => handleSettle(bet.bet_id, true)}
                          >
                            ✅ Vinta
                          </button>
                          <button
                            className="btn btn-danger btn-sm"
                            disabled={settlingId === bet.bet_id}
                            onClick={() => handleSettle(bet.bet_id, false)}
                          >
                            ❌ Persa
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* All bets */}
          <div className="card">
            <div className="card-header">
              <h2 className="card-title">📋 Storico Scommesse</h2>
              <div style={{ display: 'flex', gap: 8 }}>
                {['', 'PENDING', 'WON', 'LOST'].map(s => (
                  <button
                    key={s}
                    className={`btn btn-sm ${filter === s ? 'btn-primary' : 'btn-secondary'}`}
                    onClick={() => setFilter(s)}
                  >
                    {s || 'Tutte'}
                  </button>
                ))}
              </div>
            </div>
            {bets.length === 0 ? (
              <div className="alert alert-info">Nessuna scommessa registrata.</div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Mercato</th>
                    <th>Quota</th>
                    <th>Puntata</th>
                    <th>Stato</th>
                    <th>Profitto</th>
                    <th>Data</th>
                  </tr>
                </thead>
                <tbody>
                  {bets.slice(0, 50).map((bet: any) => (
                    <tr key={bet.bet_id}>
                      <td>
                        <div style={{ fontWeight: 600, fontSize: 13 }}>{bet.market_name}</div>
                        <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>{bet.selection}</div>
                      </td>
                      <td>{bet.odds?.toFixed(2)}</td>
                      <td>€{bet.stake?.toFixed(2)}</td>
                      <td>
                        <span className={`badge badge-${bet.status === 'WON' ? 'green' : bet.status === 'LOST' ? 'red' : 'blue'}`}>
                          {bet.status}
                        </span>
                      </td>
                      <td style={{ color: bet.profit > 0 ? 'var(--secondary)' : bet.profit < 0 ? 'var(--danger)' : undefined, fontWeight: 600 }}>
                        {bet.profit !== null ? `€${bet.profit?.toFixed(2)}` : '-'}
                      </td>
                      <td style={{ fontSize: 12 }}>{new Date(bet.placed_at).toLocaleDateString('it-IT')}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default BudgetManager;
