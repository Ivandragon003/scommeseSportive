import { useEffect, useMemo, useState } from 'react';
import ProviderStatusSummary from '../common/ProviderStatusSummary';
import {
  runFootballDataSync,
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
  .sc-comp.on  { background: var(--primary-dim); color: var(--primary); border-color: var(--primary-border); }
  .sc-year-grid { display: flex; gap: 12px; }
  .sc-year {
    flex: 1; padding: 16px 10px; border-radius: var(--radius);
    border: 1px solid var(--border); background: var(--surface2);
    cursor: pointer; text-align: center; transition: all var(--transition);
  }
  .sc-year:hover { border-color: var(--border-hover); background: var(--surface3); }
  .sc-year.on  { border-color: var(--primary-border); background: var(--primary-dim); }
  .sc-year-num { font-size: 26px; font-weight: 800; color: var(--primary); display: block; font-family: var(--font-mono); }
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
    border-color: var(--blue);
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

const formatMilliseconds = (milliseconds: number) => {
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  return `${(milliseconds / 1000).toFixed(1)} s`;
};

const formatFreshness = (minutes: number | null | undefined) => {
  if (minutes === null || minutes === undefined || !Number.isFinite(minutes)) return 'n/d';
  if (minutes < 60) return `${Math.max(0, Math.round(minutes))} min`;
  if (minutes < 1440) return `${(minutes / 60).toFixed(1)} h`;
  return `${(minutes / 1440).toFixed(1)} gg`;
};

const getSeasonStartYears = (count: number, now = new Date()) => {
  const currentStart = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  return Array.from({ length: Math.max(1, count) }, (_, index) => currentStart - index);
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
  const [forceRefresh, setForceRefresh] = useState(false);
  const [understatLoading, setUnderstatLoading] = useState(false);
  const [understatStartedAt, setUnderstatStartedAt] = useState<number | null>(null);
  const [understatElapsedSec, setUnderstatElapsedSec] = useState(0);
  const [activeUnderstatMode, setActiveUnderstatMode] = useState<UnderstatMode>('single');
  const [understatResult, setUnderstatResult] = useState<any>(null);
  const [understatError, setUnderstatError] = useState<string | null>(null);
  const [footballDataLoading, setFootballDataLoading] = useState(false);
  const [footballDataResult, setFootballDataResult] = useState<any>(null);
  const [footballDataError, setFootballDataError] = useState<string | null>(null);

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
        forceRefresh,
      });
      setUnderstatResult(res.data ?? null);
    } catch (e: any) {
      setUnderstatError(e.response?.data?.error ?? e.message);
    }
    setUnderstatLoading(false);
    setUnderstatStartedAt(null);
  };

  const handleFootballData = async () => {
    setFootballDataLoading(true);
    setFootballDataError(null);
    setFootballDataResult(null);
    try {
      const result = await runFootballDataSync({
        competitions: [competition],
        seasonStartYears: getSeasonStartYears(yearsBack),
        keepSeasons: 4,
        prune: true,
        recomputeAverages: true,
      });
      setFootballDataResult(result);
    } catch (error: any) {
      setFootballDataError(error.response?.data?.error ?? error.message);
    } finally {
      setFootballDataLoading(false);
    }
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
  const effectiveProviderHealth = providerHealth ?? {
    status: 'unknown',
    primaryProvider: 'odds_api',
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
          <h1 className="fp-page-title fp-gradient-blue">Dati e Provider</h1>
          <p style={{ fontSize: 12, color: 'var(--text-2)', margin: 0 }}>
            Stato operativo delle fonti dati, integrazioni e quote usate dall’applicazione.
          </p>
        </div>

        <div className="fp-grid-2" style={{ marginBottom: 24 }}>
          <div className="fp-card">
            <div className="fp-card-head">
              <div>
                <div className="fp-card-title">Pipeline dati Understat</div>
                <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 6 }}>
                  Import partite e statistiche di base per le analisi.
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
                  <span className="fp-meta-label">Prossima esecuzione</span>
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
                  Stato tecnico del provider quote configurato.
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
                  <span className="fp-meta-label">Freschezza dei dati</span>
                  <strong className="fp-meta-value">
                    {formatFreshness(effectiveProviderHealth.freshnessMinutes)}
                  </strong>
                </div>
              </div>
            </div>
          </div>
        </div>

        {scraperStatus && (
          <div className="fp-card" style={{ marginBottom: 24, padding: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
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
                  Aggiornamento notturno: {understatScheduler?.enabled
                    ? `ogni giorno alle ${understatScheduler?.time ?? '01:00'} | prossima esecuzione ${formatFullDate(understatScheduler?.nextRunAt)}`
                    : 'disabilitata'}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                  Provider quote: {oddsScheduler?.enabled
                    ? `alle ${oddsScheduler?.time ?? '02:15'} | prossima esecuzione ${formatFullDate(oddsScheduler?.nextRunAt)}`
                    : 'disabilitato'}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                  Provider quote: primario {effectiveProviderHealth.primaryProvider}
                  {' | '}attivo {effectiveProviderHealth.activeProvider ?? 'n/d'}
                  {' | '}freschezza {formatFreshness(effectiveProviderHealth.freshnessMinutes)}
                </div>
              </div>
            </div>
          </div>
        )}

        <div className="fp-tabs" style={{ marginBottom: 24 }} role="tablist" aria-label="Strumenti di aggiornamento dati">
          <button
            className={`fp-tab${activeTab === 'understat' ? ' active' : ''}`}
            onClick={() => setActiveTab('understat')}
            role="tab"
            aria-selected={activeTab === 'understat'}
          >
            Understat
            <span className="fp-badge fp-badge-green" style={{ fontSize: 10, marginLeft: 6 }}>Fonte primaria</span>
          </button>
          <button
            className={`fp-tab${activeTab === 'odds' ? ' active' : ''}`}
            onClick={() => setActiveTab('odds')}
            role="tab"
            aria-selected={activeTab === 'odds'}
          >
            Provider quote
          </button>
        </div>

        {activeTab === 'understat' && (
          <div className="fp-card">
            <div className="fp-card-head">
              <div>
                <div className="fp-card-title">Aggiornamento da Understat</div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>
                  Understat resta la fonte primaria per partite, xG, tiri e giocatori.
                </div>
              </div>
            </div>
            <div className="fp-card-body">
              <div style={{ marginBottom: 24 }}>
                <label className="fp-label" style={{ display: 'block', marginBottom: 10 }}>Campionato</label>
                <div className="sc-comp-grid">
                  {COMPETITIONS.map((item) => (
                    <button
                      key={item}
                      className={`sc-comp${competition === item ? ' on' : ''}`}
                      onClick={() => setCompetition(item)}
                      aria-pressed={competition === item}
                    >
                      {item}
                    </button>
                  ))}
                </div>
              </div>

              <div style={{ marginBottom: 24 }}>
                <label className="fp-label" style={{ display: 'block', marginBottom: 10 }}>Stagioni da scaricare</label>
                <div className="sc-year-grid">
                  {[1, 2, 3].map((value) => (
                    <button
                      key={value}
                      className={`sc-year${yearsBack === value ? ' on' : ''}`}
                      onClick={() => setYearsBack(value)}
                      aria-pressed={yearsBack === value}
                    >
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
                <label className="sc-check" style={{ marginBottom: 0 }}>
                  <input type="checkbox" checked={forceRefresh} onChange={(e) => setForceRefresh(e.target.checked)} />
                  Forza refresh completo
                </label>
                <div style={{ marginTop: 10, fontSize: 11, color: 'var(--text-3)' }}>
                  L’import non riattiva fonti legacy e mantiene Understat come origine primaria.
                </div>
              </div>

              <div style={{ display: 'grid', gap: 10 }}>
                <button className="sc-big-btn" onClick={() => handleUnderstat('single')} disabled={understatLoading}>
                  {understatLoading ? 'Download in corso...' : `Scarica solo ${competition}`}
                </button>
                <button className="sc-big-btn" onClick={() => handleUnderstat('top5')} disabled={understatLoading}>
                  {understatLoading ? 'Download in corso...' : 'Scarica Top-5 insieme'}
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
                  Errore: {understatError}
                </div>
              )}

              {understatResult && (
                <div className={`fp-alert ${understatResult.alreadyRunning || understatResult.inProgress || understatResult.isUpToDate ? 'fp-alert-info' : 'fp-alert-success'}`} style={{ marginTop: 16 }}>
                  <div style={{ fontWeight: 800, marginBottom: 12, fontSize: 14 }}>
                    {understatResult.alreadyRunning || understatResult.inProgress
                      ? 'Import già in corso'
                      : understatResult.isUpToDate
                        ? 'Database già aggiornato'
                        : 'Import completato con successo'}
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

              <section className="fp-info" style={{ marginTop: 18 }} aria-labelledby="football-data-title">
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
                  <div>
                    <h2 id="football-data-title" style={{ margin: 0, fontSize: 15 }}>
                      Integrazione campi mancanti
                    </h2>
                    <p style={{ margin: '5px 0 0', color: 'var(--text-2)' }}>
                      football-data.co.uk completa solo valori assenti per tiri, tiri in porta,
                      falli, corner, cartellini e arbitro. I dati Understat esistenti non vengono
                      sovrascritti.
                    </p>
                  </div>
                  <span className="fp-badge fp-badge-gray">Fonte supplementare</span>
                </div>
                <button
                  className="fp-btn fp-btn-ghost"
                  style={{ marginTop: 14 }}
                  onClick={handleFootballData}
                  disabled={footballDataLoading || understatLoading}
                >
                  {footballDataLoading ? 'Integrazione in corso...' : 'Integra statistiche mancanti'}
                </button>

                {footballDataError && (
                  <div className="fp-alert fp-alert-danger" style={{ marginTop: 12 }}>
                    Integrazione non completata: {footballDataError}
                  </div>
                )}

                {footballDataResult && (
                  <div className="fp-alert fp-alert-success" style={{ marginTop: 12 }}>
                    <strong>Integrazione completata</strong>
                    <div className="fp-meta-list" style={{ marginTop: 10 }}>
                      <div className="fp-meta-row">
                        <span className="fp-meta-label">Righe CSV lette</span>
                        <span className="fp-meta-value">{footballDataResult.sync?.csvRows ?? 0}</span>
                      </div>
                      <div className="fp-meta-row">
                        <span className="fp-meta-label">Partite abbinate</span>
                        <span className="fp-meta-value">{footballDataResult.sync?.matched ?? 0}</span>
                      </div>
                      <div className="fp-meta-row">
                        <span className="fp-meta-label">Partite integrate</span>
                        <span className="fp-meta-value">{footballDataResult.sync?.updated ?? 0}</span>
                      </div>
                      <div className="fp-meta-row">
                        <span className="fp-meta-label">Squadre ricalcolate</span>
                        <span className="fp-meta-value">{footballDataResult.teamsUpdated ?? 0}</span>
                      </div>
                    </div>
                  </div>
                )}
              </section>

              {understatInfo && (
                <div className="fp-card" style={{ marginTop: 16, background: 'var(--surface2)' }}>
                  <div className="fp-card-head">
                    <div className="fp-card-title">Copertura sorgente</div>
                  </div>
                  <div className="fp-card-body">
                    {[
                      ['Campionati supportati', Array.isArray(understatInfo.competitions) ? understatInfo.competitions.join(', ') : 'n/d'],
                      ['Ultimi import nel DB', understatInfo.dbLastImport ? Object.entries(understatInfo.dbLastImport).map(([key, value]) => `${key}: ${String(value)}`).join(' | ') : 'n/d'],
                      ['Note', 'Understat resta la fonte primaria; football-data.co.uk integra soltanto campi mancanti compatibili.'],
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
                <div className="fp-card-title">Provider quote</div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>
                  Odds API è il provider quote runtime. Il matching usa anche kickoff e nomi squadra.
                </div>
              </div>
              <span className={`fp-badge ${remainingReq !== null && remainingReq > 100 ? 'fp-badge-green' : remainingReq !== null ? 'fp-badge-gold' : 'fp-badge-gray'}`}>
                {remainingReq !== null ? `${remainingReq}/500 richieste Odds API` : 'Richieste Odds API: n/d'}
              </span>
            </div>
            <div className="fp-card-body">
              <div className="fp-alert fp-alert-info" style={{ marginBottom: 16 }}>
                Le quote tecniche di fallback possono supportare il processo interno, ma la UI delle
                previsioni mostra una quota solo quando è disponibile la fonte Eurobet prevista dal prodotto.
              </div>
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
                    {formatFreshness(effectiveProviderHealth.freshnessMinutes)}
                  </div>
                  <div className="fp-stat-label">Freschezza provider</div>
                </div>
                <div className="fp-stat c-green">
                  <div className="fp-stat-val c-green">
                    {effectiveSystemMetrics.provider.avgScrapeLatencyMs !== null
                      ? formatMilliseconds(effectiveSystemMetrics.provider.avgScrapeLatencyMs)
                      : 'n/d'}
                  </div>
                  <div className="fp-stat-label">Latenza Media</div>
                </div>
                <div className="fp-stat c-red">
                  <div className="fp-stat-val c-red">{effectiveSystemMetrics.trends.errorRuns}</div>
                  <div className="fp-stat-label">Esecuzioni con errore</div>
                </div>
              </div>

              <div style={{ display: 'grid', gap: 10, gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))' }}>
                <button className="sc-big-btn" onClick={handleOdds} disabled={oddsLoading}>
                  {oddsLoading ? 'Scaricamento provider...' : 'Scarica quote provider'}
                </button>
                <button className="sc-big-btn" onClick={handleVerifyProvider} disabled={providerCheckLoading}>
                  {providerCheckLoading ? 'Verifica provider...' : 'Verifica provider'}
                </button>
              </div>

              <div style={{ marginTop: 16 }}>
                <ProviderStatusSummary providerHealth={effectiveProviderHealth} />
              </div>

              {oddsLastUpdatedAt && (
                <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-2)', fontFamily: 'var(--font-mono)' }}>
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
                  Verifica non completata: {providerCheckError}
                </div>
              )}

              {oddsError && (
                <div className="fp-alert fp-alert-danger" style={{ marginTop: 16 }}>
                  Aggiornamento non completato: {oddsError}
                </div>
              )}

              {!oddsError && !oddsLoading && oddsMatches.length > 0 && (
                <>
                  <div className="fp-alert fp-alert-success" style={{ marginTop: 16 }}>
                    Quote provider aggiornate: <strong>{oddsMatches.length}</strong> partite trovate.
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
                          key={`${match.homeTeam}-${match.awayTeam}-${index}`}
                          className="sc-result-row"
                          style={{ padding: '12px 16px' }}
                        >
                          <strong style={{ fontSize: 13 }}>{match.homeTeam} — {match.awayTeam}</strong>
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
