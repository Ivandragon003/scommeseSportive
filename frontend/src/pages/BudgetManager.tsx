import React, { useEffect, useMemo, useState } from 'react';
import { getBudget, getBets, initBudget } from '../utils/api';

interface BudgetManagerProps {
  activeUser: string;
}

const localStyles = `
  .bm-wrap { padding: 36px 28px; min-height: 100vh; }
  .bm-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 12px; margin-bottom: 24px; }
  .bm-title { font-size: clamp(28px, 4vw, 40px); font-weight: 800; letter-spacing: -1px; }
  .bm-sub { font-size: 12px; color: var(--text-2); font-family: 'DM Mono', monospace; margin-top: 6px; }
  .bm-user { border: 1px solid var(--border); border-radius: 999px; padding: 7px 14px; color: var(--text-2); font-family: 'DM Mono', monospace; font-size: 12px; }
  .bm-user strong { color: var(--green); }

  .bm-init { max-width: 520px; margin: 70px auto; }
  .bm-init-row { display: flex; gap: 10px; align-items: center; }

  .bm-fin-grid { display: grid; gap: 10px; }
  .bm-fin-row { display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--border); padding: 8px 0; }
  .bm-fin-row:last-child { border-bottom: none; }
  .bm-fin-k { color: var(--text-2); }
  .bm-fin-v { font-family: 'DM Mono', monospace; font-weight: 600; }

  .bm-status { font-size: 10px; font-weight: 700; border-radius: 999px; padding: 3px 10px; border: 1px solid var(--border); }
  .bm-status.pending { color: var(--blue); background: var(--blue-dim); border-color: var(--blue-border); }
  .bm-status.won { color: var(--green); background: var(--green-dim); border-color: var(--green-border); }
  .bm-status.lost { color: var(--red); background: var(--red-dim); border-color: var(--red-border); }
  .bm-status.void { color: var(--gold); background: var(--gold-dim); border-color: var(--gold-border); }

  .bm-match { font-weight: 700; font-size: 13px; }
  .bm-market { font-size: 12px; color: var(--text-2); margin-top: 2px; }

  .bm-ftabs { display: flex; gap: 6px; }
  .bm-ftab {
    font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: .6px;
    border: 1px solid var(--border); background: transparent; color: var(--text-2);
    border-radius: 8px; padding: 6px 12px; cursor: pointer;
  }
  .bm-ftab.active { color: var(--green); border-color: var(--green-border); background: var(--green-dim); }

  @media (max-width: 900px) {
    .bm-wrap { padding: 22px 16px; }
    .bm-head { flex-direction: column; align-items: flex-start; }
  }
`;

const toAmount = (v: any) => Number(v ?? 0);
const formatDateTime = (value: any) => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? '-' : d.toLocaleString('it-IT');
};

