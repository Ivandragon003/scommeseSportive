import React, { useMemo, useState } from 'react';
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
import ToastStack from '../common/ToastStack';
import ConfirmDialog from '../common/ConfirmDialog';
import ErrorBanner from '../common/ErrorBanner';
import { useToastState } from '../../hooks/useToastState';
import { useConfirmDialog } from '../../hooks/useConfirmDialog';
import { useBacktestingData } from '../../hooks/useBacktestingData';

type BacktestMode = 'classic' | 'walk_forward';
type ConfidenceMode = 'high_only' | 'medium_and_above';

const formatPct = (value: number | null | undefined, digits = 2) => `${Number(value ?? 0).toFixed(digits)}%`;
const formatMoney = (value: number | null | undefined) => `EUR ${Number(value ?? 0).toFixed(2)}`;
const formatDate = (value: string | Date | null | undefined) => {
  if (!value) return '-';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '-' : parsed.toLocaleDateString('it-IT');
};

const BacktestingPageView: React.FC = () => {
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
  const [activeTab, setActiveTab] = useState('overview');
  const [pruneKeepLatest, setPruneKeepLatest] = useState('20');
  const [reportMarket, setReportMarket] = useState('');
  const [reportSource, setReportSource] = useState('');
  const [reportDateFrom, setReportDateFrom] = useState('');
  const [reportDateTo, setReportDateTo] = useState('');
  const toastState = useToastState();
  const confirmDialog = useConfirmDialog();
  const {
    loading,
    maintenanceLoading,
    results,
    currentResult,
    currentResultId,
    reportLoading,
    backtestReport,
    reportError,
    setReportError,
    setBacktestReport,
    currentIsWalkForward,
    loadReport,
    loadHistorical,
    runValidation,
    handleDeleteRun,
    handleDeleteAllRuns,
    handlePruneRuns,
  } = useBacktestingData({
    confirm: confirmDialog.confirm,
    showToast: toastState.showToast,
  });

  const reportFilters = useMemo(() => ({
    market: reportMarket,
    source: reportSource,
    dateFrom: reportDateFrom,
    dateTo: reportDateTo,
  }), [reportDateFrom, reportDateTo, reportMarket, reportSource]);

  const handleRun = async () => {
    const result = await runValidation({
      mode,
      competition,
      season,
      trainRatio,
      confidenceLevel,
      initialTrainMatches,
      testWindowMatches,
      stepMatches,
      maxFolds,
      expandingWindow,
    }, reportFilters);
    if (result) {
      setActiveTab(result.kind === 'walk_forward' || Array.isArray(result.folds) ? 'folds' : 'overview');
    }
  };

  const handleLoadHistorical = async (id: number) => {
    const result = await loadHistorical(id, reportFilters);
    if (result) {
      setActiveTab(result.kind === 'walk_forward' || Array.isArray(result.folds) ? 'folds' : 'overview');
    }
  };

  const classicResult = currentIsWalkForward ? null : currentResult;
  const walkForwardResult = currentIsWalkForward ? currentResult : null;
  const reportMarketOptions = useMemo(() => backtestReport?.dataset?.availableMarkets ?? [], [backtestReport]);
  const reportSourceOptions = useMemo(() => backtestReport?.dataset?.availableSources ?? [], [backtestReport]);

  return (
    <>
      <div style={{ padding: '40px 32px', minHeight: '100vh' }}>
        <div style={{ marginBottom: 32 }}>
        <h1 className="fp-page-title fp-gradient-gold">Backtesting e Validazione</h1>
        <p style={{ fontSize: 12, color: 'var(--text-2)', margin: 0, fontFamily: 'DM Mono, monospace' }}>
          Validazione del modello separata dalla manutenzione run, con priorita alle quote storiche archiviate
        </p>
      </div>

      {reportError && (
        <ErrorBanner
          title="Report non disponibile"
          message={reportError}
          onDismiss={() => setReportError(null)}
        />
      )}

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

            <button
              className="fp-btn fp-btn-gold fp-btn-lg"
              onClick={handleRun}
              disabled={loading}
              title={loading ? 'Backtest gia in esecuzione' : mode === 'classic' ? 'Avvia una validazione classica' : 'Avvia una validazione walk-forward'}
            >
              {loading ? 'Esecuzione in corso…' : mode === 'classic' ? 'Avvia Backtest' : 'Avvia Walk-Forward'}
            </button>
          </div>
        </div>

        <div style={{ display: 'grid', gap: 16 }}>
          <div className="fp-card">
            <div className="fp-card-head">
              <div className="fp-card-title">Archivio Run</div>
              <span className="fp-badge fp-badge-gray">{results.length} run</span>
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
                          {row.kind === 'walk_forward' ? 'Walk-Forward' : 'Classic'}
                        </span>
                      </td>
                      <td style={{ fontWeight: 600 }}>{row.competition}</td>
                      <td className="fp-mono" style={{ color: 'var(--text-2)', fontSize: 12 }}>{row.season_range}</td>
                      <td className="fp-mono" style={{ color: 'var(--text-2)', fontSize: 12 }}>{formatDate(row.run_at)}</td>
                      <td style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                        <button
                          className="fp-btn fp-btn-ghost fp-btn-sm"
                          onClick={() => void handleLoadHistorical(row.id)}
                          disabled={maintenanceLoading}
                          title={maintenanceLoading ? 'Attendi il completamento della manutenzione run' : 'Apri questo run'}
                        >
                          Apri Run
                        </button>
                        <button
                          className="fp-btn fp-btn-ghost fp-btn-sm"
                          onClick={() => handleDeleteRun(Number(row.id))}
                          disabled={maintenanceLoading}
                          title={maintenanceLoading ? 'Attendi il completamento della manutenzione run' : 'Elimina questo run'}
                        >
                          Elimina Run
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

          <div className="fp-card" style={{ borderColor: 'var(--red-border)', background: 'color-mix(in srgb, white 88%, var(--red-dim))' }}>
            <div className="fp-card-head">
              <div>
                <div className="fp-card-title">Manutenzione run</div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
                  Azioni distruttive e pruning. Usa il filtro competizione a sinistra per limitare l’ambito.
                </div>
              </div>
              <span className="fp-badge fp-badge-red">Pericoloso</span>
            </div>
            <div className="fp-card-body" style={{ display: 'grid', gap: 12 }}>
              <div className="fp-alert fp-alert-warning">
                Elimina o riduci i run solo quando serve davvero. Le operazioni non sono reversibili.
              </div>
              <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
                <input
                  className="fp-input"
                  style={{ maxWidth: 140 }}
                  type="number"
                  min={0}
                  value={pruneKeepLatest}
                  onChange={(e) => setPruneKeepLatest(e.target.value)}
                  placeholder="20"
                  aria-label="Numero di run da mantenere"
                />
                <button
                  className="fp-btn fp-btn-ghost fp-btn-sm"
                  onClick={() => void handlePruneRuns(pruneKeepLatest, competition)}
                  disabled={maintenanceLoading}
                  title={maintenanceLoading ? 'Manutenzione run gia in corso' : 'Mantieni solo gli ultimi N run'}
                >
                  Mantieni ultimi N
                </button>
                <button
                  className="fp-btn fp-btn-red fp-btn-sm"
                  onClick={() => void handleDeleteAllRuns(competition)}
                  disabled={maintenanceLoading}
                  title={maintenanceLoading ? 'Manutenzione run gia in corso' : 'Elimina tutti i run salvati'}
                >
                  Svuota archivio run
                </button>
              </div>
              <div style={{ color: 'var(--text-3)', fontSize: 12 }}>
                Mantieni ultimi N: conserva solo i run piu recenti nel perimetro selezionato.
              </div>
            </div>
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

      {(currentResult || backtestReport || reportError) && (
        <div className="fp-card" style={{ marginBottom: 24 }}>
          <div className="fp-card-head">
            <div className="fp-card-title">Report Decisionale</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {backtestReport?.dataset?.legacyData ? (
                <span className="fp-badge fp-badge-red">Run legacy</span>
              ) : (
                <span className="fp-badge fp-badge-blue">
                  {backtestReport?.dataset?.filteredBets ?? 0} bet filtrate
                </span>
              )}
            </div>
          </div>
          <div className="fp-card-body">
            <div className="fp-grid-2" style={{ marginBottom: 18 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label className="fp-label">Mercato</label>
                <select className="fp-input" value={reportMarket} onChange={(e) => setReportMarket(e.target.value)}>
                  <option value="">Tutti</option>
                  {reportMarketOptions.map((option: string) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label className="fp-label">Sorgente quote</label>
                <select className="fp-input" value={reportSource} onChange={(e) => setReportSource(e.target.value)}>
                  <option value="">Tutte</option>
                  {reportSourceOptions.map((option: string) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label className="fp-label">Data da</label>
                <input className="fp-input" type="date" value={reportDateFrom} onChange={(e) => setReportDateFrom(e.target.value)} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label className="fp-label">Data a</label>
                <input className="fp-input" type="date" value={reportDateTo} onChange={(e) => setReportDateTo(e.target.value)} />
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, marginBottom: 18, flexWrap: 'wrap' }}>
              <button
                className="fp-btn fp-btn-gold fp-btn-sm"
                onClick={() => void loadReport(currentResultId, competition, reportFilters, { force: true })}
                disabled={reportLoading}
              >
                {reportLoading ? 'Aggiornamento...' : 'Aggiorna report'}
              </button>
              <button
                className="fp-btn fp-btn-ghost fp-btn-sm"
                onClick={() => {
                  setReportMarket('');
                  setReportSource('');
                  setReportDateFrom('');
                  setReportDateTo('');
                  if (currentResult?.reportSnapshot) {
                    setBacktestReport(currentResult.reportSnapshot);
                    setReportError(null);
                  } else {
                    void loadReport(currentResultId, competition, {
                      market: '',
                      source: '',
                      dateFrom: '',
                      dateTo: '',
                    }, { force: true });
                  }
                }}
              >
                Reset filtri
              </button>
            </div>

            {reportError && (
              <div className="fp-alert fp-alert-danger" style={{ marginBottom: 18 }}>
                {reportError}
              </div>
            )}

            {backtestReport && (
              <>
                <div className="fp-grid-4" style={{ marginBottom: 18 }}>
                  {[
                    { label: 'Yield', value: formatPct(backtestReport.summary?.yieldPct, 2), color: (backtestReport.summary?.yieldPct ?? 0) >= 0 ? 'green' : 'red' },
                    { label: 'ROI bankroll', value: formatPct(backtestReport.summary?.roiPct, 2), color: (backtestReport.summary?.roiPct ?? 0) >= 0 ? 'green' : 'red' },
                    { label: 'Hit rate', value: formatPct(backtestReport.summary?.hitRatePct, 2), color: 'blue' },
                    { label: 'Brier score', value: Number(backtestReport.summary?.brierScore ?? 0).toFixed(4), color: 'gold' },
                    { label: 'Log loss', value: Number(backtestReport.summary?.logLoss ?? 0).toFixed(4), color: 'purple' },
                    { label: 'EV atteso', value: formatPct(backtestReport.summary?.expectedEvPct, 2), color: 'blue' },
                    { label: 'EV realizzato', value: formatPct(backtestReport.summary?.realizedEvPct, 2), color: (backtestReport.summary?.realizedEvPct ?? 0) >= 0 ? 'green' : 'red' },
                    { label: 'Capture EV', value: backtestReport.summary?.evCapturePct === null ? '-' : formatPct(backtestReport.summary?.evCapturePct, 1), color: 'gold' },
                  ].map((item) => (
                    <div key={item.label} className={`fp-stat c-${item.color}`}>
                      <div className={`fp-stat-val c-${item.color}`}>{item.value}</div>
                      <div className="fp-stat-label">{item.label}</div>
                    </div>
                  ))}
                </div>

                {Array.isArray(backtestReport.alerts) && backtestReport.alerts.length > 0 && (
                  <div style={{ marginBottom: 18 }}>
                    {backtestReport.alerts.map((alert: any, index: number) => (
                      <div
                        key={`${alert.type}_${alert.bucketKey}_${index}`}
                        className={alert.severity === 'critical' ? 'fp-alert fp-alert-danger' : 'fp-alert fp-alert-warning'}
                        style={{ marginBottom: 10 }}
                      >
                        {alert.message}
                      </div>
                    ))}
                  </div>
                )}

                <div className="fp-grid-2" style={{ marginBottom: 24 }}>
                  <div className="fp-card">
                    <div className="fp-card-head">
                      <div className="fp-card-title">Bucket Probabilità</div>
                    </div>
                    <div style={{ padding: '24px 24px 8px' }}>
                      <ResponsiveContainer width="100%" height={300}>
                        <BarChart data={backtestReport.calibration?.probabilityBuckets ?? []}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                          <XAxis dataKey="label" tick={{ fill: 'var(--text-3)', fontSize: 11 }} />
                          <YAxis tick={{ fill: 'var(--text-3)', fontSize: 11 }} tickFormatter={(value) => `${value}%`} />
                          <Tooltip
                            contentStyle={{ background: 'var(--surface2)', border: '1px solid var(--border-hover)', borderRadius: 12, fontSize: 12 }}
                            formatter={(value: any) => [`${Number(value).toFixed(2)}%`]}
                          />
                          <Legend wrapperStyle={{ fontSize: 12, color: 'var(--text-2)' }} />
                          <Bar dataKey="predictedProbabilityPct" name="Previsto" fill="var(--blue)" radius={[6, 6, 0, 0]} />
                          <Bar dataKey="actualFrequencyPct" name="Realizzato" fill="var(--gold)" radius={[6, 6, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>

                  <div className="fp-card">
                    <div className="fp-card-head">
                      <div className="fp-card-title">Yield per Sorgente</div>
                    </div>
                    <div style={{ padding: '24px 24px 8px' }}>
                      <ResponsiveContainer width="100%" height={300}>
                        <BarChart data={backtestReport.segments?.bySource ?? []}>
                          <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.05)" />
                          <XAxis dataKey="label" tick={{ fill: 'var(--text-3)', fontSize: 11 }} />
                          <YAxis tick={{ fill: 'var(--text-3)', fontSize: 11 }} tickFormatter={(value) => `${value}%`} />
                          <Tooltip
                            contentStyle={{ background: 'var(--surface2)', border: '1px solid var(--border-hover)', borderRadius: 12, fontSize: 12 }}
                            formatter={(value: any) => [`${Number(value).toFixed(2)}%`, 'Yield']}
                          />
                          <ReferenceLine y={0} stroke="var(--border-hover)" />
                          <Bar dataKey="yieldPct" fill="var(--green)" radius={[6, 6, 0, 0]} />
                        </BarChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </div>

                <div className="fp-grid-2" style={{ marginBottom: 24 }}>
                  <div className="fp-card">
                    <div className="fp-card-head">
                      <div className="fp-card-title">Mercati</div>
                    </div>
                    <div style={{ overflowX: 'auto' }}>
                      <table className="fp-table">
                        <thead>
                          <tr>
                            <th>Mercato</th>
                            <th>Bet</th>
                            <th>Yield</th>
                            <th>Hit rate</th>
                            <th>EV atteso</th>
                          </tr>
                        </thead>
                        <tbody>
                          {(backtestReport.segments?.byMarket ?? []).map((row: any) => (
                            <tr key={row.key}>
                              <td>{row.label}</td>
                              <td className="fp-mono">{row.totalBets}</td>
                              <td className="fp-mono" style={{ color: row.yieldPct >= 0 ? 'var(--green)' : 'var(--red)' }}>{formatPct(row.yieldPct, 2)}</td>
                              <td className="fp-mono">{formatPct(row.hitRatePct, 2)}</td>
                              <td className="fp-mono">{formatPct(row.expectedEvPct, 2)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className="fp-card">
                    <div className="fp-card-head">
                      <div className="fp-card-title">Bucket EV / Edge / Confidence</div>
                    </div>
                    <div style={{ overflowX: 'auto' }}>
                      <table className="fp-table">
                        <thead>
                          <tr>
                            <th>Bucket</th>
                            <th>Bet</th>
                            <th>Yield</th>
                            <th>Hit rate</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[...(backtestReport.segments?.byEvBucket ?? []), ...(backtestReport.segments?.byConfidence ?? [])].slice(0, 8).map((row: any) => (
                            <tr key={`${row.key}_${row.label}`}>
                              <td>{row.label}</td>
                              <td className="fp-mono">{row.totalBets}</td>
                              <td className="fp-mono" style={{ color: row.yieldPct >= 0 ? 'var(--green)' : 'var(--red)' }}>{formatPct(row.yieldPct, 2)}</td>
                              <td className="fp-mono">{formatPct(row.hitRatePct, 2)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                </div>

                <div className="fp-alert fp-alert-info">
                  CLV: non ancora disponibile in modo metodologicamente corretto. {backtestReport.clv?.reason}
                </div>
              </>
            )}
          </div>
        </div>
      )}
      </div>
      <ToastStack toasts={toastState.toasts} onDismiss={toastState.dismissToast} />
      <ConfirmDialog {...confirmDialog.dialogProps} />
    </>
  );
};

export default BacktestingPageView;
