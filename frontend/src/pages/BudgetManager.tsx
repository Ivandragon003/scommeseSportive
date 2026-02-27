import React, { useEffect, useState } from 'react';
import { getBudget, getBets, settleBet, initBudget } from '../utils/api';

interface BudgetManagerProps {
  activeUser: string;
}

/* Solo stili SPECIFICI di BudgetManager che non esistono nel global */
const localStyles = `
  .bm-wrap { padding: 40px 32px; min-height: 100vh; }

  /* HEADER */
  .bm-header { display: flex; align-items: flex-end; justify-content: space-between; margin-bottom: 40px; }
  .bm-title {
    font-size: clamp(28px,4vw,40px); font-weight: 800; letter-spacing: -1.5px; line-height: 1;
    background: linear-gradient(135deg, #fff 35%, var(--green));
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
  }
  .bm-subtitle { font-size: 12px; color: var(--text-2); margin-top: 7px; font-family: 'DM Mono',monospace; }
  .bm-user-tag {
    background: var(--surface2); border: 1px solid var(--border);
    border-radius: var(--radius-pill); padding: 8px 18px;
    font-size: 12px; color: var(--text-2); font-family: 'DM Mono',monospace;
    transition: border-color var(--transition);
  }
  .bm-user-tag:hover { border-color: var(--border-hover); }
  .bm-user-tag span { color: var(--green); }

  /* FINANCE TABLE — righe leggibili */
  .bm-fin-table { width: 100%; }
  .bm-fin-row {
    display: flex; justify-content: space-between; align-items: center;
    padding: 11px 0; border-bottom: 1px solid var(--border);
    font-size: 14px; transition: background var(--transition);
  }
  .bm-fin-row:last-child { border-bottom: none; }
  .bm-fin-row:hover { background: transparent; }
  .bm-fin-label { color: var(--text-2); }
  .bm-fin-val   { font-family: 'DM Mono',monospace; font-weight: 600; }
  .bm-fin-row.highlight .bm-fin-label,
  .bm-fin-row.highlight .bm-fin-val { font-weight: 700; font-size: 15px; color: var(--text); }

  /* RESET PANEL */
  .bm-reset-panel {
    background: var(--red-dim); border: 1px solid var(--red-border);
    border-radius: var(--radius-sm); padding: 16px; margin-bottom: 16px;
    animation: slideDown .2s ease;
  }
  @keyframes slideDown { from{opacity:0;transform:translateY(-8px)} to{opacity:1;transform:translateY(0)} }
  .bm-reset-row { display: flex; gap: 12px; align-items: flex-end; }
  .bm-reset-input {
    flex: 1; background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius-xs); padding: 10px 14px;
    color: var(--text); font-family: 'DM Mono',monospace; font-size: 14px;
    outline: none; transition: border-color var(--transition);
  }
  .bm-reset-input:focus { border-color: var(--red); }

  /* PENDING SECTION PILL */
  .bm-live-pill {
    display: inline-flex; align-items: center; gap: 8px;
    background: var(--gold-dim); border: 1px solid var(--gold-border);
    border-radius: var(--radius-pill); padding: 4px 14px 4px 8px;
  }
  .bm-live-dot { width: 8px; height: 8px; border-radius: 50%; background: var(--gold); animation: fp-pulse 1.5s infinite; }
  @keyframes fp-pulse { 0%,100%{opacity:1} 50%{opacity:.3} }
  .bm-live-text { font-size: 10px; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase; color: var(--gold); }

  /* SETTLE BUTTONS */
  .bm-settle { display: flex; gap: 8px; }

  /* BET TABLE CELLS */
  .bm-market  { font-weight: 700; font-size: 13px; margin-bottom: 2px; }
  .bm-sel     { font-size: 11px; color: var(--text-2); }

  /* FILTER TABS */
  .bm-ftabs { display: flex; gap: 6px; }
  .bm-ftab {
    font-family: 'Syne',sans-serif; font-size: 11px; font-weight: 700;
    letter-spacing: .8px; text-transform: uppercase;
    padding: 6px 14px; border-radius: 7px; border: 1px solid var(--border);
    background: transparent; color: var(--text-2); cursor: pointer; transition: all var(--transition);
  }
  .bm-ftab:hover   { color: var(--text); border-color: var(--border-hover); background: var(--surface3); }
  .bm-ftab.active  { background: var(--green-dim); border-color: var(--green-border); color: var(--green); }

  /* INIT CARD */
  .bm-init-wrap {
    max-width: 480px; margin: 80px auto;
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius-2xl); padding: 52px 44px; text-align: center;
    box-shadow: var(--shadow-hover);
  }
  .bm-init-icon  { font-size: 58px; margin-bottom: 20px; }
  .bm-init-title { font-size: 28px; font-weight: 800; margin-bottom: 8px; }
  .bm-init-sub   { color: var(--text-2); font-size: 14px; margin-bottom: 32px; line-height: 1.5; }
  .bm-init-row   { display: flex; align-items: center; gap: 12px; margin-bottom: 26px; }
  .bm-init-eur   { font-size: 30px; font-weight: 800; color: var(--green); flex-shrink: 0; }
  .bm-init-input {
    flex: 1; background: var(--surface2); border: 1px solid var(--border);
    border-radius: var(--radius-sm); padding: 15px 18px;
    color: var(--text); font-family: 'DM Mono',monospace;
    font-size: 28px; font-weight: 500; outline: none; text-align: center;
    transition: border-color var(--transition), box-shadow var(--transition);
  }
  .bm-init-input:focus { border-color: var(--green); box-shadow: 0 0 0 3px var(--green-dim); }

  /* WIN/LOSS summary boxes */
  .bm-wl-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 28px; }
  .bm-wl-box  { border-radius: var(--radius-sm); padding: 18px; text-align: center; }
  .bm-wl-box.wins  { background: var(--green-dim); border: 1px solid var(--green-border); }
  .bm-wl-box.losses{ background: var(--red-dim);   border: 1px solid var(--red-border); }
  .bm-wl-num  { font-size: 30px; font-weight: 800; font-family: 'DM Mono',monospace; }
  .bm-wl-num.wins   { color: var(--green); }
  .bm-wl-num.losses { color: var(--red);   }
  .bm-wl-lbl  { font-size: 10px; text-transform: uppercase; letter-spacing: 1.2px; font-weight: 700; margin-top: 4px; opacity: .75; }

  /* LOADING */
  .bm-loading {
    display: flex; align-items: center; justify-content: center;
    height: 340px; flex-direction: column; gap: 18px;
  }
  .bm-spinner { width: 40px; height: 40px; border: 3px solid var(--border); border-top-color: var(--green); border-radius: 50%; animation: fp-spin .7s linear infinite; }
  @keyframes fp-spin { to { transform: rotate(360deg); } }

  @media (max-width: 900px) {
    .bm-wrap { padding: 24px 18px; }
    .bm-header { flex-direction: column; align-items: flex-start; gap: 12px; }
  }
  @media (max-width: 600px) {
    .bm-wrap { padding: 16px; }
    .bm-title { font-size: 26px; }
  }
`;

