import React, { useEffect, useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  deleteBacktestResult,
  deleteBacktestResults,
  getBacktestResult,
  getBacktestResults,
  pruneBacktestResults,
  runBacktest,
  runWalkForwardBacktest,
} from '../utils/api';

type BacktestMode = 'classic' | 'walk_forward';
type ConfidenceMode = 'high_only' | 'medium_and_above';

const formatPct = (value: number | null | undefined, digits = 2) => `${Number(value ?? 0).toFixed(digits)}%`;
const formatMoney = (value: number | null | undefined) => `EUR ${Number(value ?? 0).toFixed(2)}`;
const formatDate = (value: string | Date | null | undefined) => {
  if (!value) return '-';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '-' : parsed.toLocaleDateString('it-IT');
};

const isWalkForwardResult = (value: any): boolean =>
  Boolean(value && (value.kind === 'walk_forward' || Array.isArray(value.folds)));

const Backtesting: React.FC = () => {
  const [competition, setCompetition] = useState('Serie A');
  const [season, setSeason] = useState('');
  const [mode, setMode] = useState<BacktestMode>('classic');
  const [confidenceLevel, setConfidenceLevel] = useState<ConfidenceMode>('medium_and_above');
  const [trainRatio, setTrainRatio] = useState('0.70');
  const [initialTrainMatches, setInitialTrainMatches] = useState('');
  const [testWindowMatches, setTestWindowMatches] = useState('');
  const [stepMatches, setStepMatches] = useState('');
  const [maxFolds, setMaxFolds] = useState('10');
  const [expandingWindow, setExpandingWindow] = useState(true);
  const [loading, setLoading] = useState(false);
  const [maintenanceLoading, setMaintenanceLoading] = useState(false);
  const [results, setResults] = useState<any[]>([]);
  const [currentResult, setCurrentResult] = useState<any>(null);
  const [currentResultId, setCurrentResultId] = useState<number | null>(null);
  const [activeTab, setActiveTab] = useState('overview');
  const [pruneKeepLatest, setPruneKeepLatest] = useState('20');

  useEffect(() => {
    void loadResults();
  }, []);

  const loadResults = async () => {
    const res = await getBacktestResults();
    setResults(res.data ?? []);
  };

  const handleRun = async () => {
    setLoading(true);
    try {
      const payload =
        mode === 'classic'
          ? await runBacktest({
              competition,
              season: season || undefined,
              trainRatio: Number(trainRatio),
              confidenceLevel,
            })
          : await runWalkForwardBacktest({
              competition,
              season: season || undefined,
              initialTrainMatches: initialTrainMatches ? Number(initialTrainMatches) : undefined,
              testWindowMatches: testWindowMatches ? Number(testWindowMatches) : undefined,
              stepMatches: stepMatches ? Number(stepMatches) : undefined,
              maxFolds: maxFolds ? Number(maxFolds) : undefined,
              confidenceLevel,
              expandingWindow,
            });

      if (payload.data) {
        setCurrentResult(payload.data);
        setCurrentResultId(null);
        setActiveTab(isWalkForwardResult(payload.data) ? 'folds' : 'overview');
        await loadResults();
      }
    } catch (e: any) {
      alert(`Errore backtest: ${e.message}`);
    } finally {
      setLoading(false);
    }
  };

  const loadHistorical = async (id: number) => {
    const res = await getBacktestResult(id);
    const result = res.data?.result ?? null;
    if (result) {
      setCurrentResult(result);
      setCurrentResultId(id);
      setActiveTab(isWalkForwardResult(result) ? 'folds' : 'overview');
    }
  };

  const handleDeleteRun = async (id: number) => {
    if (!window.confirm(`Eliminare il run #${id}?`)) return;
    setMaintenanceLoading(true);
    try {
      await deleteBacktestResult(id);
      if (currentResultId === id) {
        setCurrentResult(null);
        setCurrentResultId(null);
      }
      await loadResults();
    } catch (e: any) {
      alert(`Errore eliminazione run: ${e.message}`);
    } finally {
      setMaintenanceLoading(false);
    }
  };

  const handleDeleteAllRuns = async () => {
    const scope = competition.trim();
    const confirmMsg = scope
      ? `Eliminare tutti i run di backtest per ${scope}?`
      : 'Eliminare tutti i run di backtest salvati?';
    if (!window.confirm(confirmMsg)) return;
    setMaintenanceLoading(true);
    try {
      const res = await deleteBacktestResults(scope || undefined);
      alert(`Run eliminati: ${res.data?.deletedCount ?? 0}`);
      setCurrentResult(null);
      setCurrentResultId(null);
      await loadResults();
    } catch (e: any) {
      alert(`Errore eliminazione backtest: ${e.message}`);
    } finally {
      setMaintenanceLoading(false);
    }
  };

  const handlePruneRuns = async () => {
    const keepLatest = Number(pruneKeepLatest);
    if (!Number.isFinite(keepLatest) || keepLatest < 0) {
      alert('Inserisci un numero valido (>= 0)');
      return;
    }
    const scope = competition.trim();
    const confirmMsg = scope
      ? `Mantieni solo gli ultimi ${Math.floor(keepLatest)} run per ${scope}?`
      : `Mantieni solo gli ultimi ${Math.floor(keepLatest)} run globali?`;
    if (!window.confirm(confirmMsg)) return;
    setMaintenanceLoading(true);
    try {
      const res = await pruneBacktestResults(Math.floor(keepLatest), scope || undefined);
      alert(`Run eliminati: ${res.data?.deletedCount ?? 0}`);
      await loadResults();
    } catch (e: any) {
      alert(`Errore prune backtest: ${e.message}`);
    } finally {
      setMaintenanceLoading(false);
    }
  };

  const currentIsWalkForward = useMemo(() => isWalkForwardResult(currentResult), [currentResult]);
  const classicResult = currentIsWalkForward ? null : currentResult;
  const walkForwardResult = currentIsWalkForward ? currentResult : null;

  return (
    <div style={{ padding: '40px 32px', minHeight: '100vh' }}>
      <div style={{ marginBottom: 32 }}>
        <h1 className="fp-page-title fp-gradient-gold">Backtesting & Validazione</h1>
        <p style={{ fontSize: 12, color: 'var(--text-2)', margin: 0, fontFamily: 'DM Mono, monospace' }}>
          Split classico e walk-forward con priorita alle quote storiche archiviate
        </p>
      </div>

      <div className="fp-grid-2" style={{ marginBottom: 24 }}>
        <div className="fp-card">
          <div className="fp-card-head">
            <div className="fp-card-title">Esegui Validazione</div>
          </div>
          <div className="fp-card-body">
            <div className="fp-alert fp-alert-info" style={{ marginBottom: 18 }}>
              Il motore usa prima gli snapshot reali del bookmaker. Dove mancano, passa alle quote stimate dal modello.
            </div>
            <div className="fp-grid-2" style={{ marginBottom: 18 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label className="fp-label">Modalita</label>
                <select className="fp-input" value={mode} onChange={(e) => setMode(e.target.value as BacktestMode)}>
                  <option value="classic">Backtest classico</option>
                  <option value="walk_forward">Walk-forward</option>
                </select>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label className="fp-label">Confidence filter</label>
                <select className="fp-input" value={confidenceLevel} onChange={(e) => setConfidenceLevel(e.target.value as ConfidenceMode)}>
                  <option value="medium_and_above">Medium and above</option>
                  <option value="high_only">High only</option>
                </select>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label className="fp-label">Competizione</label>
                <input
                  className="fp-input"
                  value={competition}
                  onChange={(e) => setCompetition(e.target.value)}
                  placeholder="es. Serie A"
                />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label className="fp-label">Stagione (opzionale)</label>
                <input
                  className="fp-input"
                  value={season}
                  onChange={(e) => setSeason(e.target.value)}
                  placeholder="es. 2024-25"
                />
              </div>
            </div>

            {mode === 'classic' ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginBottom: 18, maxWidth: 280 }}>
                <label className="fp-label">Train ratio</label>
                <input
                  className="fp-input"
                  value={trainRatio}
                  onChange={(e) => setTrainRatio(e.target.value)}
                  placeholder="0.70"
                />
              </div>
            ) : (
              <>
                <div className="fp-grid-2" style={{ marginBottom: 18 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <label className="fp-label">Initial train matches</label>
                    <input className="fp-input" value={initialTrainMatches} onChange={(e) => setInitialTrainMatches(e.target.value)} placeholder="auto" />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <label className="fp-label">Test window matches</label>
                    <input className="fp-input" value={testWindowMatches} onChange={(e) => setTestWindowMatches(e.target.value)} placeholder="auto" />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <label className="fp-label">Step matches</label>
                    <input className="fp-input" value={stepMatches} onChange={(e) => setStepMatches(e.target.value)} placeholder="auto" />
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    <label className="fp-label">Max folds</label>
                    <input className="fp-input" value={maxFolds} onChange={(e) => setMaxFolds(e.target.value)} placeholder="10" />
                  </div>
                </div>
                <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18, color: 'var(--text-2)' }}>
                  <input type="checkbox" checked={expandingWindow} onChange={(e) => setExpandingWindow(e.target.checked)} />
                  Expanding window
                </label>
              </>
            )}

            <button className="fp-btn fp-btn-gold fp-btn-lg" onClick={handleRun} disabled={loading}>
              {loading ? 'Esecuzione in corso...' : mode === 'classic' ? 'Avvia Backtest' : 'Avvia Walk-forward'}
            </button>
          </div>
        </div>

        <div className="fp-card">
          <div className="fp-card-head">
            <div className="fp-card-title">Run Salvati</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <span className="fp-badge fp-badge-gray">{results.length} run</span>
              <button className="fp-btn fp-btn-red fp-btn-sm" onClick={handleDeleteAllRuns} disabled={maintenanceLoading}>
                Svuota
              </button>
            </div>
          </div>
          <div className="fp-card-body" style={{ borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center' }}>
            <input
              className="fp-input"
              style={{ maxWidth: 120 }}
              type="number"
              min={0}
              value={pruneKeepLatest}
              onChange={(e) => setPruneKeepLatest(e.target.value)}
              placeholder="20"
            />
            <button className="fp-btn fp-btn-ghost fp-btn-sm" onClick={handlePruneRuns} disabled={maintenanceLoading}>
              Mantieni ultimi N
            </button>
            <span style={{ color: 'var(--text-3)', fontSize: 12 }}>
              Filtro opzionale per competizione: usa il campo "Competizione" qui a sinistra.
            </span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="fp-table">
              <thead>
                <tr>
                  <th>Tipo</th>
                  <th>Competizione</th>
                  <th>Stagione</th>
                  <th>Data</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {results.slice(0, 10).map((row: any) => (
                  <tr key={row.id}>
                    <td>
                      <span className={`fp-badge ${row.kind === 'walk_forward' ? 'fp-badge-blue' : 'fp-badge-gold'}`}>
                        {row.kind === 'walk_forward' ? 'Walk-forward' : 'Classic'}
                      </span>
                    </td>
                    <td style={{ fontWeight: 600 }}>{row.competition}</td>
                    <td className="fp-mono" style={{ color: 'var(--text-2)', fontSize: 12 }}>{row.season_range}</td>
                    <td className="fp-mono" style={{ color: 'var(--text-2)', fontSize: 12 }}>{formatDate(row.run_at)}</td>
                    <td style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                      <button className="fp-btn fp-btn-ghost fp-btn-sm" onClick={() => loadHistorical(row.id)} disabled={maintenanceLoading}>
                        Carica
                      </button>
                      <button className="fp-btn fp-btn-red fp-btn-sm" onClick={() => handleDeleteRun(Number(row.id))} disabled={maintenanceLoading}>
                        Elimina
                      </button>
                    </td>
                  </tr>
                ))}
                {results.length === 0 && (
                  <tr>
                    <td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-3)' }}>
                      Nessun run salvato
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {classicResult && (
        <>
          <div className="fp-grid-4" style={{ marginBottom: 16 }}>
            {[
              { label: 'ROI', value: `${classicResult.roi >= 0 ? '+' : ''}${formatPct(classicResult.roi, 2)}`, color: classicResult.roi >= 0 ? 'green' : 'red' },
              { label: 'Win Rate', value: formatPct(classicResult.winRate, 1), color: 'blue' },
              { label: 'Profit Factor', value: Number(classicResult.profitFactor ?? 0).toFixed(2), color: Number(classicResult.profitFactor ?? 0) > 1 ? 'green' : 'red' },
              { label: 'Brier Score', value: Number(classicResult.brierScore ?? classicResult.brierScoreGoals ?? 0).toFixed(4), color: 'gold' },
            ].map((item) => (
              <div key={item.label} className={`fp-stat c-${item.color}`}>
                <div className={`fp-stat-val c-${item.color}`}>{item.value}</div>
                <div className="fp-stat-label">{item.label}</div>
              </div>
            ))}
          </div>

          <div className="fp-tabs" style={{ marginBottom: 20 }}>
            {[
              { id: 'overview', label: 'Curva equity' },
              { id: 'monthly', label: 'Performance mensile' },
              { id: 'calibration', label: 'Calibrazione' },
              { id: 'stats', label: 'Statistiche' },
            ].map((tab) => (
              <button
                key={tab.id}
                className={`fp-tab${activeTab === tab.id ? ' active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {activeTab === 'overview' && Array.isArray(classicResult.equityCurve) && classicResult.equityCurve.length > 0 && (
            <div className="fp-card" style={{ marginBottom: 24 }}>
              <div className="fp-card-head">
                <div className="fp-card-title">Curva Equity</div>
                <span className={`fp-badge ${classicResult.netProfit >= 0 ? 'fp-badge-green' : 'fp-badge-red'}`}>
                  {classicResult.netProfit >= 0 ? '+' : ''}{formatMoney(classicResult.netProfit)}
                </span>
              </div>
              <div style={{ padding: '24px 24px 8px' }}>
                <ResponsiveContainer width="100%" height={340}>
                  <LineChart data={classicResult.equityCurve}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                    <XAxis dataKey="matchNumber" tick={{ fill: 'var(--text-3)', fontSize: 11 }} />
                    <YAxis tick={{ fill: 'var(--text-3)', fontSize: 11 }} tickFormatter={(value) => `EUR ${value}`} />
                    <Tooltip
                      contentStyle={{ background: 'var(--surface2)', border: '1px solid var(--border-hover)', borderRadius: 12, fontSize: 12 }}
                      formatter={(value: any) => [formatMoney(Number(value)), 'Bankroll']}
                    />
                    <Legend wrapperStyle={{ fontSize: 12, color: 'var(--text-2)' }} />
                    <ReferenceLine y={1000} stroke="var(--border-hover)" strokeDasharray="4 4" />
                    <Line type="monotone" dataKey="bankroll" name="Bankroll" stroke="var(--blue)" strokeWidth={2.5} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {activeTab === 'monthly' && Array.isArray(classicResult.monthlyStats) && classicResult.monthlyStats.length > 0 && (
            <div className="fp-card" style={{ marginBottom: 24 }}>
              <div className="fp-card-head">
                <div className="fp-card-title">ROI Mensile</div>
              </div>
              <div style={{ padding: '24px 24px 8px' }}>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={classicResult.monthlyStats}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                    <XAxis dataKey="month" tick={{ fill: 'var(--text-3)', fontSize: 11 }} />
                    <YAxis tick={{ fill: 'var(--text-3)', fontSize: 11 }} tickFormatter={(value) => `${value}%`} />
                    <Tooltip
                      contentStyle={{ background: 'var(--surface2)', border: '1px solid var(--border-hover)', borderRadius: 12, fontSize: 12 }}
                      formatter={(value: any) => [`${Number(value).toFixed(2)}%`, 'ROI']}
                    />
                    <ReferenceLine y={0} stroke="var(--border-hover)" />
                    <Bar dataKey="roi" fill="var(--blue)" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {activeTab === 'calibration' && Array.isArray(classicResult.calibration) && classicResult.calibration.length > 0 && (
            <div className="fp-card" style={{ marginBottom: 24 }}>
              <div className="fp-card-head">
                <div className="fp-card-title">Calibrazione</div>
              </div>
              <div style={{ padding: '24px 24px 8px' }}>
                <ResponsiveContainer width="100%" height={300}>
                  <ScatterChart>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                    <XAxis dataKey="predictedAvg" tick={{ fill: 'var(--text-3)', fontSize: 11 }} tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} />
                    <YAxis dataKey="actualFrequency" tick={{ fill: 'var(--text-3)', fontSize: 11 }} tickFormatter={(v) => `${(v * 100).toFixed(0)}%`} />
                    <Tooltip
                      contentStyle={{ background: 'var(--surface2)', border: '1px solid var(--border-hover)', borderRadius: 12, fontSize: 12 }}
                      formatter={(value: any) => [`${(Number(value) * 100).toFixed(1)}%`]}
                    />
                    <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 1, y: 1 }]} stroke="var(--blue)" strokeDasharray="4 4" />
                    <Scatter data={classicResult.calibration.filter((bucket: any) => bucket.count > 0)} fill="var(--green)" />
                  </ScatterChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {activeTab === 'stats' && (
            <div className="fp-grid-2" style={{ marginBottom: 24 }}>
              <div className="fp-card">
                <div className="fp-card-head">
                  <div className="fp-card-title">Dataset</div>
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table className="fp-table">
                    <tbody>
                      {[
                        ['Partite totali', classicResult.totalMatches],
                        ['Training', classicResult.trainingMatches],
                        ['Test', classicResult.testMatches],
                        ['Bet piazzate', classicResult.betsPlaced],
                        ['Bet vinte', classicResult.betsWon],
                        ['Quota media', Number(classicResult.averageOdds ?? 0).toFixed(2)],
                      ].map(([label, value]) => (
                        <tr key={String(label)}>
                          <td style={{ color: 'var(--text-2)' }}>{label}</td>
                          <td className="fp-mono" style={{ textAlign: 'right', fontWeight: 600 }}>{String(value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="fp-card">
                <div className="fp-card-head">
                  <div className="fp-card-title">Metriche</div>
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table className="fp-table">
                    <tbody>
                      {[
                        ['ROI', formatPct(classicResult.roi, 2)],
                        ['Win rate', formatPct(classicResult.winRate, 2)],
                        ['Sharpe ratio', Number(classicResult.sharpeRatio ?? 0).toFixed(3)],
                        ['Max drawdown', formatPct(classicResult.maxDrawdown, 2)],
                        ['Recovery factor', Number(classicResult.recoveryFactor ?? 0).toFixed(2)],
                        ['Historical odds coverage', classicResult.historicalOddsCoverage ?? '-'],
                      ].map(([label, value]) => (
                        <tr key={String(label)}>
                          <td style={{ color: 'var(--text-2)' }}>{label}</td>
                          <td className="fp-mono" style={{ textAlign: 'right', fontWeight: 600 }}>{String(value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {walkForwardResult && (
        <>
          <div className="fp-grid-4" style={{ marginBottom: 16 }}>
            {[
              { label: 'Fold totali', value: walkForwardResult.totalFolds ?? 0, color: 'blue' },
              { label: 'ROI aggregato', value: `${walkForwardResult.summary?.roi >= 0 ? '+' : ''}${formatPct(walkForwardResult.summary?.roi, 2)}`, color: (walkForwardResult.summary?.roi ?? 0) >= 0 ? 'green' : 'red' },
              { label: 'Fold positivi', value: formatPct(walkForwardResult.summary?.positiveFoldRate ?? 0, 1), color: 'gold' },
              { label: 'ROI std dev', value: formatPct(walkForwardResult.summary?.roiStdDev ?? 0, 2), color: 'purple' },
            ].map((item) => (
              <div key={item.label} className={`fp-stat c-${item.color}`}>
                <div className={`fp-stat-val c-${item.color}`}>{String(item.value)}</div>
                <div className="fp-stat-label">{item.label}</div>
              </div>
            ))}
          </div>

          <div className="fp-tabs" style={{ marginBottom: 20 }}>
            {[
              { id: 'folds', label: 'Folds' },
              { id: 'stability', label: 'Stabilita' },
            ].map((tab) => (
              <button
                key={tab.id}
                className={`fp-tab${activeTab === tab.id ? ' active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {activeTab === 'folds' && Array.isArray(walkForwardResult.folds) && (
            <div className="fp-card" style={{ marginBottom: 24 }}>
              <div className="fp-card-head">
                <div className="fp-card-title">Risultati per fold</div>
                <span className="fp-badge fp-badge-blue">
                  {walkForwardResult.expandingWindow ? 'Expanding window' : 'Rolling window'}
                </span>
              </div>
              <div style={{ padding: '24px 24px 8px' }}>
                <ResponsiveContainer width="100%" height={300}>
                  <BarChart data={walkForwardResult.folds}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                    <XAxis dataKey="foldNumber" tick={{ fill: 'var(--text-3)', fontSize: 11 }} />
                    <YAxis tick={{ fill: 'var(--text-3)', fontSize: 11 }} tickFormatter={(value) => `${value}%`} />
                    <Tooltip
                      contentStyle={{ background: 'var(--surface2)', border: '1px solid var(--border-hover)', borderRadius: 12, fontSize: 12 }}
                      formatter={(value: any) => [`${Number(value).toFixed(2)}%`, 'ROI fold']}
                    />
                    <ReferenceLine y={0} stroke="var(--border-hover)" />
                    <Bar dataKey="roi" fill="var(--gold)" radius={[6, 6, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table className="fp-table">
                  <thead>
                    <tr>
                      <th>Fold</th>
                      <th>Range</th>
                      <th>Train</th>
                      <th>Test</th>
                      <th>Bet</th>
                      <th>ROI</th>
                      <th>Win rate</th>
                      <th>Profitto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {walkForwardResult.folds.map((fold: any) => (
                      <tr key={fold.foldNumber}>
                        <td className="fp-mono">{fold.foldNumber}</td>
                        <td className="fp-mono">{formatDate(fold.startDate)} - {formatDate(fold.endDate)}</td>
                        <td className="fp-mono">{fold.trainMatches}</td>
                        <td className="fp-mono">{fold.testMatches}</td>
                        <td className="fp-mono">{fold.betsPlaced}</td>
                        <td className="fp-mono" style={{ color: fold.roi >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 700 }}>
                          {fold.roi >= 0 ? '+' : ''}{formatPct(fold.roi, 2)}
                        </td>
                        <td className="fp-mono">{formatPct(fold.winRate, 1)}</td>
                        <td className="fp-mono" style={{ color: fold.netProfit >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 700 }}>
                          {fold.netProfit >= 0 ? '+' : ''}{formatMoney(fold.netProfit)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'stability' && (
            <div className="fp-grid-2" style={{ marginBottom: 24 }}>
              <div className="fp-card">
                <div className="fp-card-head">
                  <div className="fp-card-title">Sintesi Walk-forward</div>
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table className="fp-table">
                    <tbody>
                      {[
                        ['Match totali', walkForwardResult.totalMatches],
                        ['Fold totali', walkForwardResult.totalFolds],
                        ['Bet piazzate', walkForwardResult.summary?.totalBetsPlaced ?? 0],
                        ['Bet vinte', walkForwardResult.summary?.totalBetsWon ?? 0],
                        ['Puntato', formatMoney(walkForwardResult.summary?.totalStaked)],
                        ['Profitto netto', `${(walkForwardResult.summary?.totalNetProfit ?? 0) >= 0 ? '+' : ''}${formatMoney(walkForwardResult.summary?.totalNetProfit)}`],
                      ].map(([label, value]) => (
                        <tr key={String(label)}>
                          <td style={{ color: 'var(--text-2)' }}>{label}</td>
                          <td className="fp-mono" style={{ textAlign: 'right', fontWeight: 600 }}>{String(value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="fp-card">
                <div className="fp-card-head">
                  <div className="fp-card-title">Stabilita</div>
                </div>
                <div style={{ overflowX: 'auto' }}>
                  <table className="fp-table">
                    <tbody>
                      {[
                        ['ROI aggregato', formatPct(walkForwardResult.summary?.roi, 2)],
                        ['ROI medio fold', formatPct(walkForwardResult.summary?.averageFoldROI, 2)],
                        ['ROI mediano fold', formatPct(walkForwardResult.summary?.medianFoldROI, 2)],
                        ['Deviazione ROI', formatPct(walkForwardResult.summary?.roiStdDev, 2)],
                        ['Brier medio', Number(walkForwardResult.summary?.averageBrierScore ?? 0).toFixed(4)],
                        ['Log loss medio', Number(walkForwardResult.summary?.averageLogLoss ?? 0).toFixed(4)],
                      ].map(([label, value]) => (
                        <tr key={String(label)}>
                          <td style={{ color: 'var(--text-2)' }}>{label}</td>
                          <td className="fp-mono" style={{ textAlign: 'right', fontWeight: 600 }}>{String(value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
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
