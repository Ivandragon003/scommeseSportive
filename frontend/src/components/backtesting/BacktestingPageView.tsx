import React, { useMemo, useState } from 'react';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ReferenceLine,
  ResponsiveContainer,
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

type ConfidenceMode = 'high_only' | 'medium_and_above';

const TOP_5_BACKTEST_KEY = 'TOP_5';
const COMPETITION_OPTIONS = [
  { value: 'Serie A', label: 'Serie A' },
  { value: 'Premier League', label: 'Premier League' },
  { value: 'La Liga', label: 'La Liga' },
  { value: 'Bundesliga', label: 'Bundesliga' },
  { value: 'Ligue 1', label: 'Ligue 1' },
  { value: TOP_5_BACKTEST_KEY, label: 'Top 5 campionati' },
];

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
  const [confidenceLevel, setConfidenceLevel] = useState<ConfidenceMode>('medium_and_above');
  const [initialTrainMatches, setInitialTrainMatches] = useState('');
  const [testWindowMatches, setTestWindowMatches] = useState('');
  const [stepMatches, setStepMatches] = useState('');
  const [maxFolds, setMaxFolds] = useState('10');
  const [expandingWindow, setExpandingWindow] = useState(true);
  const [saveIndividualRuns, setSaveIndividualRuns] = useState(false);
  const [optimizeRankingWeights, setOptimizeRankingWeights] = useState(false);
  const [activeTab, setActiveTab] = useState('folds');
  const [pruneKeepLatest, setPruneKeepLatest] = useState('20');
  const [reportMarket, setReportMarket] = useState('');
  const [reportSource, setReportSource] = useState('');
  const [reportDateFrom, setReportDateFrom] = useState('');
  const [reportDateTo, setReportDateTo] = useState('');
  const [tutorialOpen, setTutorialOpen] = useState(false);
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
      competition,
      season,
      confidenceLevel,
      initialTrainMatches,
      testWindowMatches,
      stepMatches,
      maxFolds,
      expandingWindow,
      saveIndividualRuns,
      optimizeRankingWeights,
    }, reportFilters);
    if (result) {
      setActiveTab(result.kind === 'walk_forward' || Array.isArray(result.folds) ? 'folds' : 'stability');
    }
  };

  const handleLoadHistorical = async (id: number) => {
    const result = await loadHistorical(id, reportFilters);
    if (result) {
      setActiveTab(result.kind === 'walk_forward' || Array.isArray(result.folds) ? 'folds' : 'overview');
    }
  };

  const legacyClassicResult = currentResult && !currentIsWalkForward ? currentResult : null;
  const walkForwardResult = currentIsWalkForward ? currentResult : null;
  const isTop5Competition = competition === TOP_5_BACKTEST_KEY;
  const showTop5TuningWarning = isTop5Competition && optimizeRankingWeights;
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

      <div className="fp-card" style={{ marginBottom: 24 }}>
        <div className="fp-card-head">
          <div>
            <div className="fp-card-title">Come usare il backtesting</div>
            <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4 }}>
              Guida operativa per leggere ROI, CLV e robustezza del modello senza giudicare poche partite.
            </div>
          </div>
          <button
            type="button"
            className="fp-btn fp-btn-ghost fp-btn-sm"
            onClick={() => setTutorialOpen((open) => !open)}
            aria-expanded={tutorialOpen}
          >
            {tutorialOpen ? 'Nascondi tutorial' : 'Come usare il backtesting'}
          </button>
        </div>
        {tutorialOpen && (
          <div className="fp-card-body" style={{ display: 'grid', gap: 12 }}>
            <div className="fp-alert fp-alert-info">
              Il sistema usa solo walk-forward: avvia prima Top 5 campionati, guarda ROI e CLV aggregati, poi entra nel dettaglio per campionato e confronta High only contro Medium and above.
            </div>
            <div className="fp-grid-2">
              <div>
                <h3 style={{ marginTop: 0 }}>Scelte operative</h3>
                <p>Walk-forward simula finestre successive di training e test nel tempo. E il flusso ufficiale per ridurre overfitting e misurare stabilita reale.</p>
                <p>Medium and above aumenta il campione e misura volume reale. High only e piu conservativo, ma puo essere troppo piccolo per giudizi rapidi.</p>
                <p>Top 5 campionati esegue Serie A, Premier League, La Liga, Bundesliga e Ligue 1 separatamente, poi mostra aggregato e dettaglio.</p>
                <p>Puoi scegliere se salvare anche i run singoli dei campionati: utile per storico dettagliato, meno utile se vuoi un archivio pulito.</p>
              </div>
              <div>
                <h3 style={{ marginTop: 0 }}>Come leggere i numeri</h3>
                <p>ROI e profit/loss dicono il risultato economico; win rate da solo non basta perche quote diverse hanno payout diversi.</p>
                <p>Initial train matches, test window matches, step matches ed expanding window controllano quanta storia entra nel training e quanto spesso il modello viene rivalutato.</p>
                <p>CLV positivo significa che la quota scelta era migliore della quota bookmaker di chiusura. Una bet persa puo comunque essere buona se ha CLV positivo; non giudicare il modello su poche giocate.</p>
                <p>Quote bookmaker reali e quote sintetiche non vanno mischiate: se il run usa solo sintetiche, il risultato e indicativo. Il confronto baseline vs algoritmo attuale serve a capire se le nuove penalita di rischio migliorano davvero.</p>
                <p>Il tuning dei pesi va letto solo in walk-forward: se un peso produce ROI alto con poche bet o CLV negativo, e un segnale di overfitting e non va promosso in produzione.</p>
              </div>
            </div>
          </div>
        )}
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
            {isTop5Competition && (
              <div className="fp-alert fp-alert-info" style={{ marginBottom: 18 }}>
                Il walk-forward Top 5 puo richiedere alcuni minuti. Se va in timeout, riduci max folds oppure riprova con un singolo campionato.
              </div>
            )}
            {showTop5TuningWarning && (
              <div className="fp-alert fp-alert-warning" style={{ marginBottom: 18 }}>
                Tuning pesi + Top 5 puo essere molto lento. Se va in timeout, riduci max folds, disattiva il tuning pesi oppure usa un singolo campionato.
              </div>
            )}
            {loading && (
              <div className="fp-alert fp-alert-info" style={{ marginBottom: 18 }}>
                {isTop5Competition
                  ? 'Il walk-forward Top 5 puo richiedere alcuni minuti.'
                  : 'Il walk-forward puo richiedere alcuni minuti.'}
              </div>
            )}
            <div className="fp-grid-2" style={{ marginBottom: 18 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label className="fp-label" htmlFor="backtest-confidence">Confidence filter</label>
                <select id="backtest-confidence" className="fp-input" value={confidenceLevel} onChange={(e) => setConfidenceLevel(e.target.value as ConfidenceMode)}>
                  <option value="medium_and_above">Medium and above</option>
                  <option value="high_only">High only</option>
                </select>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label className="fp-label" htmlFor="backtest-competition">Competizione</label>
                <select
                  id="backtest-competition"
                  className="fp-input"
                  value={competition}
                  onChange={(e) => setCompetition(e.target.value)}
                >
                  {COMPETITION_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label className="fp-label" htmlFor="backtest-season">Stagione (opzionale)</label>
                <input
                  id="backtest-season"
                  className="fp-input"
                  value={season}
                  onChange={(e) => setSeason(e.target.value)}
                  placeholder="es. 2024-25"
                />
              </div>
            </div>

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

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 18, color: 'var(--text-2)' }}>
              <input
                type="checkbox"
                checked={saveIndividualRuns}
                onChange={(e) => setSaveIndividualRuns(e.target.checked)}
                aria-describedby="save-individual-runs-help"
              />
              <span>
                <span style={{ display: 'block', color: 'var(--text-1)', fontWeight: 700 }}>
                  Salva anche i run singoli dei campionati
                </span>
                <span id="save-individual-runs-help" style={{ display: 'block', fontSize: 12 }}>
                  Per Top 5 mantiene in archivio anche Serie A, Premier League, La Liga, Bundesliga e Ligue 1 oltre al risultato aggregato.
                </span>
              </span>
            </label>

            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginBottom: 18, color: 'var(--text-2)' }}>
              <input
                type="checkbox"
                checked={optimizeRankingWeights}
                onChange={(e) => setOptimizeRankingWeights(e.target.checked)}
                aria-describedby="optimize-ranking-help"
              />
              <span>
                <span style={{ display: 'block', color: 'var(--text-1)', fontWeight: 700 }}>
                  Ottimizza pesi ranking in walk-forward
                </span>
                <span id="optimize-ranking-help" style={{ display: 'block', fontSize: 12 }}>
                  Esegue una ricerca prudente sui pesi e segnala possibili fitting sul passato; non applica automaticamente i pesi in produzione.
                </span>
              </span>
            </label>

            <button
              className="fp-btn fp-btn-gold fp-btn-lg"
              onClick={handleRun}
              disabled={loading}
              title={loading ? 'Walk-forward gia in esecuzione' : 'Avvia una validazione walk-forward'}
            >
              {loading ? 'Esecuzione in corso...' : 'Avvia Walk-forward'}
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
                          {row.kind === 'walk_forward' ? 'Walk-Forward' : 'Legacy/classic'}
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

      {legacyClassicResult && (
        <div className="fp-alert fp-alert-warning" style={{ marginBottom: 24 }}>
          Run legacy/classic caricato dall'archivio. La validazione ufficiale ora usa solo walk-forward; usa il Report Decisionale sotto per leggere i dati storici disponibili.
        </div>
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

          {walkForwardResult.isTop5Aggregate && Array.isArray(walkForwardResult.byCompetition) && (
            <div className="fp-card" style={{ marginBottom: 20 }}>
              <div className="fp-card-head">
                <div className="fp-card-title">Dettaglio walk-forward Top 5</div>
                <span className="fp-badge fp-badge-blue">Campionati separati</span>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table className="fp-table">
                  <thead>
                    <tr>
                      <th>Campionato</th>
                      <th>Bet</th>
                      <th>ROI</th>
                      <th>Win rate</th>
                      <th>Profit/Loss</th>
                      <th>CLV medio</th>
                    </tr>
                  </thead>
                  <tbody>
                    {walkForwardResult.byCompetition.map((row: any) => (
                      <tr key={row.competition}>
                        <td>{row.competition}</td>
                        <td className="fp-mono">{row.betsPlaced}</td>
                        <td className="fp-mono" style={{ color: Number(row.roi ?? 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>{formatPct(row.roi, 2)}</td>
                        <td className="fp-mono">{formatPct(row.winRate, 1)}</td>
                        <td className="fp-mono" style={{ color: Number(row.netProfit ?? 0) >= 0 ? 'var(--green)' : 'var(--red)' }}>{formatMoney(row.netProfit)}</td>
                        <td className="fp-mono">{row.averageClv === null || row.averageClv === undefined ? '-' : formatPct(Number(row.averageClv) * 100, 2)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

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
                <label className="fp-label" htmlFor="backtest-report-market">Mercato</label>
                <select id="backtest-report-market" className="fp-input" value={reportMarket} onChange={(e) => setReportMarket(e.target.value)}>
                  <option value="">Tutti</option>
                  {reportMarketOptions.map((option: string) => (
                    <option key={option} value={option}>{option}</option>
                  ))}
                </select>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label className="fp-label" htmlFor="backtest-report-source">Sorgente quote</label>
                <select id="backtest-report-source" className="fp-input" value={reportSource} onChange={(e) => setReportSource(e.target.value)}>
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

                {(backtestReport.algorithmVersion || backtestReport.rankingVersion || backtestReport.rankingOptimization || backtestReport.walkForwardStability) && (
                  <div className="fp-grid-2" style={{ marginBottom: 18 }}>
                    <div className="fp-card">
                      <div className="fp-card-head">
                        <div className="fp-card-title">Versione algoritmo</div>
                        <span className="fp-badge fp-badge-gray">audit</span>
                      </div>
                      <div style={{ overflowX: 'auto' }}>
                        <table className="fp-table">
                          <tbody>
                            {[
                              ['Algorithm', backtestReport.algorithmVersion ?? currentResult?.algorithmVersion ?? '-'],
                              ['Ranking', backtestReport.rankingVersion ?? currentResult?.rankingVersion ?? '-'],
                              ['Backtest engine', backtestReport.backtestEngineVersion ?? currentResult?.backtestEngineVersion ?? '-'],
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

                    {backtestReport.rankingOptimization && (
                      <div className="fp-card">
                        <div className="fp-card-head">
                          <div className="fp-card-title">Ottimizzazione ranking</div>
                          <span className={`fp-badge ${backtestReport.rankingOptimization.overfittingRisk === 'HIGH' ? 'fp-badge-red' : backtestReport.rankingOptimization.overfittingRisk === 'MEDIUM' ? 'fp-badge-gold' : 'fp-badge-green'}`}>
                            Rischio overfitting: {backtestReport.rankingOptimization.overfittingRisk ?? '-'}
                          </span>
                        </div>
                        <div className="fp-card-body" style={{ display: 'grid', gap: 10 }}>
                          <div className="fp-mono" style={{ fontSize: 12 }}>
                            Best score: {Number(backtestReport.rankingOptimization.bestScore ?? 0).toFixed(2)}
                          </div>
                          {backtestReport.rankingOptimization.rationale && (
                            <div style={{ color: 'var(--text-2)', fontSize: 13 }}>
                              {backtestReport.rankingOptimization.rationale}
                            </div>
                          )}
                          {Array.isArray(backtestReport.rankingOptimization.overfittingWarnings) && backtestReport.rankingOptimization.overfittingWarnings.length > 0 && (
                            <div className="fp-alert fp-alert-warning">
                              {backtestReport.rankingOptimization.overfittingWarnings.join(' ')}
                            </div>
                          )}
                          {backtestReport.rankingOptimization.bestWeights && (
                            <pre className="fp-mono" style={{ whiteSpace: 'pre-wrap', fontSize: 11, margin: 0, color: 'var(--text-2)' }}>
                              {JSON.stringify(backtestReport.rankingOptimization.bestWeights.global ?? backtestReport.rankingOptimization.bestWeights, null, 2)}
                            </pre>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {backtestReport.walkForwardStability && (
                  <div className="fp-card" style={{ marginBottom: 18 }}>
                    <div className="fp-card-head">
                      <div className="fp-card-title">Walk-forward stability</div>
                      <span className="fp-badge fp-badge-blue">fold stability</span>
                    </div>
                    <div className="fp-grid-4 fp-card-body">
                      {[
                        { label: 'Current batte baseline', value: backtestReport.walkForwardStability.currentBeatsBaselineFolds ?? 0, color: 'green' },
                        { label: 'Baseline batte current', value: backtestReport.walkForwardStability.baselineBeatsCurrentFolds ?? 0, color: 'red' },
                        { label: 'Varianza ROI', value: Number(backtestReport.walkForwardStability.roiVariance ?? 0).toFixed(2), color: 'gold' },
                        { label: 'Varianza CLV', value: Number(backtestReport.walkForwardStability.clvVariance ?? 0).toFixed(6), color: 'blue' },
                      ].map((item) => (
                        <div key={item.label} className={`fp-stat c-${item.color}`}>
                          <div className={`fp-stat-val c-${item.color}`}>{String(item.value)}</div>
                          <div className="fp-stat-label">{item.label}</div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {backtestReport.oddsReliability && (
                  <div className="fp-card" style={{ marginBottom: 18 }}>
                    <div className="fp-card-head">
                      <div className="fp-card-title">Affidabilita quote</div>
                      <span className="fp-badge fp-badge-blue">Quote reali vs sintetiche</span>
                    </div>
                    <div className="fp-card-body">
                      {backtestReport.oddsReliability.warning && (
                        <div className="fp-alert fp-alert-warning" style={{ marginBottom: 14 }}>
                          {backtestReport.oddsReliability.warning}
                        </div>
                      )}
                      <div className="fp-grid-4">
                        {[
                          { label: 'ROI quote bookmaker reali', value: backtestReport.oddsReliability.roiRealEurobetOdds === null ? '-' : formatPct(backtestReport.oddsReliability.roiRealEurobetOdds, 2), color: 'green' },
                          { label: 'ROI quote sintetiche', value: backtestReport.oddsReliability.roiSyntheticOdds === null ? '-' : formatPct(backtestReport.oddsReliability.roiSyntheticOdds, 2), color: 'gold' },
                          { label: 'ROI totale', value: formatPct(backtestReport.oddsReliability.roiTotal, 2), color: 'blue' },
                          { label: 'Bet reali / sintetiche', value: `${backtestReport.oddsReliability.betsWithRealEurobetOdds ?? 0} / ${backtestReport.oddsReliability.betsWithSyntheticOdds ?? 0}`, color: 'purple' },
                        ].map((item) => (
                          <div key={item.label} className={`fp-stat c-${item.color}`}>
                            <div className={`fp-stat-val c-${item.color}`}>{item.value}</div>
                            <div className="fp-stat-label">{item.label}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {backtestReport.algorithmComparison && (
                  <div className="fp-card" style={{ marginBottom: 18 }}>
                    <div className="fp-card-head">
                      <div className="fp-card-title">Baseline vs algoritmo attuale</div>
                      <span className="fp-badge fp-badge-gray">ranking</span>
                    </div>
                    <div style={{ overflowX: 'auto' }}>
                      <table className="fp-table">
                        <thead>
                          <tr>
                            <th>Metrica</th>
                            <th>Baseline</th>
                            <th>Attuale</th>
                            {backtestReport.algorithmComparison.tunedResult && <th>Tuned</th>}
                            <th>Delta</th>
                          </tr>
                        </thead>
                        <tbody>
                          {[
                            ['ROI', formatPct(backtestReport.algorithmComparison.baselineResult?.roi, 2), formatPct(backtestReport.algorithmComparison.currentResult?.roi, 2), backtestReport.algorithmComparison.tunedResult ? formatPct(backtestReport.algorithmComparison.tunedResult?.roi, 2) : null, formatPct(backtestReport.algorithmComparison.deltaROI, 2)],
                            ['Profitto', formatMoney(backtestReport.algorithmComparison.baselineResult?.netProfit), formatMoney(backtestReport.algorithmComparison.currentResult?.netProfit), backtestReport.algorithmComparison.tunedResult ? formatMoney(backtestReport.algorithmComparison.tunedResult?.netProfit) : null, formatMoney(backtestReport.algorithmComparison.deltaProfit)],
                            ['CLV medio', backtestReport.algorithmComparison.baselineResult?.averageClv === null ? '-' : formatPct(Number(backtestReport.algorithmComparison.baselineResult?.averageClv ?? 0) * 100, 2), backtestReport.algorithmComparison.currentResult?.averageClv === null ? '-' : formatPct(Number(backtestReport.algorithmComparison.currentResult?.averageClv ?? 0) * 100, 2), backtestReport.algorithmComparison.tunedResult ? (backtestReport.algorithmComparison.tunedResult?.averageClv === null ? '-' : formatPct(Number(backtestReport.algorithmComparison.tunedResult?.averageClv ?? 0) * 100, 2)) : null, backtestReport.algorithmComparison.deltaCLV === null ? '-' : formatPct(Number(backtestReport.algorithmComparison.deltaCLV ?? 0) * 100, 2)],
                            ['Drawdown', formatPct(backtestReport.algorithmComparison.baselineResult?.maxDrawdown, 2), formatPct(backtestReport.algorithmComparison.currentResult?.maxDrawdown, 2), backtestReport.algorithmComparison.tunedResult ? formatPct(backtestReport.algorithmComparison.tunedResult?.maxDrawdown, 2) : null, formatPct(backtestReport.algorithmComparison.deltaDrawdown, 2)],
                          ].map(([label, baseline, current, tuned, delta]) => (
                            <tr key={label}>
                              <td>{label === 'ROI' ? 'Delta ROI' : label}</td>
                              <td className="fp-mono">{baseline}</td>
                              <td className="fp-mono">{current}</td>
                              {backtestReport.algorithmComparison.tunedResult && <td className="fp-mono">{tuned}</td>}
                              <td className="fp-mono">{delta}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}

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

                <div className={`fp-alert ${backtestReport.clv?.available ? 'fp-alert-info' : 'fp-alert-warning'}`}>
                  {backtestReport.clv?.available ? (
                    <>
                      CLV medio bookmaker: <strong>{formatPct(Number(backtestReport.clv.averageClv ?? 0) * 100, 2)}</strong>
                      {' '}su {backtestReport.clv.betsWithClv} bet con quota di chiusura.
                      {' '}CLV positivo: <strong>{formatPct(backtestReport.clv.positiveClvRate, 1)}</strong>.
                    </>
                  ) : (
                    <>
                      CLV non disponibile: {backtestReport.clv?.reason ?? 'mancano quote bookmaker di chiusura prima del kickoff.'}
                    </>
                  )}
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
