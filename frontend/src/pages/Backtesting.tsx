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

  useEffect(() => {
    loadResults();
  }, []);

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
    <div>
      <h1 className="page-title">📈 Backtesting & Validazione</h1>
      <p className="page-subtitle">Test del modello su dati storici con simulazione delle scommesse</p>

      <div className="grid-2">
        <div className="card">
          <div className="card-header"><h2 className="card-title">Esegui Backtest</h2></div>
          <div className="alert alert-info" style={{ marginBottom: 14 }}>
            ℹ️ Il backtest usa il 70% dei dati per addestrare il modello e il 30% per simulare le scommesse.
          </div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Competizione</label>
              <input className="form-input" value={competition} onChange={e => setCompetition(e.target.value)} placeholder="es. Serie A" />
            </div>
            <div className="form-group">
              <label className="form-label">Stagione (opzionale)</label>
              <input className="form-input" value={season} onChange={e => setSeason(e.target.value)} placeholder="es. 2023-24" />
            </div>
          </div>
          <button className="btn btn-primary" onClick={handleRun} disabled={loading}>
            {loading ? '⏳ Eseguendo backtest...' : '▶️ Avvia Backtest'}
          </button>
        </div>

        {results.length > 0 && (
          <div className="card">
            <div className="card-header"><h2 className="card-title">Backtest Precedenti</h2></div>
            <table>
              <thead><tr><th>Competizione</th><th>Stagione</th><th>Data</th><th></th></tr></thead>
              <tbody>
                {results.slice(0, 8).map((r: any) => (
                  <tr key={r.id}>
                    <td>{r.competition}</td>
                    <td>{r.season_range}</td>
                    <td>{new Date(r.run_at).toLocaleDateString('it-IT')}</td>
                    <td><button className="btn btn-secondary btn-sm" onClick={() => loadHistorical(r.id)}>Carica</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {r && (
        <>
          {/* Key metrics */}
          <div className="grid-4" style={{ marginBottom: 20 }}>
            <div className="stat-box">
              <div className="stat-value" style={{ color: r.roi >= 0 ? 'var(--secondary)' : 'var(--danger)' }}>
                {r.roi >= 0 ? '+' : ''}{r.roi?.toFixed(2)}%
              </div>
              <div className="stat-label">ROI</div>
              <div className={`stat-delta ${r.roi >= 0 ? 'pos' : 'neg'}`}>su {r.testMatches} partite test</div>
            </div>
            <div className="stat-box">
              <div className="stat-value">{r.winRate?.toFixed(1)}%</div>
              <div className="stat-label">Win Rate</div>
              <div className="stat-delta">{r.betsWon}/{r.betsPlaced} scommesse</div>
            </div>
            <div className="stat-box">
              <div className="stat-value">{r.sharpeRatio?.toFixed(2)}</div>
              <div className="stat-label">Sharpe Ratio</div>
              <div className={`stat-delta ${r.sharpeRatio > 1 ? 'pos' : 'neg'}`}>{r.sharpeRatio > 1 ? 'Buono' : r.sharpeRatio > 0 ? 'Accettabile' : 'Negativo'}</div>
            </div>
            <div className="stat-box">
              <div className="stat-value">{r.maxDrawdown?.toFixed(1)}%</div>
              <div className="stat-label">Max Drawdown</div>
              <div className={`stat-delta ${r.maxDrawdown < 20 ? 'pos' : 'neg'}`}>{r.maxDrawdown < 20 ? 'Contenuto' : 'Elevato'}</div>
            </div>
          </div>

          <div className="grid-4" style={{ marginBottom: 20 }}>
            <div className="stat-box">
              <div className="stat-value">{r.averageOdds?.toFixed(2)}</div>
              <div className="stat-label">Quota Media</div>
            </div>
            <div className="stat-box">
              <div className="stat-value">{r.averageEV?.toFixed(2)}%</div>
              <div className="stat-label">EV Medio</div>
            </div>
            <div className="stat-box">
              <div className="stat-value">{r.profitFactor?.toFixed(2)}</div>
              <div className="stat-label">Profit Factor</div>
              <div className={`stat-delta ${r.profitFactor > 1 ? 'pos' : 'neg'}`}>{r.profitFactor > 1.5 ? 'Eccellente' : r.profitFactor > 1 ? 'Positivo' : 'Negativo'}</div>
            </div>
            <div className="stat-box">
              <div className="stat-value">{r.brierScoreGoals?.toFixed(4)}</div>
              <div className="stat-label">Brier Score</div>
              <div className={`stat-delta ${r.brierScoreGoals < 0.25 ? 'pos' : 'neg'}`}>{r.brierScoreGoals < 0.25 ? 'Buono' : 'Da migliorare'}</div>
            </div>
          </div>

          <div className="tabs">
            {[
              { id: 'overview', label: 'Curva Equity' },
              { id: 'monthly', label: 'Performance Mensile' },
              { id: 'calibration', label: 'Calibrazione' },
              { id: 'stats', label: 'Statistiche Dettagliate' },
            ].map(tab => (
              <button key={tab.id} className={`tab ${activeTab === tab.id ? 'active' : ''}`} onClick={() => setActiveTab(tab.id)}>
                {tab.label}
              </button>
            ))}
          </div>

          {activeTab === 'overview' && r.equityCurve?.length > 0 && (
            <div className="card">
              <div className="card-header"><h2 className="card-title">📈 Curva Equity (€1000 iniziali)</h2></div>
              <ResponsiveContainer width="100%" height={350}>
                <LineChart data={r.equityCurve.slice(0, 500)}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="matchNumber" label={{ value: 'Partita #', position: 'insideBottom', offset: -5 }} />
                  <YAxis tickFormatter={(v) => `€${v}`} />
                  <Tooltip formatter={(v: any) => `€${parseFloat(v).toFixed(2)}`} />
                  <Legend />
                  <ReferenceLine y={1000} stroke="#999" strokeDasharray="4 4" label="Capitale iniziale" />
                  <Line
                    type="monotone"
                    dataKey="bankroll"
                    name="Bankroll"
                    stroke="#1a73e8"
                    strokeWidth={2}
                    dot={false}
                  />
                </LineChart>
              </ResponsiveContainer>
              <div className="grid-3" style={{ marginTop: 16 }}>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontWeight: 700, fontSize: 18, color: r.netProfit >= 0 ? 'var(--secondary)' : 'var(--danger)' }}>
                    €{r.netProfit?.toFixed(2)}
                  </div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Profitto Netto</div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontWeight: 700, fontSize: 18 }}>€{r.totalStaked?.toFixed(2)}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Totale Puntato</div>
                </div>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontWeight: 700, fontSize: 18 }}>{r.recoveryFactor?.toFixed(2)}</div>
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Recovery Factor</div>
                </div>
              </div>
            </div>
          )}

          {activeTab === 'monthly' && r.monthlyStats?.length > 0 && (
            <div className="card">
              <div className="card-header"><h2 className="card-title">📅 ROI Mensile</h2></div>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={r.monthlyStats}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f0f0f0" />
                  <XAxis dataKey="month" />
                  <YAxis tickFormatter={(v) => `${v}%`} />
                  <Tooltip formatter={(v: any) => `${parseFloat(v).toFixed(2)}%`} />
                  <ReferenceLine y={0} stroke="#999" />
                  <Bar
                    dataKey="roi"
                    name="ROI Mensile"
                    fill="#1a73e8"
                    radius={[4, 4, 0, 0]}
                  />
                </BarChart>
              </ResponsiveContainer>
              <table style={{ marginTop: 16 }}>
                <thead><tr><th>Anno</th><th>Mese</th><th>Scommesse</th><th>Puntato</th><th>Rientro</th><th>Profitto</th><th>ROI</th></tr></thead>
                <tbody>
                  {r.monthlyStats.map((m: any) => (
                    <tr key={`${m.year}-${m.month}`}>
                      <td>{m.year}</td>
                      <td>{m.month}</td>
                      <td>{m.bets}</td>
                      <td>€{m.staked?.toFixed(2)}</td>
                      <td>€{m.returned?.toFixed(2)}</td>
                      <td style={{ color: m.profit >= 0 ? 'var(--secondary)' : 'var(--danger)', fontWeight: 600 }}>€{m.profit?.toFixed(2)}</td>
                      <td style={{ color: m.roi >= 0 ? 'var(--secondary)' : 'var(--danger)', fontWeight: 600 }}>{m.roi?.toFixed(2)}%</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === 'calibration' && r.calibration?.length > 0 && (
            <div className="card">
              <div className="card-header">
                <div>
                  <h2 className="card-title">🎯 Calibrazione del Modello</h2>
                  <div className="card-subtitle">Un modello perfettamente calibrato segue la diagonale</div>
                </div>
              </div>
              <ResponsiveContainer width="100%" height={300}>
                <ScatterChart>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="predictedAvg" name="Probabilità Predetta" tickFormatter={v => `${(v*100).toFixed(0)}%`} />
                  <YAxis dataKey="actualFrequency" name="Frequenza Reale" tickFormatter={v => `${(v*100).toFixed(0)}%`} />
                  <Tooltip formatter={(v: any) => `${(parseFloat(v)*100).toFixed(1)}%`} />
                  <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 1, y: 1 }]} stroke="#1a73e8" strokeDasharray="4 4" label="Perfetta calibrazione" />
                  <Scatter data={r.calibration.filter((b: any) => b.count > 0)} fill="#34a853" name="Buckets" />
                </ScatterChart>
              </ResponsiveContainer>
              <table style={{ marginTop: 16 }}>
                <thead><tr><th>Range Predetto</th><th>Prob. Media</th><th>Freq. Reale</th><th>Campioni</th><th>Errore</th></tr></thead>
                <tbody>
                  {r.calibration.filter((b: any) => b.count > 0).map((b: any) => {
                    const err = Math.abs(b.predictedAvg - b.actualFrequency);
                    return (
                      <tr key={b.predictedRange}>
                        <td>{b.predictedRange}</td>
                        <td>{(b.predictedAvg * 100).toFixed(1)}%</td>
                        <td>{(b.actualFrequency * 100).toFixed(1)}%</td>
                        <td>{b.count}</td>
                        <td style={{ color: err < 0.05 ? 'var(--secondary)' : err < 0.1 ? 'var(--warning)' : 'var(--danger)' }}>
                          {(err * 100).toFixed(1)}pp
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {activeTab === 'stats' && (
            <div className="card">
              <div className="card-header"><h2 className="card-title">📊 Statistiche Complete</h2></div>
              <div className="grid-2">
                <table>
                  <tbody>
                    <tr><th colSpan={2} style={{ textAlign: 'left', padding: '8px 12px', background: 'var(--bg)' }}>Dati Dataset</th></tr>
                    <tr><td>Partite totali</td><td>{r.totalMatches}</td></tr>
                    <tr><td>Partite training</td><td>{r.trainingMatches} (70%)</td></tr>
                    <tr><td>Partite test</td><td>{r.testMatches} (30%)</td></tr>
                    <tr><td>Scommesse piazzate</td><td>{r.betsPlaced}</td></tr>
                    <tr><td>Scommesse vinte</td><td>{r.betsWon}</td></tr>
                    <tr><td>Win Rate</td><td>{r.winRate?.toFixed(2)}%</td></tr>
                  </tbody>
                </table>
                <table>
                  <tbody>
                    <tr><th colSpan={2} style={{ textAlign: 'left', padding: '8px 12px', background: 'var(--bg)' }}>Metriche Qualità</th></tr>
                    <tr><td>Brier Score</td><td>{r.brierScoreGoals?.toFixed(4)}</td></tr>
                    <tr><td>Log Loss</td><td>{r.logLoss?.toFixed(4)}</td></tr>
                    <tr><td>Sharpe Ratio (ann.)</td><td>{r.sharpeRatio?.toFixed(3)}</td></tr>
                    <tr><td>Max Drawdown</td><td>{r.maxDrawdown?.toFixed(2)}%</td></tr>
                    <tr><td>Recovery Factor</td><td>{r.recoveryFactor?.toFixed(2)}</td></tr>
                    <tr><td>Profit Factor</td><td>{r.profitFactor?.toFixed(2)}</td></tr>
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default Backtesting;