const BudgetManager: React.FC<BudgetManagerProps> = ({ activeUser }) => {
  const [budget, setBudget] = useState<any>(null);
  const [bets, setBets] = useState<any[]>([]);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [initAmount, setInitAmount] = useState('1000');
  const [showReset, setShowReset] = useState(false);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [budgetRes, betsRes] = await Promise.all([
        getBudget(activeUser),
        getBets(activeUser, filter || undefined),
      ]);
      setBudget(budgetRes.data ?? null);
      setBets(betsRes.data ?? []);
    } catch {
      setBudget(null);
      setBets([]);
    }
    setLoading(false);
  };

  useEffect(() => {
    loadAll();
  }, [activeUser, filter]);

  const handleReset = async () => {
    const amount = Number(initAmount);
    if (!Number.isFinite(amount) || amount <= 0) return;
    try {
      await initBudget(activeUser, amount);
      await loadAll();
      setShowReset(false);
    } catch (e: any) {
      alert(`Errore reset budget: ${e.message}`);
    }
  };

  const handleQuickReset = async () => {
    const amount = Number(initAmount);
    if (!Number.isFinite(amount) || amount <= 0) {
      alert('Inserisci un importo valido per il reset.');
      return;
    }
    const confirmed = window.confirm(
      `Confermi il reset completo di budget e scommesse per l'utente ${activeUser}?`
    );
    if (!confirmed) return;
    await handleReset();
  };

  const pendingBets = useMemo(() => bets.filter((b) => String(b.status) === 'PENDING'), [bets]);

  const settledBets = useMemo(
    () => bets.filter((b) => ['WON', 'LOST', 'VOID'].includes(String(b.status))),
    [bets]
  );

  const netProfit = useMemo(
    () => settledBets.reduce((s, b) => s + Number(b.profit ?? 0), 0),
    [settledBets]
  );

  const winsCount = settledBets.filter((b) => String(b.status) === 'WON').length;
  const lossesCount = settledBets.filter((b) => String(b.status) === 'LOST').length;
  const voidCount = settledBets.filter((b) => String(b.status) === 'VOID').length;

  const usedPct = budget
    ? Math.min(100, ((toAmount(budget.total_budget) - toAmount(budget.available_budget)) / Math.max(1, toAmount(budget.total_budget))) * 100)
    : 0;

  const statusLabel = (s: string) => {
    if (s === 'WON') return 'VINTA';
    if (s === 'LOST') return 'PERSA';
    if (s === 'VOID') return 'VOID';
    return 'ATTESA';
  };

  const statusClass = (s: string) => {
    if (s === 'WON') return 'won';
    if (s === 'LOST') return 'lost';
    if (s === 'VOID') return 'void';
    return 'pending';
  };

  return (
    <>
      <style>{localStyles}</style>
      <div className="bm-wrap">
        <div className="bm-head">
          <div>
            <div className="bm-title">Budget e Scommesse</div>
            <div className="bm-sub">Esito automatico su partite concluse e storico completo</div>
          </div>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            {!loading && budget && (
              <button
                className="fp-btn fp-btn-red fp-btn-sm"
                onClick={handleQuickReset}
                title="Azzera budget e cancella tutte le scommesse dell'utente corrente"
              >
                Reset Budget + Scommesse
              </button>
            )}
            <div className="bm-user">Utente: <strong>{activeUser}</strong></div>
          </div>
        </div>

        {loading ? (
          <div className="fp-spinner-wrap" style={{ minHeight: 280 }}><div className="fp-spinner" /></div>
        ) : !budget ? (
          <div className="fp-card bm-init">
            <div className="fp-card-head"><div className="fp-card-title">Crea bankroll iniziale</div></div>
            <div className="fp-card-body">
              <div className="bm-init-row" style={{ marginBottom: 12 }}>
                <input
                  className="fp-input"
                  type="number"
                  value={initAmount}
                  onChange={(e) => setInitAmount(e.target.value)}
                  placeholder="1000"
                />
                <button className="fp-btn fp-btn-solid" onClick={handleReset}>Inizializza</button>
              </div>
              <div className="fp-alert fp-alert-info">
                Imposta il budget iniziale per iniziare a registrare le scommesse.
              </div>
            </div>
          </div>
        ) : (
          <>
            <div className="fp-grid-4" style={{ marginBottom: 18 }}>
              <div className="fp-stat c-green">
                <div className="fp-stat-val c-green">EUR {toAmount(budget.available_budget).toFixed(2)}</div>
                <div className="fp-stat-label">Disponibile</div>
              </div>
              <div className={`fp-stat ${netProfit >= 0 ? 'c-green' : 'c-red'}`}>
                <div className={`fp-stat-val ${netProfit >= 0 ? 'c-green' : 'c-red'}`}>{netProfit >= 0 ? '+' : ''}EUR {netProfit.toFixed(2)}</div>
                <div className="fp-stat-label">Profitto Netto</div>
              </div>
              <div className="fp-stat c-gold">
                <div className="fp-stat-val c-gold">{Number(budget.win_rate ?? 0).toFixed(1)}%</div>
                <div className="fp-stat-label">Win Rate</div>
              </div>
              <div className="fp-stat c-blue">
                <div className="fp-stat-val c-blue">{pendingBets.length}</div>
                <div className="fp-stat-label">In Attesa</div>
              </div>
            </div>

            <div className="fp-grid-2" style={{ marginBottom: 18 }}>
              <div className="fp-card">
                <div className="fp-card-head">
                  <div className="fp-card-title">Dettaglio Finanziario</div>
                  <button className="fp-btn fp-btn-ghost fp-btn-sm" onClick={() => setShowReset((v) => !v)}>Reset</button>
                </div>
                <div className="fp-card-body">
                  {showReset && (
                    <div style={{ marginBottom: 12 }}>
                      <div className="bm-init-row">
                        <input className="fp-input" type="number" value={initAmount} onChange={(e) => setInitAmount(e.target.value)} />
                        <button className="fp-btn fp-btn-red" onClick={handleReset}>Conferma</button>
                      </div>
                      <div className="fp-alert fp-alert-warning" style={{ marginTop: 10 }}>
                        Il reset azzera metriche e disponibilita e cancella tutte le scommesse dell'utente selezionato.
                      </div>
                    </div>
                  )}
                  <div className="bm-fin-grid">
                    <div className="bm-fin-row"><span className="bm-fin-k">Budget iniziale</span><strong className="bm-fin-v">EUR {toAmount(budget.total_budget).toFixed(2)}</strong></div>
                    <div className="bm-fin-row"><span className="bm-fin-k">Disponibile</span><strong className="bm-fin-v" style={{ color: 'var(--green)' }}>EUR {toAmount(budget.available_budget).toFixed(2)}</strong></div>
                    <div className="bm-fin-row"><span className="bm-fin-k">Totale puntato</span><strong className="bm-fin-v">EUR {toAmount(budget.total_staked).toFixed(2)}</strong></div>
                    <div className="bm-fin-row"><span className="bm-fin-k">Totale ritorni vincenti</span><strong className="bm-fin-v">EUR {toAmount(budget.total_won).toFixed(2)}</strong></div>
                    <div className="bm-fin-row"><span className="bm-fin-k">Totale perso</span><strong className="bm-fin-v">EUR {toAmount(budget.total_lost).toFixed(2)}</strong></div>
                    <div className="bm-fin-row"><span className="bm-fin-k">ROI</span><strong className="bm-fin-v" style={{ color: Number(budget.roi ?? 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>{Number(budget.roi ?? 0).toFixed(2)}%</strong></div>
                  </div>
                </div>
              </div>

              <div className="fp-card">
                <div className="fp-card-head"><div className="fp-card-title">Performance</div></div>
                <div className="fp-card-body">
                  <div className="fp-progress-wrap">
                    <div className="fp-progress-meta"><span>Budget utilizzato</span><span className="fp-progress-val">{usedPct.toFixed(1)}%</span></div>
                    <div className="fp-progress-track"><div className="fp-progress-fill" style={{ width: `${usedPct}%` }} /></div>
                  </div>
                  <div className="fp-progress-wrap">
                    <div className="fp-progress-meta"><span>Win rate</span><span className="fp-progress-val">{Number(budget.win_rate ?? 0).toFixed(1)}%</span></div>
                    <div className="fp-progress-track"><div className="fp-progress-fill" style={{ width: `${Math.min(100, Number(budget.win_rate ?? 0))}%`, background: 'var(--green)' }} /></div>
                  </div>
                  <div className="fp-progress-wrap" style={{ marginBottom: 14 }}>
                    <div className="fp-progress-meta"><span>ROI</span><span className="fp-progress-val">{Number(budget.roi ?? 0).toFixed(1)}%</span></div>
                    <div className="fp-progress-track"><div className="fp-progress-fill" style={{ width: `${Math.min(100, Math.max(0, Number(budget.roi ?? 0)))}%`, background: Number(budget.roi ?? 0) >= 0 ? 'var(--green)' : 'var(--red)' }} /></div>
                  </div>
                  <div style={{ display: 'flex', gap: 8 }}>
                    <span className="fp-badge fp-badge-green">Vinte: {winsCount}</span>
                    <span className="fp-badge fp-badge-red">Perse: {lossesCount}</span>
                    <span className="fp-badge fp-badge-gold">Void: {voidCount}</span>
                  </div>
                </div>
              </div>
            </div>

            <div className="fp-card" style={{ marginBottom: 18 }}>
              <div className="fp-card-head">
                <div className="fp-card-title">Scommesse in attesa ({pendingBets.length})</div>
              </div>
              <div className="fp-card-body" style={{ paddingTop: 10 }}>
                <div className="fp-alert fp-alert-info" style={{ marginBottom: 10 }}>
                  Le scommesse vengono chiuse automaticamente quando la partita e conclusa e i dati necessari sono presenti.
                </div>
                {pendingBets.length === 0 ? (
                  <div className="fp-empty"><div className="fp-empty-text">Nessuna scommessa pendente.</div></div>
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table className="fp-table">
                      <thead>
                        <tr>
                          <th>Partita</th>
                          <th>Mercato</th>
                          <th>Quota</th>
                          <th>Puntata</th>
                          <th>Data</th>
                          <th>Stato</th>
                        </tr>
                      </thead>
                      <tbody>
                        {pendingBets.map((bet: any) => (
                          <tr key={String(bet.bet_id)}>
                            <td>
                              <div className="bm-match">{bet.home_team_name ?? '-' } vs {bet.away_team_name ?? '-'}</div>
                              <div className="bm-market">{bet.competition ?? '-'}</div>
                            </td>
                            <td>
                              <div className="bm-match">{bet.market_name}</div>
                              <div className="bm-market">{bet.selection}</div>
                            </td>
                            <td className="fp-mono">{Number(bet.odds ?? 0).toFixed(2)}</td>
                            <td className="fp-mono">EUR {Number(bet.stake ?? 0).toFixed(2)}</td>
                            <td style={{ fontSize: 12, color: 'var(--text-2)' }}>{formatDateTime(bet.placed_at)}</td>
                            <td><span className={`bm-status ${statusClass(String(bet.status ?? 'PENDING'))}`}>{statusLabel(String(bet.status ?? 'PENDING'))}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>

            <div className="fp-card">
              <div className="fp-card-head">
                <div className="fp-card-title">Storico scommesse</div>
                <div className="bm-ftabs">
                  {[
                    { value: '', label: 'Tutte' },
                    { value: 'PENDING', label: 'Attesa' },
                    { value: 'WON', label: 'Vinte' },
                    { value: 'LOST', label: 'Perse' },
                    { value: 'VOID', label: 'Void' },
                  ].map((f) => (
                    <button key={f.value || 'all'} className={`bm-ftab${filter === f.value ? ' active' : ''}`} onClick={() => setFilter(f.value)}>{f.label}</button>
                  ))}
                </div>
              </div>

              {bets.length === 0 ? (
                <div className="fp-empty"><div className="fp-empty-text">Nessuna scommessa registrata.</div></div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table className="fp-table">
                    <thead>
                      <tr>
                        <th>Partita</th>
                        <th>Mercato</th>
                        <th>Quota</th>
                        <th>Puntata</th>
                        <th>Stato</th>
                        <th>Profitto</th>
                        <th>Data</th>
                      </tr>
                    </thead>
                    <tbody>
                      {bets.slice(0, 80).map((bet: any) => (
                        <tr key={String(bet.bet_id)}>
                          <td>
                            <div className="bm-match">{bet.home_team_name ?? '-'} vs {bet.away_team_name ?? '-'}</div>
                            <div className="bm-market">{bet.competition ?? '-'}</div>
                          </td>
                          <td>
                            <div className="bm-match">{bet.market_name}</div>
                            <div className="bm-market">{bet.selection}</div>
                          </td>
                          <td className="fp-mono">{Number(bet.odds ?? 0).toFixed(2)}</td>
                          <td className="fp-mono">EUR {Number(bet.stake ?? 0).toFixed(2)}</td>
                          <td><span className={`bm-status ${statusClass(String(bet.status ?? 'PENDING'))}`}>{statusLabel(String(bet.status ?? 'PENDING'))}</span></td>
                          <td className="fp-mono" style={{ color: Number(bet.profit ?? 0) > 0 ? 'var(--green)' : Number(bet.profit ?? 0) < 0 ? 'var(--red)' : 'var(--text-2)' }}>
                            {bet.profit !== null && bet.profit !== undefined ? `${Number(bet.profit) > 0 ? '+' : ''}EUR ${Number(bet.profit).toFixed(2)}` : '-'}
                          </td>
                          <td style={{ fontSize: 12, color: 'var(--text-2)' }}>{formatDateTime(bet.placed_at)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </>
  );
};

export default BudgetManager;
