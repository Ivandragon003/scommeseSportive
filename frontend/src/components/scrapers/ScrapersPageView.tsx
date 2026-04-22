import React, { useEffect, useMemo, useState } from 'react';
import ProviderStatusSummary from '../common/ProviderStatusSummary';
import {
  runOddsSnapshot,
  runUnderstatImport,
} from '../../utils/api';
import { useScrapersStatus } from '../../hooks/useScrapersStatus';

type ActiveTab = 'understat' | 'odds';
type UnderstatMode = 'single' | 'top5';

const COMPETITIONS = ['Serie A', 'Premier League', 'La Liga', 'Bundesliga', 'Ligue 1'];

const localStyles = `
  .sc-comp-grid { display: flex; flex-wrap: wrap; gap: 8px; }
  .sc-comp {
    padding: 8px 16px; border-radius: var(--radius-pill);
    border: 1px solid var(--border); background: var(--surface2);
    cursor: pointer; font-size: 13px; font-weight: 600;
    color: var(--text-2); transition: all var(--transition);
    font-family: var(--font-sans);
  }
  .sc-comp:hover { border-color: var(--border-hover); color: var(--text); background: var(--surface3); }
  .sc-comp.on  { background: var(--blue-dim); color: var(--blue); border-color: var(--blue-border); box-shadow: 0 0 10px rgba(76,201,240,0.12); }
  .sc-year-grid { display: flex; gap: 12px; }
  .sc-year {
    flex: 1; padding: 16px 10px; border-radius: var(--radius);
    border: 1px solid var(--border); background: var(--surface2);
    cursor: pointer; text-align: center; transition: all var(--transition);
  }
  .sc-year:hover { border-color: var(--border-hover); background: var(--surface3); transform: translateY(-3px); }
  .sc-year.on  { border-color: var(--blue-border); background: var(--blue-dim); box-shadow: 0 0 14px rgba(76,201,240,0.12); }
  .sc-year-num { font-size: 26px; font-weight: 800; color: var(--blue); display: block; font-family: 'DM Mono', monospace; }
  .sc-year-lbl { font-size: 11px; color: var(--text-2); text-transform: uppercase; letter-spacing: 1px; font-weight: 700; margin-top: 3px; }
  .sc-big-btn {
    width: 100%; padding: 16px; border-radius: var(--radius-sm);
    border: 1px solid var(--blue-border); background: var(--blue-dim);
    color: var(--blue); font-size: 14px; font-weight: 700;
    cursor: pointer; transition: all var(--transition);
    display: flex; align-items: center; justify-content: center; gap: 10px;
    font-family: var(--font-sans);
  }
  .sc-big-btn:hover:not(:disabled) {
    background: var(--blue-hover); border-color: var(--blue);
    transform: translateY(-2px); box-shadow: var(--shadow-glow-blue);
  }
  .sc-big-btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none; box-shadow: none; }
  .sc-result-row {
    display: flex; justify-content: space-between; align-items: center;
    padding: 9px 0; border-bottom: 1px solid var(--border); font-size: 13px;
  }
  .sc-result-row:last-child { border-bottom: none; }
  .sc-check {
    display: flex; gap: 10px; align-items: center;
    cursor: pointer; font-size: 13px; font-weight: 600;
    color: var(--text-2); margin-bottom: 10px;
  }
  .sc-check:hover { color: var(--text); }
  .sc-check input { accent-color: var(--blue); width: 16px; height: 16px; cursor: pointer; }
`;

