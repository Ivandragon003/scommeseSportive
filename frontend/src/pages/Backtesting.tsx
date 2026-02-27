import React, { useState, useEffect } from 'react';
import { runBacktest, getBacktestResults, getBacktestResult } from '../utils/api';
import {
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer,
  BarChart, Bar, ScatterChart, Scatter, ReferenceLine
} from 'recharts';

const Backtesting: React.FC = () => {
  const [competition, setCompetition] = useState('Serie A');
  const [season, setSeason] = useState('');
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<any[]>([]);
  const [currentResult, setCurrentResult] = useState<any>(null);
  const [activeTab, setActiveTab] = useState('overview');

  useEffect(() => { loadResults(); }, []);

  const loadResults = async () => {
    const res = await getBacktestResults();
    setResults(res.data ?? []);
  };

  const handleRun = async () => {
    setLoading(true);
    try {
      const res = await runBacktest({ competition, season: season || undefined });
      if (res.data) {
        setCurrentResult(res.data);
        await loadResults();
        setActiveTab('overview');
      }
    } catch (e: any) {
      alert('Errore backtest: ' + e.message);
    }
    setLoading(false);
  };

  const loadHistorical = async (id: number) => {
    const res = await getBacktestResult(id);
    if (res.data?.result) setCurrentResult(res.data.result);
  };

  const r = currentResult;

  return (
    <div style={{ padding: '40px 32px', minHeight: '100vh' }}>

      <div style={{ marginBottom: 32 }}>
        <h1 className="fp-page-title fp-gradient-gold">
          Backtesting & Validazione
        </h1>
        <p style={{ fontSize: 12, color: 'var(--text-2)', margin: 0, fontFamily: 'DM Mono, monospace' }}>
          Test del modello su dati storici · Simulazione scommesse
        </p>
      </div>

      <div className="fp-grid-2" style={{ marginBottom: 24 }}>

        {/* RUN FORM */}
        <div className="fp-card">
          <div className="fp-card-head">
            <div className="fp-card-title">▶ Esegui Backtest</div>
          </div>
          <div className="fp-card-body">
            <div className="fp-alert fp-alert-info" style={{ marginBottom: 18 }}>
              ℹ️ Il backtest usa il <strong>70%</strong> dei dati per addestrare il modello e il <strong>30%</strong> per simulare le scommesse.
            </div>
            <div className="fp-grid-2" style={{ marginBottom: 18 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label className="fp-label">Competizione</label>
                <input
                  className="fp-input"
                  value={competition}
                  onChange={e => setCompetition(e.target.value)}
                  placeholder="es. Serie A"
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label className="fp-label">Stagione (opzionale)</label>
                <input
                  className="fp-input"
                  value={season}
                  onChange={e => setSeason(e.target.value)}
                  placeholder="es. 2023-24"
                />
              </div>
            </div>
            <button
              className="fp-btn fp-btn-gold fp-btn-lg"
              onClick={handleRun}
              disabled={loading}
            >
              {loading ? '⏳ Eseguendo backtest...' : '▶ Avvia Backtest'}
            </button>
          </div>
        </div>

        {/* HISTORY */}
        {results.length > 0 && (
          <div className="fp-card">
            <div className="fp-card-head">
              <div className="fp-card-title">🕑 Backtest Precedenti</div>
              <span className="fp-badge fp-badge-gray">{results.length} salvati</span>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="fp-table">
                <thead>
                  <tr>
                    <th>Competizione</th>
                    <th>Stagione</th>
                    <th>Data</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {results.slice(0, 8).map((row: any) => (
                    <tr key={row.id}>
                      <td style={{ fontWeight: 600 }}>{row.competition}</td>
                      <td className="fp-mono" style={{ color: 'var(--text-2)', fontSize: 12 }}>{row.season_range}</td>
                      <td className="fp-mono" style={{ color: 'var(--text-2)', fontSize: 12 }}>
                        {new Date(row.run_at).toLocaleDateString('it-IT')}
                      </td>
                      <td>
                        <button className="fp-btn fp-btn-ghost fp-btn-sm" onClick={() => loadHistorical(row.id)}>
                          Carica
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>

      {r && (
        <>
          {/* KPI ROW 1 */}
          <div className="fp-grid-4" style={{ marginBottom: 16 }}>
            {[
              {
                icon: '📈', label: 'ROI',
                val: `${r.roi >= 0 ? '+' : ''}${r.roi?.toFixed(2)}%`,
                c: r.roi >= 0 ? 'green' : 'red',
                sub: `su ${r.testMatches} partite test`,
              },
              {
                icon: '🎯', label: 'Win Rate',
                val: `${r.winRate?.toFixed(1)}%`,
                c: 'blue',
                sub: `${r.betsWon}/${r.betsPlaced} scommesse`,
              },
              {
                icon: '📊', label: 'Sharpe Ratio',
                val: r.sharpeRatio?.toFixed(2),
                c: r.sharpeRatio > 1 ? 'green' : r.sharpeRatio > 0 ? 'gold' : 'red',
                sub: r.sharpeRatio > 1 ? 'Buono' : r.sharpeRatio > 0 ? 'Accettabile' : 'Negativo',
              },
              {
                icon: '📉', label: 'Max Drawdown',
                val: `${r.maxDrawdown?.toFixed(1)}%`,
                c: r.maxDrawdown < 20 ? 'green' : 'red',
                sub: r.maxDrawdown < 20 ? 'Contenuto' : 'Elevato',
              },
            ].map(({ icon, label, val, c, sub }) => (
              <div key={label} className={`fp-stat c-${c}`}>
                <span className="fp-stat-icon">{icon}</span>
                <div className={`fp-stat-val c-${c}`}>{val}</div>
                <div className="fp-stat-label">{label}</div>
                <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 6, fontFamily: 'DM Mono, monospace' }}>{sub}</div>
              </div>
            ))}
          </div>

          {/* KPI ROW 2 */}
          <div className="fp-grid-4" style={{ marginBottom: 24 }}>
            {[
              { icon: '🔢', label: 'Quota Media', val: r.averageOdds?.toFixed(2), c: 'blue' },
              { icon: '⚡', label: 'EV Medio', val: `${r.averageEV?.toFixed(2)}%`, c: 'purple' },
              {
                icon: '💹', label: 'Profit Factor',
                val: r.profitFactor?.toFixed(2),
                c: r.profitFactor > 1 ? 'green' : 'red',
                sub: r.profitFactor > 1.5 ? 'Eccellente' : r.profitFactor > 1 ? 'Positivo' : 'Negativo',
              },
              {
                icon: '🎲', label: 'Brier Score',
                val: r.brierScoreGoals?.toFixed(4),
                c: r.brierScoreGoals < 0.25 ? 'green' : 'gold',
                sub: r.brierScoreGoals < 0.25 ? 'Buono' : 'Da migliorare',
              },
            ].map(({ icon, label, val, c, sub }: any) => (
              <div key={label} className={`fp-stat c-${c}`}>
                <span className="fp-stat-icon">{icon}</span>
                <div className={`fp-stat-val c-${c}`}>{val}</div>
                <div className="fp-stat-label">{label}</div>
                {sub && <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 6, fontFamily: 'DM Mono, monospace' }}>{sub}</div>}
              </div>
            ))}
          </div>

          {/* TABS */}
          <div className="fp-tabs" style={{ marginBottom: 20 }}>
            {[
              { id: 'overview',     label: '📈 Curva Equity' },
              { id: 'monthly',      label: '📅 Performance Mensile' },
              { id: 'calibration',  label: '🎯 Calibrazione' },
              { id: 'stats',        label: '📊 Statistiche Dettagliate' },
            ].map(tab => (
              <button
                key={tab.id}
                className={`fp-tab${activeTab === tab.id ? ' active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* ── EQUITY CURVE ── */}
          {activeTab === 'overview' && r.equityCurve?.length > 0 && (
            <div className="fp-card">
              <div className="fp-card-head">
                <div className="fp-card-title">📈 Curva Equity (€1000 iniziali)</div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <span className="fp-badge" style={{ background: r.netProfit >= 0 ? 'var(--green-dim)' : 'var(--red-dim)', color: r.netProfit >= 0 ? 'var(--green)' : 'var(--red)', borderColor: r.netProfit >= 0 ? 'var(--green-border)' : 'var(--red-border)' }}>
                    {r.netProfit >= 0 ? '+' : ''}€{r.netProfit?.toFixed(2)} netto
                  </span>
                </div>
              </div>
              <div style={{ padding: '24px 24px 8px' }}>
                <ResponsiveContainer width="100%" height={350}>
                  <LineChart data={r.equityCurve.slice(0, 500)}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                    <XAxis dataKey="matchNumber" tick={{ fill: 'var(--text-3)', fontSize: 11 }} label={{ value: 'Partita #', position: 'insideBottom', offset: -5, fill: 'var(--text-3)', fontSize: 11 }} />
                    <YAxis tick={{ fill: 'var(--text-3)', fontSize: 11 }} tickFormatter={(v) => `€${v}`} />
                    <Tooltip
                      contentStyle={{ background: 'var(--surface2)', border: '1px solid var(--border-hover)', borderRadius: 12, fontSize: 12 }}
                      formatter={(v: any) => [`€${parseFloat(v).toFixed(2)}`, 'Bankroll']}
                    />
                    <Legend wrapperStyle={{ fontSize: 12, color: 'var(--text-2)' }} />
                    <ReferenceLine y={1000} stroke="var(--border-hover)" strokeDasharray="4 4" label={{ value: 'Capitale iniziale', fill: 'var(--text-3)', fontSize: 11 }} />
                    <Line type="monotone" dataKey="bankroll" name="Bankroll" stroke="var(--blue)" strokeWidth={2.5} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="fp-grid-3" style={{ padding: '16px 24px 24px', borderTop: '1px solid var(--border)' }}>
                {[
                  { label: 'Profitto Netto', val: `€${r.netProfit?.toFixed(2)}`, color: r.netProfit >= 0 ? 'var(--green)' : 'var(--red)' },
                  { label: 'Totale Puntato', val: `€${r.totalStaked?.toFixed(2)}`, color: 'var(--text)' },
                  { label: 'Recovery Factor', val: r.recoveryFactor?.toFixed(2), color: 'var(--blue)' },
                ].map(({ label, val, color }) => (
                  <div key={label} style={{ textAlign: 'center' }}>
                    <div style={{ fontWeight: 800, fontSize: 20, color, fontFamily: 'DM Mono, monospace' }}>{val}</div>
                    <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 4, textTransform: 'uppercase', letterSpacing: '1px', fontWeight: 700 }}>{label}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* ── MONTHLY ── */}
          {activeTab === 'monthly' && r.monthlyStats?.length > 0 && (
            <div className="fp-card">
              <div className="fp-card-head"><div className="fp-card-title">📅 ROI Mensile</div></div>
              <div style={{ padding: '24px 24px 8px' }}>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={r.monthlyStats}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                    <XAxis dataKey="month" tick={{ fill: 'var(--text-3)', fontSize: 11 }} />
                    <YAxis tick={{ fill: 'var(--text-3)', fontSize: 11 }} tickFormatter={(v) => `${v}%`} />
                    <Tooltip
                      contentStyle={{ background: 'var(--surface2)', border: '1px solid var(--border-hover)', borderRadius: 12, fontSize: 12 }}
                      formatter={(v: any) => [`${parseFloat(v).toFixed(2)}%`, 'ROI']}
                    />
                    <ReferenceLine y={0} stroke="var(--border-hover)" />
                    <Bar dataKey="roi" name="ROI Mensile" fill="var(--blue)" radius={[6, 6, 0, 0]} opacity={0.9} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table className="fp-table">
                  <thead>
                    <tr><th>Anno</th><th>Mese</th><th>Scommesse</th><th>Puntato</th><th>Rientro</th><th>Profitto</th><th>ROI</th></tr>
                  </thead>
                  <tbody>
                    {r.monthlyStats.map((m: any) => (
                      <tr key={`${m.year}-${m.month}`}>
                        <td className="fp-mono">{m.year}</td>
                        <td>{m.month}</td>
                        <td className="fp-mono">{m.bets}</td>
                        <td className="fp-mono">€{m.staked?.toFixed(2)}</td>
                        <td className="fp-mono">€{m.returned?.toFixed(2)}</td>
                        <td className="fp-mono" style={{ color: m.profit >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 700 }}>
                          {m.profit >= 0 ? '+' : ''}€{m.profit?.toFixed(2)}
                        </td>
                        <td className="fp-mono" style={{ color: m.roi >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 700 }}>
                          {m.roi >= 0 ? '+' : ''}{m.roi?.toFixed(2)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── CALIBRATION ── */}
          {activeTab === 'calibration' && r.calibration?.length > 0 && (
            <div className="fp-card">
              <div className="fp-card-head">
                <div>
                  <div className="fp-card-title">🎯 Calibrazione del Modello</div>
                  <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>Un modello perfettamente calibrato segue la diagonale</div>
                </div>
              </div>
              <div style={{ padding: '24px 24px 8px' }}>
                <ResponsiveContainer width="100%" height={300}>
                  <ScatterChart>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                    <XAxis dataKey="predictedAvg" name="Probabilità Predetta" tick={{ fill: 'var(--text-3)', fontSize: 11 }} tickFormatter={v => `${(v*100).toFixed(0)}%`} />
                    <YAxis dataKey="actualFrequency" name="Frequenza Reale" tick={{ fill: 'var(--text-3)', fontSize: 11 }} tickFormatter={v => `${(v*100).toFixed(0)}%`} />
                    <Tooltip
                      contentStyle={{ background: 'var(--surface2)', border: '1px solid var(--border-hover)', borderRadius: 12, fontSize: 12 }}
                      formatter={(v: any) => [`${(parseFloat(v)*100).toFixed(1)}%`]}
                    />
                    <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 1, y: 1 }]} stroke="var(--blue)" strokeDasharray="4 4" label={{ value: 'Perfetta calibrazione', fill: 'var(--text-3)', fontSize: 10 }} />
                    <Scatter data={r.calibration.filter((b: any) => b.count > 0)} fill="var(--green)" name="Buckets" />
                  </ScatterChart>
                </ResponsiveContainer>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table className="fp-table">
                  <thead>
                    <tr><th>Range Predetto</th><th>Prob. Media</th><th>Freq. Reale</th><th>Campioni</th><th>Errore</th></tr>
                  </thead>
                  <tbody>
                    {r.calibration.filter((b: any) => b.count > 0).map((b: any) => {
                      const err = Math.abs(b.predictedAvg - b.actualFrequency);
                      return (
                        <tr key={b.predictedRange}>
                          <td className="fp-mono">{b.predictedRange}</td>
                          <td className="fp-mono">{(b.predictedAvg * 100).toFixed(1)}%</td>
                          <td className="fp-mono">{(b.actualFrequency * 100).toFixed(1)}%</td>
                          <td className="fp-mono">{b.count}</td>
                          <td>
                            <span className={`fp-badge ${err < 0.05 ? 'fp-badge-green' : err < 0.1 ? 'fp-badge-gold' : 'fp-badge-red'}`}>
                              {(err * 100).toFixed(1)}pp
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* ── STATS ── */}
          {activeTab === 'stats' && (
            <div className="fp-card">
              <div className="fp-card-head"><div className="fp-card-title">📊 Statistiche Complete</div></div>
              <div className="fp-card-body">
                <div className="fp-grid-2">
                  <div style={{ background: 'var(--surface2)', borderRadius: 'var(--radius-sm)', overflow: 'hidden', border: '1px solid var(--border)' }}>
                    <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1.2px', color: 'var(--blue)' }}>
                      📂 Dati Dataset
                    </div>
                    <table className="fp-table">
                      <tbody>
                        {[
                          ['Partite totali', r.totalMatches],
                          ['Partite training', `${r.trainingMatches} (70%)`],
                          ['Partite test', `${r.testMatches} (30%)`],
                          ['Scommesse piazzate', r.betsPlaced],
                          ['Scommesse vinte', r.betsWon],
                          ['Win Rate', `${r.winRate?.toFixed(2)}%`],
                        ].map(([k, v]) => (
                          <tr key={String(k)}>
                            <td style={{ color: 'var(--text-2)' }}>{k}</td>
                            <td className="fp-mono" style={{ textAlign: 'right', fontWeight: 600 }}>{String(v)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div style={{ background: 'var(--surface2)', borderRadius: 'var(--radius-sm)', overflow: 'hidden', border: '1px solid var(--border)' }}>
                    <div style={{ padding: '12px 18px', borderBottom: '1px solid var(--border)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: '1.2px', color: 'var(--gold)' }}>
                      🤖 Metriche Qualità
                    </div>
                    <table className="fp-table">
                      <tbody>
                        {[
                          ['Brier Score', r.brierScoreGoals?.toFixed(4)],
                          ['Log Loss', r.logLoss?.toFixed(4)],
                          ['Sharpe Ratio (ann.)', r.sharpeRatio?.toFixed(3)],
                          ['Max Drawdown', `${r.maxDrawdown?.toFixed(2)}%`],
                          ['Recovery Factor', r.recoveryFactor?.toFixed(2)],
                          ['Profit Factor', r.profitFactor?.toFixed(2)],
                        ].map(([k, v]) => (
                          <tr key={String(k)}>
                            <td style={{ color: 'var(--text-2)' }}>{k}</td>
                            <td className="fp-mono" style={{ textAlign: 'right', fontWeight: 600 }}>{String(v)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default Backtesting;