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
import GlossaryTerm from '../../features/glossary/GlossaryTerm';

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
const formatSeasonRange = (value: unknown) =>
  String(value ?? '').trim().toLocaleLowerCase('it') === 'all' ? 'Tutte' : String(value ?? '-');

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
        <h1 className="fp-page-title fp-gradient-blue">Backtesting e Validazione</h1>
        <p style={{ fontSize: 12, color: 'var(--text-2)', margin: 0 }}>
          Configura, esegui e interpreta la validazione temporale del modello senza confonderla con la manutenzione.
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
              Il sistema usa solo la validazione walk-forward: avvia prima i Top 5 campionati, guarda ROI e CLV aggregati, poi entra nel dettaglio per campionato e confronta “Solo alta” con “Alta e media”.
            </div>
            <div className="fp-grid-2">
              <div>
                <h3 style={{ marginTop: 0 }}>Scelte operative</h3>
                <p><GlossaryTerm termId="walk-forward">Walk-forward</GlossaryTerm> simula finestre successive di addestramento e test nel tempo. È il flusso ufficiale per ridurre l’overfitting e misurare la stabilità reale.</p>
                <p>“Alta e media” aumenta il campione e misura un volume più realistico. “Solo alta” è più conservativo, ma può produrre un campione troppo piccolo.</p>
                <p>Top 5 campionati esegue Serie A, Premier League, La Liga, Bundesliga e Ligue 1 separatamente, poi mostra aggregato e dettaglio.</p>
                <p>Puoi scegliere se salvare anche le esecuzioni dei singoli campionati: utile per uno storico dettagliato, meno utile se vuoi un archivio pulito.</p>
              </div>
              <div>
                <h3 style={{ marginTop: 0 }}>Come leggere i numeri</h3>
                <p><GlossaryTerm termId="roi">ROI</GlossaryTerm> e profitto/perdita descrivono il risultato economico; il <GlossaryTerm termId="win-rate">win rate</GlossaryTerm> da solo non basta perché quote diverse hanno ritorni diversi.</p>
                <p>Le partite iniziali di addestramento, la finestra di test, il passo e la finestra crescente controllano quanta storia entra nel modello e quanto spesso viene rivalutato.</p>
                <p>Un <GlossaryTerm termId="clv">CLV</GlossaryTerm> positivo indica che la quota ottenuta era migliore della quota di chiusura. Una giocata persa può comunque avere un buon CLV; non giudicare il modello su poche giocate.</p>
                <p>Quote bookmaker reali e quote sintetiche non vanno mischiate: se l’esecuzione usa solo quote sintetiche, il risultato è indicativo. Il confronto tra baseline e algoritmo attuale mostra se le penalità di rischio migliorano davvero.</p>
                <p>L’ottimizzazione dei pesi va letta solo in walk-forward: un ROI alto su poche giocate o con CLV negativo può indicare overfitting e non va promosso in produzione.</p>
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
                Il walk-forward Top 5 può richiedere alcuni minuti. Se scade il tempo, riduci il numero massimo di fold oppure riprova con un singolo campionato.
              </div>
            )}
            {showTop5TuningWarning && (
              <div className="fp-alert fp-alert-warning" style={{ marginBottom: 18 }}>
                Ottimizzazione pesi + Top 5 può essere molto lenta. Se scade il tempo, riduci il numero massimo di fold, disattiva l’ottimizzazione oppure usa un singolo campionato.
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
                <label className="fp-label" htmlFor="backtest-confidence">Filtro affidabilità</label>
                <select id="backtest-confidence" className="fp-input" value={confidenceLevel} onChange={(e) => setConfidenceLevel(e.target.value as ConfidenceMode)}>
                  <option value="medium_and_above">Alta e media</option>
                  <option value="high_only">Solo alta</option>
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
                <label className="fp-label" htmlFor="backtest-initial-train">Partite iniziali di addestramento</label>
                <input id="backtest-initial-train" className="fp-input" value={initialTrainMatches} onChange={(e) => setInitialTrainMatches(e.target.value)} placeholder="Automatico" aria-describedby="backtest-initial-train-help" />
                <small id="backtest-initial-train-help" className="fp-section-text">Storico minimo usato prima della prima verifica.</small>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label className="fp-label" htmlFor="backtest-test-window">Partite per finestra di test</label>
                <input id="backtest-test-window" className="fp-input" value={testWindowMatches} onChange={(e) => setTestWindowMatches(e.target.value)} placeholder="Automatico" aria-describedby="backtest-test-window-help" />
                <small id="backtest-test-window-help" className="fp-section-text">Partite future su cui viene misurato ogni ciclo.</small>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label className="fp-label" htmlFor="backtest-step">Passo tra finestre</label>
                <input id="backtest-step" className="fp-input" value={stepMatches} onChange={(e) => setStepMatches(e.target.value)} placeholder="Automatico" aria-describedby="backtest-step-help" />
                <small id="backtest-step-help" className="fp-section-text">Numero di partite prima di spostare la finestra.</small>
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label className="fp-label" htmlFor="backtest-max-folds">Numero massimo di fold</label>
                <input id="backtest-max-folds" className="fp-input" value={maxFolds} onChange={(e) => setMaxFolds(e.target.value)} placeholder="10" aria-describedby="backtest-max-folds-help" />
                <small id="backtest-max-folds-help" className="fp-section-text">Limita i cicli per controllare durata e volume del test.</small>
              </div>
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 18, color: 'var(--text-2)' }}>
              <input type="checkbox" checked={expandingWindow} onChange={(e) => setExpandingWindow(e.target.checked)} />
              <span>
                <strong style={{ color: 'var(--text)' }}>Finestra di addestramento crescente</strong>
                <span style={{ display: 'block', fontSize: 12 }}>Mantiene tutta la storia precedente invece di usare solo una finestra mobile.</span>
              </span>
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
                  Salva anche le esecuzioni dei singoli campionati
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
              <div className="fp-card-title">Archivio esecuzioni</div>
              <span className="fp-badge fp-badge-gray">{results.length} esecuzioni</span>
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
                          {row.kind === 'walk_forward' ? 'Walk-forward' : 'Validazione storica'}
                        </span>
                      </td>
                      <td style={{ fontWeight: 600 }}>{row.competition}</td>
                      <td className="fp-mono" style={{ color: 'var(--text-2)', fontSize: 12 }}>{formatSeasonRange(row.season_range)}</td>
                      <td className="fp-mono" style={{ color: 'var(--text-2)', fontSize: 12 }}>{formatDate(row.run_at)}</td>
                      <td style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
                        <button
                          className="fp-btn fp-btn-ghost fp-btn-sm"
                          onClick={() => void handleLoadHistorical(row.id)}
                          disabled={maintenanceLoading}
                          title={maintenanceLoading ? 'Attendi il completamento della manutenzione' : 'Apri questa esecuzione'}
                        >
                          Apri
                        </button>
                        <button
                          className="fp-btn fp-btn-ghost fp-btn-sm"
                          onClick={() => handleDeleteRun(Number(row.id))}
                          disabled={maintenanceLoading}
                          title={maintenanceLoading ? 'Attendi il completamento della manutenzione' : 'Elimina questa esecuzione'}
                        >
                          Elimina
                        </button>
                      </td>
                    </tr>
                  ))}
                  {results.length === 0 && (
                    <tr>
                      <td colSpan={5} style={{ textAlign: 'center', color: 'var(--text-3)' }}>
                        Nessuna esecuzione salvata
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
                <div className="fp-card-title">Manutenzione esecuzioni</div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 4 }}>
                  Azioni distruttive e pruning. Usa il filtro competizione a sinistra per limitare l’ambito.
                </div>
              </div>
              <span className="fp-badge fp-badge-red">Pericoloso</span>
            </div>
            <div className="fp-card-body" style={{ display: 'grid', gap: 12 }}>
              <div className="fp-alert fp-alert-warning">
                Elimina o riduci le esecuzioni solo quando serve davvero. Le operazioni non sono reversibili.
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
                  aria-label="Numero di esecuzioni da mantenere"
                />
                <button
                  className="fp-btn fp-btn-ghost fp-btn-sm"
                  onClick={() => void handlePruneRuns(pruneKeepLatest, competition)}
                  disabled={maintenanceLoading}
                  title={maintenanceLoading ? 'Manutenzione già in corso' : 'Mantieni solo le ultime N esecuzioni'}
                >
                  Mantieni ultimi N
                </button>
                <button
                  className="fp-btn fp-btn-red fp-btn-sm"
                  onClick={() => void handleDeleteAllRuns(competition)}
                  disabled={maintenanceLoading}
                  title={maintenanceLoading ? 'Manutenzione già in corso' : 'Elimina tutte le esecuzioni salvate'}
                >
                  Svuota archivio
                </button>
              </div>
              <div style={{ color: 'var(--text-3)', fontSize: 12 }}>
                Mantieni ultime N: conserva solo le esecuzioni più recenti nel perimetro selezionato.
              </div>
            </div>
          </div>
        </div>
      </div>

      {legacyClassicResult && (
        <div className="fp-alert fp-alert-warning" style={{ marginBottom: 24 }}>
          Esecuzione legacy/classic caricata dall’archivio. La validazione ufficiale usa ora solo walk-forward; consulta il report decisionale sotto per leggere i dati storici disponibili.
        </div>
      )}

      {walkForwardResult && (
        <>
          <div className="fp-grid-4" style={{ marginBottom: 16 }}>
            {[
              { label: 'Finestre totali (fold)', value: walkForwardResult.totalFolds ?? 0, color: 'blue' },
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
                      <th>Giocate</th>
                      <th>ROI</th>
                      <th>Percentuale di vittorie</th>
                      <th>Profitto/perdita</th>
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

          <div className="fp-tabs" style={{ marginBottom: 20 }} role="tablist" aria-label="Risultati walk-forward">
            {[
              { id: 'folds', label: 'Finestre' },
              { id: 'stability', label: 'Stabilità' },
            ].map((tab) => (
              <button
                key={tab.id}
                className={`fp-tab${activeTab === tab.id ? ' active' : ''}`}
                onClick={() => setActiveTab(tab.id)}
                role="tab"
                aria-selected={activeTab === tab.id}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {activeTab === 'folds' && Array.isArray(walkForwardResult.folds) && (
            <div className="fp-card" style={{ marginBottom: 24 }}>
              <div className="fp-card-head">
                <div className="fp-card-title">Risultati per finestra</div>
                <span className="fp-badge fp-badge-blue">
                  {walkForwardResult.expandingWindow ? 'Finestra crescente' : 'Finestra mobile'}
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
                      <th>Finestra</th>
                      <th>Periodo</th>
                      <th>Addestramento</th>
                      <th>Test</th>
                      <th>Giocate</th>
                      <th>ROI</th>
                      <th>Percentuale di vittorie</th>
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
                        ['Finestre totali (fold)', walkForwardResult.totalFolds],
                        ['Giocate registrate', walkForwardResult.summary?.totalBetsPlaced ?? 0],
                        ['Giocate vinte', walkForwardResult.summary?.totalBetsWon ?? 0],
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
                  <div className="fp-card-title">Stabilità</div>
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
                          <td style={{ color: 'var(--text-2)' }}>
                            {label === 'Brier medio' ? (
                              <GlossaryTerm termId="brier-score">Brier score medio</GlossaryTerm>
                            ) : label === 'Log loss medio' ? (
                              <GlossaryTerm termId="log-loss">Log loss medio</GlossaryTerm>
                            ) : label}
                          </td>
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
            <div className="fp-card-title">Report decisionale</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {backtestReport?.dataset?.legacyData ? (
                <span className="fp-badge fp-badge-red">Esecuzione legacy</span>
              ) : (
                <span className="fp-badge fp-badge-blue">
                  {backtestReport?.dataset?.filteredBets ?? 0} giocate filtrate
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
                <label className="fp-label" htmlFor="backtest-report-date-from">Data da</label>
                <input id="backtest-report-date-from" className="fp-input" type="date" value={reportDateFrom} onChange={(e) => setReportDateFrom(e.target.value)} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label className="fp-label" htmlFor="backtest-report-date-to">Data a</label>
                <input id="backtest-report-date-to" className="fp-input" type="date" value={reportDateTo} onChange={(e) => setReportDateTo(e.target.value)} />
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
                    { id: 'yield', label: <GlossaryTerm termId="yield">Yield</GlossaryTerm>, value: formatPct(backtestReport.summary?.yieldPct, 2), color: (backtestReport.summary?.yieldPct ?? 0) >= 0 ? 'green' : 'red' },
                    { id: 'roi', label: <GlossaryTerm termId="roi">ROI bankroll</GlossaryTerm>, value: formatPct(backtestReport.summary?.roiPct, 2), color: (backtestReport.summary?.roiPct ?? 0) >= 0 ? 'green' : 'red' },
                    { id: 'win-rate', label: <GlossaryTerm termId="win-rate">Percentuale di vittorie</GlossaryTerm>, value: formatPct(backtestReport.summary?.hitRatePct, 2), color: 'blue' },
                    { id: 'brier', label: <GlossaryTerm termId="brier-score">Brier score</GlossaryTerm>, value: Number(backtestReport.summary?.brierScore ?? 0).toFixed(4), color: 'gold' },
                    { id: 'log-loss', label: <GlossaryTerm termId="log-loss">Log loss</GlossaryTerm>, value: Number(backtestReport.summary?.logLoss ?? 0).toFixed(4), color: 'purple' },
                    { id: 'expected-ev', label: <GlossaryTerm termId="expected-value">EV atteso</GlossaryTerm>, value: formatPct(backtestReport.summary?.expectedEvPct, 2), color: 'blue' },
                    { id: 'realized-ev', label: 'EV realizzato', value: formatPct(backtestReport.summary?.realizedEvPct, 2), color: (backtestReport.summary?.realizedEvPct ?? 0) >= 0 ? 'green' : 'red' },
                    { id: 'ev-capture', label: 'Quota di EV realizzato', value: backtestReport.summary?.evCapturePct === null ? '-' : formatPct(backtestReport.summary?.evCapturePct, 1), color: 'gold' },
                  ].map((item) => (
                    <div key={item.id} className={`fp-stat c-${item.color}`}>
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
                              ['Algoritmo', backtestReport.algorithmVersion ?? currentResult?.algorithmVersion ?? '-'],
                              ['Ranking', backtestReport.rankingVersion ?? currentResult?.rankingVersion ?? '-'],
                              ['Motore backtest', backtestReport.backtestEngineVersion ?? currentResult?.backtestEngineVersion ?? '-'],
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
                            Rischio overfitting: {
                              backtestReport.rankingOptimization.overfittingRisk === 'HIGH'
                                ? 'alto'
                                : backtestReport.rankingOptimization.overfittingRisk === 'MEDIUM'
                                  ? 'medio'
                                  : backtestReport.rankingOptimization.overfittingRisk === 'LOW'
                                    ? 'basso'
                                    : '-'
                            }
                          </span>
                        </div>
                        <div className="fp-card-body" style={{ display: 'grid', gap: 10 }}>
                          <div className="fp-mono" style={{ fontSize: 12 }}>
                            Punteggio migliore: {Number(backtestReport.rankingOptimization.bestScore ?? 0).toFixed(2)}
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
                      <div className="fp-card-title">Stabilità walk-forward</div>
                      <span className="fp-badge fp-badge-blue">stabilità delle finestre</span>
                    </div>
                    <div className="fp-grid-4 fp-card-body">
                      {[
                        { label: 'Modello attuale migliore della baseline', value: backtestReport.walkForwardStability.currentBeatsBaselineFolds ?? 0, color: 'green' },
                        { label: 'Baseline migliore del modello attuale', value: backtestReport.walkForwardStability.baselineBeatsCurrentFolds ?? 0, color: 'red' },
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
                      <div className="fp-card-title">Affidabilità quote</div>
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
                          { label: 'Giocate reali / sintetiche', value: `${backtestReport.oddsReliability.betsWithRealEurobetOdds ?? 0} / ${backtestReport.oddsReliability.betsWithSyntheticOdds ?? 0}`, color: 'purple' },
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
                            {backtestReport.algorithmComparison.tunedResult && <th>Ottimizzato</th>}
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
                              <td>
                                {label === 'ROI' ? 'Delta ROI' : label === 'Drawdown' ? (
                                  <GlossaryTerm termId="drawdown">Drawdown</GlossaryTerm>
                                ) : label}
                              </td>
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
                      <div className="fp-card-title">Fasce di probabilità</div>
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
                      <div className="fp-card-title">
                        <GlossaryTerm termId="yield">Yield</GlossaryTerm> per sorgente
                      </div>
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
                            <th>Giocate</th>
                            <th><GlossaryTerm termId="yield">Yield</GlossaryTerm></th>
                            <th>Percentuale di vittorie</th>
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
                      <div className="fp-card-title">Gruppi per EV, edge e affidabilità</div>
                    </div>
                    <div style={{ overflowX: 'auto' }}>
                      <table className="fp-table">
                        <thead>
                          <tr>
                            <th>Fascia</th>
                            <th>Giocate</th>
                            <th><GlossaryTerm termId="yield">Yield</GlossaryTerm></th>
                            <th>Percentuale di vittorie</th>
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
                      {' '}su {backtestReport.clv.betsWithClv} giocate con quota di chiusura.
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