const formatDate = (iso: string) => {
  try {
    return new Date(iso).toLocaleString('it-IT', {
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
};

const formatFullDate = (iso?: string | null) => {
  if (!iso) return 'n/d';
  try {
    return new Date(iso).toLocaleString('it-IT', {
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(iso);
  }
};

const formatDuration = (totalSec: number) => {
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}m ${String(s).padStart(2, '0')}s`;
};

const getPipelineTone = (status: 'healthy' | 'degraded' | 'unhealthy' | 'loading' | 'unknown') => {
  if (status === 'healthy') return 'fp-badge-green';
  if (status === 'degraded') return 'fp-badge-gold';
  if (status === 'unhealthy') return 'fp-badge-red';
  if (status === 'loading') return 'fp-badge-blue';
  return 'fp-badge-gray';
};

const getPipelineLabel = (status: 'healthy' | 'degraded' | 'unhealthy' | 'loading' | 'unknown') => {
  if (status === 'healthy') return 'Sano';
  if (status === 'degraded') return 'Parziale';
  if (status === 'unhealthy') return 'Rotto';
  if (status === 'loading') return 'In corso';
  return 'In attesa';
};

export default function ScrapersPageView() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('understat');
  const {
    scraperStatus,
    understatInfo,
    systemHealth,
    providerHealth,
    systemMetrics,
    remainingReq,
    oddsLastUpdatedAt,
    oddsMatches,
    applyOddsState,
    refreshQuotePipeline,
    refreshProviderOnly,
  } = useScrapersStatus();

  const [competition, setCompetition] = useState('Serie A');
  const [yearsBack, setYearsBack] = useState(1);
  const [includeMatchDetails, setIncludeMatchDetails] = useState(true);
  const [importPlayers, setImportPlayers] = useState(true);
  const [includeSofaScoreSupplemental, setIncludeSofaScoreSupplemental] = useState(true);
  const [forceRefresh, setForceRefresh] = useState(false);
  const [understatLoading, setUnderstatLoading] = useState(false);
  const [understatStartedAt, setUnderstatStartedAt] = useState<number | null>(null);
  const [understatElapsedSec, setUnderstatElapsedSec] = useState(0);
  const [activeUnderstatMode, setActiveUnderstatMode] = useState<UnderstatMode>('single');
  const [understatResult, setUnderstatResult] = useState<any>(null);
  const [understatError, setUnderstatError] = useState<string | null>(null);

  const [oddsLoading, setOddsLoading] = useState(false);
  const [providerCheckLoading, setProviderCheckLoading] = useState(false);
  const [oddsError, setOddsError] = useState<string | null>(null);
  const [providerCheckError, setProviderCheckError] = useState<string | null>(null);

  useEffect(() => {
    if (!understatLoading || !understatStartedAt) return;
    const interval = setInterval(() => {
      setUnderstatElapsedSec(Math.max(0, Math.floor((Date.now() - understatStartedAt) / 1000)));
    }, 1000);
    return () => clearInterval(interval);
  }, [understatLoading, understatStartedAt]);

  const handleUnderstat = async (mode: UnderstatMode) => {
    setUnderstatLoading(true);
    setActiveUnderstatMode(mode);
    setUnderstatStartedAt(Date.now());
    setUnderstatElapsedSec(0);
    setUnderstatError(null);
    setUnderstatResult(null);
    try {
      const res = await runUnderstatImport({
        mode,
        competition,
        yearsBack,
        importPlayers,
        includeMatchDetails,
        includeSofaScoreSupplemental,
        forceRefresh,
      });
      setUnderstatResult(res.data ?? null);
    } catch (e: any) {
      setUnderstatError(e.response?.data?.error ?? e.message);
    }
    setUnderstatLoading(false);
    setUnderstatStartedAt(null);
  };

  const handleOdds = async () => {
    setOddsLoading(true);
    setOddsError(null);
    try {
      const res = await runOddsSnapshot({ competition: 'Serie A', markets: ['h2h', 'totals'] });
      applyOddsState(res.data);
      await refreshQuotePipeline({ force: true });
    } catch (e: any) {
      setOddsError(e.response?.data?.error ?? e.message);
    }
    setOddsLoading(false);
  };

  const handleVerifyProvider = async () => {
    setProviderCheckLoading(true);
    setProviderCheckError(null);
    try {
      await refreshProviderOnly({ force: true });
    } catch (e: any) {
      setProviderCheckError(e.response?.data?.error ?? e.message);
    } finally {
      setProviderCheckLoading(false);
    }
  };

  const estimateUnderstatSeconds = useMemo(() => {
    const competitionsCount = activeUnderstatMode === 'top5' ? 5 : 1;
    const detailFactor = includeMatchDetails ? 85 : 45;
    return Math.max(45, competitionsCount * yearsBack * detailFactor);
  }, [activeUnderstatMode, includeMatchDetails, yearsBack]);

  const lastUpdateFailed = Boolean(scraperStatus?.lastUpdate && scraperStatus?.lastUpdate?.success === false);
  const lastUpdateSucceeded = Boolean(scraperStatus?.lastUpdate && scraperStatus?.lastUpdate?.success === true);
  const understatScheduler = scraperStatus?.understatScheduler ?? null;
  const oddsScheduler = scraperStatus?.oddsSnapshotScheduler ?? null;
  const learningScheduler = scraperStatus?.learningReviewScheduler ?? null;
  const effectiveProviderHealth = providerHealth ?? {
    status: 'unknown',
    primaryProvider: 'eurobet',
    fallbackProvider: null,
    activeProvider: null,
    oddsSource: null,
    fallbackReason: null,
    providerHealth: {},
    fetchedAt: null,
    matchesWithBaseOdds: 0,
    matchesWithExtendedGroups: 0,
    freshnessMinutes: null,
    warnings: [],
    warningCount: 0,
    isMerged: false,
    lastSmokeRun: null,
  };
  const effectiveSystemMetrics = systemMetrics ?? {
    provider: {
      avgScrapeLatencyMs: null,
    },
    trends: {
      errorRuns: 0,
    },
  };
  const understatPipelineStatus: 'healthy' | 'degraded' | 'unhealthy' | 'loading' | 'unknown' = scraperStatus?.isUpdating
    ? 'loading'
    : lastUpdateFailed
      ? 'unhealthy'
      : lastUpdateSucceeded
        ? 'healthy'
        : 'unknown';
  const quotePipelineStatus = effectiveProviderHealth.status === 'healthy'
    ? 'healthy'
    : effectiveProviderHealth.status === 'degraded'
      ? 'degraded'
      : effectiveProviderHealth.status === 'unhealthy'
        ? 'unhealthy'
        : 'unknown';

  return (
    <>
      <style>{localStyles}</style>
      <div style={{ padding: '40px 32px', minHeight: '100vh' }}>
        <div style={{ marginBottom: 32 }}>
          <h1 className="fp-page-title fp-gradient-green">Dati e Provider</h1>
          <p style={{ fontSize: 12, color: 'var(--text-2)', margin: 0, fontFamily: 'DM Mono, monospace' }}>
            Due pipeline separate: dati match da Understat e quote da Eurobet con fallback tecnico solo interno
          </p>
        </div>

        <div className="fp-grid-2" style={{ marginBottom: 24 }}>
          <div className="fp-card">
            <div className="fp-card-head">
              <div>
                <div className="fp-card-title">Pipeline dati Understat</div>
                <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 6 }}>
                  Import match e statistiche base per le analisi.
                </div>
              </div>
              <span className={`fp-badge ${getPipelineTone(understatPipelineStatus)}`}>
                {getPipelineLabel(understatPipelineStatus)}
              </span>
            </div>
            <div className="fp-card-body">
              <div className="fp-meta-list">
                <div className="fp-meta-row">
                  <span className="fp-meta-label">Ultimo aggiornamento</span>
                  <strong className="fp-meta-value">{formatFullDate(scraperStatus?.lastUpdate?.at)}</strong>
                </div>
                <div className="fp-meta-row">
                  <span className="fp-meta-label">Prossimo run</span>
                  <strong className="fp-meta-value">{formatFullDate(understatScheduler?.nextRunAt)}</strong>
                </div>
                <div className="fp-meta-row">
                  <span className="fp-meta-label">Messaggio</span>
                  <strong className="fp-meta-value">{scraperStatus?.lastUpdate?.message ?? 'n/d'}</strong>
                </div>
              </div>
            </div>
          </div>

          <div className="fp-card">
            <div className="fp-card-head">
              <div>
                <div className="fp-card-title">Pipeline quote</div>
                <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 6 }}>
                  Eurobet primario, con fallback tecnico e smoke per diagnosi.
                </div>
              </div>
              <span className={`fp-badge ${getPipelineTone(quotePipelineStatus)}`}>
                {getPipelineLabel(quotePipelineStatus)}
              </span>
            </div>
            <div className="fp-card-body">
              <div className="fp-meta-list">
                <div className="fp-meta-row">
                  <span className="fp-meta-label">Provider attivo</span>
                  <strong className="fp-meta-value">{effectiveProviderHealth.activeProvider ?? 'n/d'}</strong>
                </div>
                <div className="fp-meta-row">
                  <span className="fp-meta-label">Freshness</span>
                  <strong className="fp-meta-value">
                    {effectiveProviderHealth.freshnessMinutes !== null ? `${effectiveProviderHealth.freshnessMinutes}m` : 'n/d'}
                  </strong>
                </div>
                <div className="fp-meta-row">
                  <span className="fp-meta-label">Ultimo smoke</span>
                  <strong className="fp-meta-value">{formatFullDate(effectiveProviderHealth.lastSmokeRun?.generatedAt)}</strong>
                </div>
              </div>
            </div>
          </div>
        </div>

        {scraperStatus && (
          <div className="fp-card" style={{ marginBottom: 24, padding: 16, background: 'var(--bg-1)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ fontSize: 18 }}>
                {scraperStatus.isUpdating ? '⏳' : lastUpdateFailed ? '⚠️' : '✅'}
              </div>
              <div>
                <div style={{ fontWeight: 600, color: 'var(--text-1)' }}>
                  {scraperStatus.isUpdating
                    ? 'Aggiornamento automatico in corso...'
                    : lastUpdateFailed
                      ? 'Ultimo aggiornamento con errore'
                      : lastUpdateSucceeded
                        ? 'Sistema aggiornato'
                        : 'Nessun aggiornamento registrato'}
                </div>
                {scraperStatus.lastUpdate && (
                  <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4 }}>
                    Ultimo aggiornamento: {formatDate(scraperStatus.lastUpdate.at)} - {scraperStatus.lastUpdate.message}
                  </div>
                )}
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                  Sync notturna: {understatScheduler?.enabled
                    ? `ogni giorno alle ${understatScheduler?.time ?? '01:00'} | prossimo run ${formatFullDate(understatScheduler?.nextRunAt)}`
                    : 'disabilitata'}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                  Provider quote: {oddsScheduler?.enabled
                    ? `alle ${oddsScheduler?.time ?? '02:15'} | prossimo run ${formatFullDate(oddsScheduler?.nextRunAt)}`
                    : 'disabilitato'}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                  Learning review: {learningScheduler?.enabled
                    ? `alle ${learningScheduler?.time ?? '03:00'} | prossimo run ${formatFullDate(learningScheduler?.nextRunAt)}`
                    : 'disabilitata'}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                  Provider quote: primario {effectiveProviderHealth.primaryProvider}
                  {' | '}attivo {effectiveProviderHealth.activeProvider ?? 'n/d'}
                  {' | '}freshness {effectiveProviderHealth.freshnessMinutes ?? 'n/d'}m
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="fp-tabs" style={{ marginBottom: 24 }}>
          <button className={`fp-tab${activeTab === 'understat' ? ' active' : ''}`} onClick={() => setActiveTab('understat')}>
            📊 Understat
            <span className="fp-badge fp-badge-green" style={{ fontSize: 10, marginLeft: 6 }}>Fonte primaria</span>
          </button>
          <button className={`fp-tab${activeTab === 'odds' ? ' active' : ''}`} onClick={() => setActiveTab('odds')}>
            📈 Provider quote
          </button>
        </div>

        {activeTab === 'understat' && (
          <div className="fp-card">
            <div className="fp-card-head">
              <div>
                <div className="fp-card-title">📥 Download da Understat</div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>
                  Match, xG, tiri, cartellini e giocatori da Understat. SofaScore completa possesso, falli, corner e arbitro solo dove mancanti.
                </div>
              </div>
            </div>
            <div className="fp-card-body">
              <div style={{ marginBottom: 24 }}>
                <label className="fp-label" style={{ display: 'block', marginBottom: 10 }}>Campionato</label>
                <div className="sc-comp-grid">
                  {COMPETITIONS.map((item) => (
                    <button key={item} className={`sc-comp${competition === item ? ' on' : ''}`} onClick={() => setCompetition(item)}>
                      {item}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ marginBottom: 24 }}>
                <label className="fp-label" style={{ display: 'block', marginBottom: 10 }}>Stagioni da scaricare</label>
                <div className="sc-year-grid">
                  {[1, 2, 3].map((value) => (
                    <button key={value} className={`sc-year${yearsBack === value ? ' on' : ''}`} onClick={() => setYearsBack(value)}>
                      <span className="sc-year-num">{value}</span>
                      <span className="sc-year-lbl">{value === 1 ? 'stagione' : 'stagioni'}</span>
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ marginBottom: 24, padding: '16px 20px', background: 'var(--surface2)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)' }}>
                <label className="fp-label" style={{ display: 'block', marginBottom: 12 }}>Opzioni import</label>
                <label className="sc-check">
                  <input type="checkbox" checked={includeMatchDetails} onChange={(e) => setIncludeMatchDetails(e.target.checked)} />
                  Importa dettagli match completi
                </label>
                <label className="sc-check">
                  <input type="checkbox" checked={importPlayers} onChange={(e) => setImportPlayers(e.target.checked)} />
                  Aggiorna anche statistiche giocatori
                </label>
                <label className="sc-check">
                  <input type="checkbox" checked={includeSofaScoreSupplemental} onChange={(e) => setIncludeSofaScoreSupplemental(e.target.checked)} />
                  Completa referee, possesso, falli e corner con SofaScore
                </label>
                <label className="sc-check" style={{ marginBottom: 0 }}>
                  <input type="checkbox" checked={forceRefresh} onChange={(e) => setForceRefresh(e.target.checked)} />
                  Forza refresh completo
                </label>
                <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-3)' }}>
                  Understat non viene sostituito: SofaScore integra solo i campi mancanti e non tocca xG, tiri o risultati.
                </div>
              </div>

              <div style={{ display: 'grid', gap: 10 }}>
                <button className="sc-big-btn" onClick={() => handleUnderstat('single')} disabled={understatLoading}>
                  {understatLoading ? '⏳ Download in corso...' : `⬇ Scarica solo ${competition}`}
                </button>
                <button className="sc-big-btn" onClick={() => handleUnderstat('top5')} disabled={understatLoading}>
                  {understatLoading ? '⏳ Download in corso...' : '⬇ Scarica Top-5 insieme'}
                </button>
              </div>

              {understatLoading && (
                <div className="fp-alert fp-alert-info" style={{ marginTop: 14 }}>
                  Aggiornamento dati Understat in corso... trascorso <strong>{formatDuration(understatElapsedSec)}</strong> |
                  stima residua <strong>~{formatDuration(Math.max(0, estimateUnderstatSeconds - understatElapsedSec))}</strong>
                </div>
              )}

              {understatError && (
                <div className="fp-alert fp-alert-danger" style={{ marginTop: 16 }}>
                  ⚠ Errore: {understatError}
                </div>
              )}

              {understatResult && (
                <div className={`fp-alert ${understatResult.alreadyRunning || understatResult.inProgress || understatResult.isUpToDate ? 'fp-alert-info' : 'fp-alert-success'}`} style={{ marginTop: 16 }}>
                  <div style={{ fontWeight: 800, marginBottom: 12, fontSize: 14 }}>
                    {understatResult.alreadyRunning || understatResult.inProgress
                      ? 'Import già in corso'
                      : understatResult.isUpToDate
                        ? '✓ Database già aggiornato'
                        : '✓ Import completato con successo'}
                  </div>
                  {understatResult.message && (
                    <div style={{ marginBottom: 12, color: 'inherit', opacity: 0.82 }}>
                      {understatResult.message}
                    </div>
                  )}
                  {[
                    ['Modalità', understatResult.mode ?? understatResult.activeImport?.mode],
                    ['Campionati', understatResult.competitions?.join(', ') ?? understatResult.activeImport?.competitions?.join(', ')],
                    ['Stagioni', understatResult.seasons?.join(', ') ?? understatResult.activeImport?.seasons?.join(', ')],
                    ['Avviato alle', understatResult.activeImport?.startedAt ? new Date(understatResult.activeImport.startedAt).toLocaleString('it-IT') : undefined],
                    ['Nuove partite importate', understatResult.alreadyRunning || understatResult.inProgress ? undefined : understatResult.newMatchesImported],
                    ['Partite future importate', understatResult.alreadyRunning || understatResult.inProgress ? undefined : understatResult.upcomingMatchesImported],
                    ['Partite aggiornate', understatResult.alreadyRunning || understatResult.inProgress ? undefined : understatResult.existingMatchesUpdated],
                    ['Match completati con SofaScore', understatResult.alreadyRunning || understatResult.inProgress ? undefined : understatResult.sofaScoreSupplemental?.updatedMatches],
                    ['Match chiusi per medie squadra', understatResult.alreadyRunning || understatResult.inProgress ? undefined : understatResult.sofaScoreSupplemental?.updatedCompletedMatches],
                    ['Arbitri aggiornati da SofaScore', understatResult.alreadyRunning || understatResult.inProgress ? undefined : understatResult.sofaScoreSupplemental?.updatedReferees],
                    ['Squadre create', understatResult.alreadyRunning || understatResult.inProgress ? undefined : understatResult.teamsCreated],
                    ['Giocatori aggiornati', understatResult.alreadyRunning || understatResult.inProgress ? undefined : understatResult.playersUpdated],
                    ['Squadre ricalcolate', understatResult.alreadyRunning || understatResult.inProgress ? undefined : understatResult.teamsRecomputed],
                  ].map(([label, value]) => value !== undefined && (
                    <div key={String(label)} className="sc-result-row">
                      <span style={{ color: 'inherit', opacity: 0.75 }}>{label}</span>
                      <strong>{String(value ?? '—')}</strong>
                    </div>
                  ))}
                </div>
              )}

              {understatInfo && (
                <div className="fp-card" style={{ marginTop: 16, background: 'var(--surface2)' }}>
                  <div className="fp-card-head">
                    <div className="fp-card-title">Copertura sorgente</div>
                  </div>
                  <div className="fp-card-body">
                    {[
                      ['Campionati supportati', Array.isArray(understatInfo.competitions) ? understatInfo.competitions.join(', ') : 'n/d'],
                      ['Ultimi import nel DB', understatInfo.dbLastImport ? Object.entries(understatInfo.dbLastImport).map(([key, value]) => `${key}: ${String(value)}`).join(' | ') : 'n/d'],
                      ['Note', understatInfo.note ?? 'n/d'],
                    ].map(([label, value]) => (
                      <div key={String(label)} className="sc-result-row">
                        <span style={{ color: 'var(--text-2)' }}>{label}</span>
                        <strong style={{ textAlign: 'right', maxWidth: '70%' }}>{String(value)}</strong>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'odds' && (
          <div className="fp-card">
            <div className="fp-card-head">
              <div>
                <div className="fp-card-title">📈 Provider quote</div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>
                  Eurobet resta il provider primario. Il provider secondario viene usato solo come fallback tecnico e diagnostico.
                </div>
              </div>
              <span className={`fp-badge ${remainingReq !== null && remainingReq > 100 ? 'fp-badge-green' : remainingReq !== null ? 'fp-badge-gold' : 'fp-badge-gray'}`}>
                {remainingReq !== null ? `${remainingReq}/500 richieste fallback` : 'Fallback requests: n/d'}
              </span>
            </div>
            <div className="fp-card-body">
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, marginBottom: 16 }}>
                <div className="fp-stat c-blue">
                  <div className="fp-stat-val c-blue">
                    {effectiveProviderHealth.status === 'healthy'
                      ? 'OK'
                      : effectiveProviderHealth.status === 'degraded'
                        ? 'Parziale'
                        : effectiveProviderHealth.status === 'unhealthy'
                          ? 'Errore'
                          : 'n/d'}
                  </div>
                  <div className="fp-stat-label">Stato Provider</div>
                </div>
                <div className="fp-stat c-gold">
                  <div className="fp-stat-val c-gold">
                    {effectiveProviderHealth.freshnessMinutes !== null ? `${effectiveProviderHealth.freshnessMinutes}m` : 'n/d'}
                  </div>
                  <div className="fp-stat-label">Freshness Provider</div>
                </div>
                <div className="fp-stat c-green">
                  <div className="fp-stat-val c-green">
                    {effectiveSystemMetrics.provider.avgScrapeLatencyMs !== null
                      ? formatDuration(effectiveSystemMetrics.provider.avgScrapeLatencyMs)
                      : 'n/d'}
                  </div>
                  <div className="fp-stat-label">Latenza Media</div>
                </div>
                <div className="fp-stat c-red">
                  <div className="fp-stat-val c-red">{effectiveSystemMetrics.trends.errorRuns}</div>
                  <div className="fp-stat-label">Run in Errore</div>
                </div>
              </div>

              <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
                <button className="sc-big-btn" onClick={handleOdds} disabled={oddsLoading}>
                  {oddsLoading ? '⏳ Scaricamento provider...' : '⬇ Scarica quote provider'}
                </button>
                <button className="sc-big-btn" onClick={handleVerifyProvider} disabled={providerCheckLoading}>
                  {providerCheckLoading ? '⏳ Verifica provider...' : '🩺 Verifica provider'}
                </button>
              </div>

              <div style={{ marginTop: 16 }}>
                <ProviderStatusSummary providerHealth={effectiveProviderHealth} />
              </div>

              {oddsLastUpdatedAt && (
                <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-2)', fontFamily: 'DM Mono, monospace' }}>
                  Ultimo aggiornamento: <strong style={{ color: 'var(--text)' }}>{formatDate(oddsLastUpdatedAt)}</strong>
                </div>
              )}

              {systemHealth?.issues?.length > 0 && (
                <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
                  {systemHealth.issues.slice(0, 3).map((issue: any, index: number) => (
                    <div
                      key={`${issue.scope}-${index}`}
                      className={issue.severity === 'error' ? 'fp-alert fp-alert-danger' : 'fp-alert fp-alert-warning'}
                    >
                      <strong>{issue.scope}</strong>: {issue.message}
                    </div>
                  ))}
                </div>
              )}

              {providerCheckError && (
                <div className="fp-alert fp-alert-danger" style={{ marginTop: 16 }}>
                  ⚠ {providerCheckError}
                </div>
              )}

              {oddsError && (
                <div className="fp-alert fp-alert-danger" style={{ marginTop: 16 }}>
                  ⚠ {oddsError}
                </div>
              )}

              {!oddsError && !oddsLoading && oddsMatches.length > 0 && (
                <>
                  <div className="fp-alert fp-alert-success" style={{ marginTop: 16 }}>
                    ✓ Quote provider aggiornate: <strong>{oddsMatches.length}</strong> partite trovate.
                  </div>
                  <div style={{ marginTop: 16, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
                    <div style={{
                      padding: '12px 16px',
                      fontWeight: 700,
                      fontSize: 11,
                      textTransform: 'uppercase',
                      letterSpacing: '1.2px',
                      background: 'var(--surface2)',
                      color: 'var(--text-2)',
                      borderBottom: '1px solid var(--border)',
                    }}>
                      Partite scaricate ({oddsMatches.length})
                    </div>
                    <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                      {oddsMatches.map((match: any, index: number) => (
                        <div
                          key={`${match.homeTeam}-${match.awayTeam}-${match.commenceTime}-${index}`}
                          className="sc-result-row"
                          style={{ padding: '12px 16px' }}
                        >
                          <strong style={{ fontSize: 13 }}>{match.homeTeam} — {match.awayTeam}</strong>
                          <span style={{ color: 'var(--text-2)', fontSize: 12, fontFamily: 'DM Mono, monospace' }}>
                            {formatDate(String(match.commenceTime ?? ''))}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