const BudgetManager: React.FC<BudgetManagerProps> = ({ activeUser }) => {
  const [budget, setBudget] = useState<any>(null);
  const [bets, setBets] = useState<any[]>([]);
  const [filter, setFilter] = useState<string>('');
  const [loading, setLoading] = useState(true);
  const [settlingId, setSettlingId] = useState<string | null>(null);
  const [initAmount, setInitAmount] = useState('1000');
  const [showReset, setShowReset] = useState(false);

  useEffect(() => { loadAll(); }, [activeUser, filter]);

  const loadAll = async () => {
    setLoading(true);
    try {
      const [budgetRes, betsRes] = await Promise.all([
        getBudget(activeUser),
        getBets(activeUser, filter || undefined),
      ]);
      setBudget(budgetRes.data);
      setBets(betsRes.data ?? []);
    } catch { setBudget(null); }
    setLoading(false);
  };

  const handleSettle = async (betId: string, won: boolean) => {
    setSettlingId(betId);
    try { await settleBet(betId, won); await loadAll(); }
    catch (e: any) { alert('Errore: ' + e.message); }
    setSettlingId(null);
  };

  const handleReset = async () => {
    const amount = parseFloat(initAmount);
    if (isNaN(amount) || amount <= 0) return;
    await initBudget(activeUser, amount);
    await loadAll();
    setShowReset(false);
  };

  const pendingBets  = bets.filter(b => b.status === 'PENDING');
  const netProfit    = (budget?.total_won ?? 0) - (budget?.total_lost ?? 0);
  const usedPct      = budget ? Math.min(100, ((budget.total_budget - budget.available_budget) / budget.total_budget) * 100) : 0;
  const winsCount    = budget?.total_bets ? Math.round((budget.win_rate / 100) * budget.total_bets) : 0;
  const lossesCount  = budget?.total_bets ? budget.total_bets - winsCount : 0;

  return (
    <>
      <style>{localStyles}</style>
      <div className="bm-wrap">

        {/* HEADER */}
        <div className="bm-header">
          <div>
            <div className="bm-title">Budget & Scommesse</div>
            <div className="bm-subtitle">Gestione bankroll e registro scommesse</div>
          </div>
          <div className="bm-user-tag">👤 <span>{activeUser}</span></div>
        </div>

        {loading ? (
          <div className="bm-loading">
            <div className="bm-spinner" />
            <div style={{ color: 'var(--text-2)', fontSize: 13 }}>Caricamento dati…</div>
          </div>
        ) : !budget ? (

          /* ── INIT ── */
          <div className="bm-init-wrap">
            <div className="bm-init-icon">💼</div>
            <div className="bm-init-title">Crea il tuo Bankroll</div>
            <div className="bm-init-sub">Imposta il budget iniziale per iniziare a tracciare le scommesse</div>
            <div className="bm-init-row">
              <div className="bm-init-eur">€</div>
              <input className="bm-init-input" type="number" value={initAmount}
                onChange={e => setInitAmount(e.target.value)} placeholder="1000" />
            </div>
            <button className="fp-btn fp-btn-solid" style={{ width: '100%', justifyContent: 'center' }} onClick={handleReset}>
              Crea Budget →
            </button>
          </div>

        ) : (
          <>
            {/* ── STAT GRID ── */}
            <div className="fp-grid-4" style={{ marginBottom: 24 }}>
              {[
                { icon: '💰', val: `€${budget.available_budget?.toFixed(2)}`, label: 'Budget Disponibile', c: 'green' },
                { icon: netProfit >= 0 ? '📈' : '📉', val: `${netProfit >= 0 ? '+' : ''}€${netProfit.toFixed(2)}`, label: 'Profitto Netto', c: netProfit >= 0 ? 'green' : 'red' },
                { icon: '🎯', val: `${budget.win_rate?.toFixed(1)}%`, label: 'Win Rate', c: 'gold' },
                { icon: '⏳', val: pendingBets.length, label: 'In Attesa', c: 'blue' },
              ].map(({ icon, val, label, c }) => (
                <div key={label} className={`fp-stat c-${c}`}>
                  <span className="fp-stat-icon">{icon}</span>
                  <div className={`fp-stat-val c-${c}`}>{val}</div>
                  <div className="fp-stat-label">{label}</div>
                </div>
              ))}
            </div>

            {/* ── TWO COL ── */}
            <div className="fp-grid-2" style={{ marginBottom: 24 }}>

              {/* Dettaglio finanziario */}
              <div className="fp-card">
                <div className="fp-card-head">
                  <div className="fp-card-title">📊 Dettaglio Finanziario</div>
                  <button className="fp-btn fp-btn-ghost fp-btn-sm" onClick={() => setShowReset(!showReset)}>
                    ⚙️ Reset
                  </button>
                </div>
                <div className="fp-card-body">
                  {showReset && (
                    <div className="bm-reset-panel">
                      <div className="bm-reset-row">
                        <input className="bm-reset-input" type="number" value={initAmount}
                          onChange={e => setInitAmount(e.target.value)} placeholder="Nuovo importo €" />
                        <button className="fp-btn fp-btn-red" onClick={handleReset}>Conferma Reset</button>
                      </div>
                      <div className="fp-alert fp-alert-warning" style={{ marginTop: 12 }}>
                        ⚠️ Il reset azzera tutte le statistiche per questo utente.
                      </div>
                    </div>
                  )}
                  <div className="bm-fin-table">
                    {[
                      { label: 'Budget Iniziale',  val: `€${budget.total_budget?.toFixed(2)}`,       style: undefined },
                      { label: 'Disponibile',       val: `€${budget.available_budget?.toFixed(2)}`,   style: { color: 'var(--green)', fontWeight: 700 } },
                      { label: 'Totale Puntato',    val: `€${budget.total_staked?.toFixed(2)}`,       style: undefined },
                      { label: 'Totale Vinto',      val: `€${budget.total_won?.toFixed(2)}`,          style: { color: 'var(--green)' } },
                      { label: 'Totale Perso',      val: `€${budget.total_lost?.toFixed(2)}`,         style: { color: 'var(--red)' } },
                      { label: 'Profitto Netto',    val: `${netProfit >= 0 ? '+' : ''}€${netProfit.toFixed(2)}`, style: { color: netProfit >= 0 ? 'var(--green)' : 'var(--red)' }, highlight: true },
                      { label: 'Scommesse Totali',  val: budget.total_bets,                           style: undefined },
                      { label: 'Win Rate',          val: `${budget.win_rate?.toFixed(2)}%`,           style: undefined },
                      { label: 'ROI',               val: `${budget.roi >= 0 ? '+' : ''}${budget.roi?.toFixed(2)}%`, style: { color: budget.roi >= 0 ? 'var(--green)' : 'var(--red)' }, highlight: true },
                    ].map(({ label, val, style, highlight }) => (
                      <div key={label} className={`bm-fin-row${highlight ? ' highlight' : ''}`}>
                        <span className="bm-fin-label">{label}</span>
                        <span className="bm-fin-val" style={style}>{String(val)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Performance */}
              <div className="fp-card">
                <div className="fp-card-head"><div className="fp-card-title">💹 Performance</div></div>
                <div className="fp-card-body">
                  {[
                    { label: 'Budget utilizzato', val: usedPct, display: `${usedPct.toFixed(1)}%`, bg: 'linear-gradient(90deg,var(--blue),#7b5ea7)' },
                    { label: 'Win Rate', val: Math.min(100, budget.win_rate ?? 0), display: `${budget.win_rate?.toFixed(1)}%`,
                      bg: budget.win_rate >= 50 ? 'linear-gradient(90deg,var(--green),#00b880)' : 'linear-gradient(90deg,var(--gold),#e09000)' },
                    { label: 'ROI positivo', val: Math.min(100, Math.max(0, budget.roi ?? 0)), display: `${budget.roi?.toFixed(1)}%`,
                      bg: budget.roi >= 0 ? 'linear-gradient(90deg,var(--green),#00b880)' : 'linear-gradient(90deg,var(--red),#c9003e)' },
                  ].map(({ label, val, display, bg }) => (
                    <div className="fp-progress-wrap" key={label}>
                      <div className="fp-progress-meta">
                        <span>{label}</span>
                        <span className="fp-progress-val">{display}</span>
                      </div>
                      <div className="fp-progress-track">
                        <div className="fp-progress-fill" style={{ width: `${val}%`, background: bg }} />
                      </div>
                    </div>
                  ))}

                  <div className="bm-wl-grid">
                    <div className="bm-wl-box wins">
                      <div className="bm-wl-num wins">{winsCount}</div>
                      <div className="bm-wl-lbl" style={{ color: 'var(--green)' }}>Vinte</div>
                    </div>
                    <div className="bm-wl-box losses">
                      <div className="bm-wl-num losses">{lossesCount}</div>
                      <div className="bm-wl-lbl" style={{ color: 'var(--red)' }}>Perse</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* ── PENDING BETS ── */}
            {pendingBets.length > 0 && (
              <div className="fp-card" style={{ marginBottom: 24 }}>
                <div className="fp-card-head">
                  <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                    <div className="bm-live-pill">
                      <div className="bm-live-dot" />
                      <span className="bm-live-text">Live</span>
                    </div>
                    <div className="fp-card-title">Scommesse in Attesa ({pendingBets.length})</div>
                  </div>
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table className="fp-table">
                    <thead>
                      <tr>
                        <th>Mercato / Selezione</th>
                        <th>Quota</th>
                        <th>Puntata</th>
                        <th>P. Nostra</th>
                        <th>EV</th>
                        <th>Data</th>
                        <th>Esito</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pendingBets.map((bet: any) => (
                        <tr key={bet.bet_id}>
                          <td>
                            <div className="bm-market">{bet.market_name}</div>
                            <div className="bm-sel">{bet.selection}</div>
                          </td>
                          <td className="fp-mono">{bet.odds?.toFixed(2)}</td>
                          <td className="fp-mono">€{bet.stake?.toFixed(2)}</td>
                          <td className="fp-mono">{(bet.our_probability * 100)?.toFixed(2)}%</td>
                          <td className="fp-mono" style={{ color: 'var(--green)', fontWeight: 600 }}>
                            +{(bet.expected_value * 100)?.toFixed(2)}%
                          </td>
                          <td style={{ color: 'var(--text-2)', fontSize: 12 }}>
                            {new Date(bet.placed_at).toLocaleDateString('it-IT')}
                          </td>
                          <td>
                            <div className="bm-settle">
                              <button className="fp-btn fp-btn-green fp-btn-sm"
                                disabled={settlingId === bet.bet_id}
                                onClick={() => handleSettle(bet.bet_id, true)}>
                                ✓ Vinta
                              </button>
                              <button className="fp-btn fp-btn-red fp-btn-sm"
                                disabled={settlingId === bet.bet_id}
                                onClick={() => handleSettle(bet.bet_id, false)}>
                                ✕ Persa
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {/* ── STORICO ── */}
            <div className="fp-card">
              <div className="fp-card-head">
                <div className="fp-card-title">📋 Storico Scommesse</div>
                <div className="bm-ftabs">
                  {[
                    { val: '', label: 'Tutte' },
                    { val: 'PENDING', label: 'Attesa' },
                    { val: 'WON',     label: 'Vinte'  },
                    { val: 'LOST',    label: 'Perse'  },
                  ].map(({ val, label }) => (
                    <button key={val} className={`bm-ftab${filter === val ? ' active' : ''}`}
                      onClick={() => setFilter(val)}>{label}</button>
                  ))}
                </div>
              </div>
              {bets.length === 0 ? (
                <div className="fp-empty">
                  <div className="fp-empty-icon">📭</div>
                  <div className="fp-empty-text">Nessuna scommessa registrata.</div>
                </div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table className="fp-table">
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
                            <div className="bm-market">{bet.market_name}</div>
                            <div className="bm-sel">{bet.selection}</div>
                          </td>
                          <td className="fp-mono">{bet.odds?.toFixed(2)}</td>
                          <td className="fp-mono">€{bet.stake?.toFixed(2)}</td>
                          <td>
                            <span className={`fp-badge ${bet.status === 'WON' ? 'fp-badge-green' : bet.status === 'LOST' ? 'fp-badge-red' : 'fp-badge-blue'}`}>
                              {bet.status === 'WON' ? '✓ VINTA' : bet.status === 'LOST' ? '✕ PERSA' : '⏳ ATTESA'}
                            </span>
                          </td>
                          <td className="fp-mono" style={{
                            color: bet.profit > 0 ? 'var(--green)' : bet.profit < 0 ? 'var(--red)' : 'var(--text-2)',
                            fontWeight: 600,
                          }}>
                            {bet.profit !== null ? `${bet.profit > 0 ? '+' : ''}€${bet.profit?.toFixed(2)}` : '—'}
                          </td>
                          <td style={{ color: 'var(--text-2)', fontSize: 12 }}>
                            {new Date(bet.placed_at).toLocaleDateString('it-IT')}
                          </td>
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