import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import {
  getBudget,
  getBets,
  getMatchesCount,
  getScraperStatus,
  getSystemAnalytics,
  initBudget,
} from '../utils/api';

interface DashboardProps {
  activeUser: string;
  onRefreshStatus?: () => Promise<void> | void;
}

const formatCurrency = (value: number | null | undefined) => `EUR ${Number(value ?? 0).toFixed(2)}`;
const formatPct = (value: number | null | undefined, digits = 1) => `${Number(value ?? 0).toFixed(digits)}%`;
const formatDateTime = (value?: string | null) => {
  if (!value) return '-';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '-' : parsed.toLocaleString('it-IT');
};
const formatDuration = (value?: number | null) => {
  if (!value || value <= 0) return '-';
  const totalSeconds = Math.round(value / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes <= 0) return `${seconds}s`;
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
};
const getSchedulerTone = (scheduler: any) => {
  if (scheduler?.running) return 'fp-badge-blue';
  if (scheduler?.lastError) return 'fp-badge-red';
  if (scheduler?.lastRunAt) return 'fp-badge-green';
  return 'fp-badge-gray';
};
const getSchedulerLabel = (scheduler: any) => {
  if (scheduler?.running) return 'In corso';
  if (scheduler?.lastError) return 'Errore';
  if (scheduler?.lastRunAt) return 'OK';
  return 'In attesa';
};
const formatSchedulerName = (value?: string | null) => {
  if (value === 'understat') return 'Understat';
  if (value === 'odds') return 'Quote';
  if (value === 'learning') return 'Learning';
  return value || '-';
};
const buildLatestSchedulerRunMap = (runs: any[]) => {
  const latestByScheduler = new Map<string, any>();
  for (const run of Array.isArray(runs) ? runs : []) {
    const key = String(run?.schedulerName ?? '').trim();
    if (!key || latestByScheduler.has(key)) continue;
    latestByScheduler.set(key, run);
  }
  return latestByScheduler;
};
const mergeSchedulerWithRecentRun = (scheduler: any, recentRun: any) => {
  if (!recentRun) return scheduler ?? null;
  const base = scheduler ?? {};
  if (base?.running || base?.lastRunAt || base?.lastError) return base;
  return {
    ...base,
    lastRunAt: recentRun?.startedAt ?? null,
    lastDurationMs: recentRun?.durationMs ?? null,
    lastError: recentRun?.success === false ? recentRun?.error ?? 'Run esterno fallito' : null,
    lastResult: base?.lastResult ?? recentRun?.summary ?? null,
  };
};
const getNightlyHealth = (runs: any[]) => {
  const latestByScheduler = buildLatestSchedulerRunMap(runs);
  const understat = latestByScheduler.get('understat');
  const odds = latestByScheduler.get('odds');
  const learning = latestByScheduler.get('learning');
  const coreRuns = [understat, learning].filter(Boolean);

  if (coreRuns.length === 0 && !odds) {
    return { label: 'Ultima notte in attesa', tone: 'fp-badge-gray' };
  }
  if (coreRuns.some((run) => run?.success === false)) {
    return { label: 'Ultima notte con errori', tone: 'fp-badge-red' };
  }
  if (coreRuns.length < 2) {
    return { label: 'Ultima notte parziale', tone: 'fp-badge-gold' };
  }
  if (odds && odds?.success === false) {
    return { label: 'Ultima notte parziale', tone: 'fp-badge-gold' };
  }
  if (coreRuns.every((run) => run?.success === true)) {
    return { label: 'Ultima notte OK', tone: 'fp-badge-green' };
  }
  return { label: 'Ultima notte parziale', tone: 'fp-badge-gold' };
};

const Dashboard: React.FC<DashboardProps> = ({ activeUser, onRefreshStatus }) => {
  const [budget, setBudget] = useState<any>(null);
  const [recentBets, setRecentBets] = useState<any[]>([]);
  const [matchCount, setMatchCount] = useState(0);
  const [analytics, setAnalytics] = useState<any>(null);
  const [scraperStatus, setScraperStatus] = useState<any>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [initAmount, setInitAmount] = useState('1000');
  const [showInit, setShowInit] = useState(false);

  const loadData = useCallback(async () => {
    setRefreshing(true);
    const [budgetRes, betsRes, matchesCountRes, analyticsRes, scraperStatusRes] = await Promise.allSettled([
      getBudget(activeUser),
      getBets(activeUser),
      getMatchesCount(),
      getSystemAnalytics({ userId: activeUser }),
      getScraperStatus(),
    ]);

    if (budgetRes.status === 'fulfilled') {
      if (budgetRes.value.data) {
        setBudget(budgetRes.value.data);
        setShowInit(false);
      } else {
        setBudget(null);
        setShowInit(true);
      }
    } else {
      setBudget(null);
      setShowInit(true);
    }

    if (betsRes.status === 'fulfilled') {
      setRecentBets((betsRes.value.data ?? []).slice(0, 5));
    } else {
      setRecentBets([]);
    }

    if (matchesCountRes.status === 'fulfilled') {
      setMatchCount(matchesCountRes.value.count ?? 0);
    } else {
      setMatchCount(0);
    }

    if (analyticsRes.status === 'fulfilled') {
      setAnalytics(analyticsRes.value.data ?? null);
    } else {
      setAnalytics(null);
    }

    if (scraperStatusRes.status === 'fulfilled') {
      setScraperStatus(scraperStatusRes.value.data ?? null);
    } else {
      setScraperStatus(null);
    }

    setRefreshing(false);
  }, [activeUser]);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  useEffect(() => {
    const onSyncDone = () => { void loadData(); };
    window.addEventListener('data-sync-complete', onSyncDone);
    return () => window.removeEventListener('data-sync-complete', onSyncDone);
  }, [loadData]);

  const handleRefreshStatus = async () => {
    await Promise.allSettled([
      loadData(),
      Promise.resolve(onRefreshStatus?.()),
    ]);
  };

  const handleInitBudget = async () => {
    const amount = parseFloat(initAmount);
    if (Number.isNaN(amount) || amount <= 0) return;
    const res = await initBudget(activeUser, amount);
    if (res.data) {
      setBudget(res.data);
      setShowInit(false);
    }
  };

  const roi = budget?.roi ?? 0;
  const winRate = budget?.win_rate ?? 0;
  const netProfit = ((Number(budget?.total_staked ?? 0) * Number(roi ?? 0)) / 100);
  const oddsArchive = analytics?.oddsArchive ?? {};
  const userClv = analytics?.userClv ?? {};
  const overview = analytics?.overview ?? {};
  const coverage = overview?.coverage?.fields ?? {};
  const scheduler = scraperStatus?.oddsSnapshotScheduler ?? null;
  const recentSchedulerRuns = Array.isArray(scraperStatus?.recentSchedulerRuns)
    ? scraperStatus.recentSchedulerRuns
    : [];
  const latestSchedulerRuns = buildLatestSchedulerRunMap(recentSchedulerRuns);
  const understatScheduler = mergeSchedulerWithRecentRun(
    scraperStatus?.understatScheduler ?? null,
    latestSchedulerRuns.get('understat')
  );
  const learningScheduler = mergeSchedulerWithRecentRun(
    scraperStatus?.learningReviewScheduler ?? null,
    latestSchedulerRuns.get('learning')
  );
  const nightlyHealth = getNightlyHealth(recentSchedulerRuns);
  const sourceBreakdown = Object.entries(oddsArchive?.sourceBreakdown ?? {}).slice(0, 4);

  return (
    <div style={{ padding: '40px 32px', minHeight: '100vh' }}>
      <div style={{ marginBottom: 32 }}>
        <h1 className="fp-page-title fp-gradient-blue">Dashboard</h1>
        <p style={{ fontSize: 12, color: 'var(--text-2)', margin: 0, fontFamily: 'DM Mono, monospace' }}>
          Stato operativo del sistema | {activeUser}
        </p>
        <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className={`fp-badge ${nightlyHealth.tone}`}>{nightlyHealth.label}</span>
          <button
            type="button"
            className="fp-btn fp-btn-ghost fp-btn-sm"
            onClick={() => { void handleRefreshStatus(); }}
            disabled={refreshing}
            title="Ricarica subito lo stato scheduler e i dati dashboard"
          >
            <RefreshCw size={14} className={refreshing ? 'fp-spin' : ''} />
            <span>{refreshing ? 'Aggiorno...' : 'Aggiorna stato'}</span>
          </button>
        </div>
        {refreshing && (
          <p style={{ fontSize: 11, color: 'var(--text-3)', margin: '8px 0 0', fontFamily: 'DM Mono, monospace' }}>
            Aggiornamento dati...
          </p>
        )}
      </div>

      <div className="fp-grid-4" style={{ marginBottom: 24 }}>
        {[
          { label: 'Partite nel DB', value: matchCount, color: 'blue' },
          { label: 'Snapshot Quote', value: oddsArchive?.totalSnapshots ?? 0, color: 'gold' },
          { label: 'Match Coperti', value: oddsArchive?.matchesCovered ?? 0, color: 'green' },
          { label: 'CLV Medio', value: formatPct(userClv?.avgClvPct ?? 0, 2), color: (userClv?.avgClvPct ?? 0) >= 0 ? 'green' : 'red' },
        ].map((item) => (
          <div key={item.label} className={`fp-stat c-${item.color}`}>
            <div className={`fp-stat-val c-${item.color}`}>{String(item.value)}</div>
            <div className="fp-stat-label">{item.label}</div>
          </div>
        ))}
      </div>

      {showInit && (
        <div className="fp-card" style={{ maxWidth: 520, margin: '0 auto 24px' }}>
          <div className="fp-card-head">
            <div className="fp-card-title">Inizializza Budget</div>
          </div>
          <div className="fp-card-body">
            <p style={{ marginBottom: 18, color: 'var(--text-2)', fontSize: 14, lineHeight: 1.6 }}>
              Nessun budget trovato. Imposta il budget iniziale per attivare anche il tracking finanziario.
            </p>
            <div style={{ display: 'flex', gap: 12, alignItems: 'flex-end', maxWidth: 340 }}>
              <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
                <label className="fp-label">Budget iniziale (EUR)</label>
                <input
                  className="fp-input"
                  type="number"
                  value={initAmount}
                  onChange={(e) => setInitAmount(e.target.value)}
                  min="10"
                  step="10"
                />
              </div>
              <button className="fp-btn fp-btn-solid" onClick={handleInitBudget}>
                Inizializza
              </button>
            </div>
          </div>
        </div>
      )}

      {budget && (
        <>
          <div className="fp-grid-4" style={{ marginBottom: 24 }}>
            {[
              { label: 'Budget Disponibile', value: formatCurrency(budget.available_budget), color: 'green' },
              { label: 'ROI Reale', value: `${roi >= 0 ? '+' : ''}${formatPct(roi, 2)}`, color: roi >= 0 ? 'green' : 'red' },
              { label: 'Win Rate', value: formatPct(winRate, 1), color: 'gold' },
              { label: 'Scommesse Totali', value: budget.total_bets ?? 0, color: 'blue' },
            ].map((item) => (
              <div key={item.label} className={`fp-stat c-${item.color}`}>
                <div className={`fp-stat-val c-${item.color}`}>{String(item.value)}</div>
                <div className="fp-stat-label">{item.label}</div>
              </div>
            ))}
          </div>

          <div className="fp-card" style={{ marginBottom: 24 }}>
            <div className="fp-card-head">
              <div className="fp-card-title">Riepilogo Finanziario</div>
            </div>
            <div style={{ overflowX: 'auto' }}>
              <table className="fp-table">
                <tbody>
                  {[
                    ['Budget Totale', formatCurrency(budget.total_budget)],
                    ['Budget Disponibile', formatCurrency(budget.available_budget)],
                    ['Totale Puntato', formatCurrency(budget.total_staked)],
                    ['Totale Vinto', formatCurrency(budget.total_won)],
                    ['Totale Perso', formatCurrency(budget.total_lost)],
                    ['Profitto Netto', `${netProfit >= 0 ? '+' : ''}${formatCurrency(netProfit)}`],
                    ['CLV Positivo', formatPct(userClv?.positiveClvRate ?? 0, 1)],
                  ].map(([label, value]) => (
                    <tr key={label}>
                      <td style={{ color: 'var(--text-2)' }}>{label}</td>
                      <td className="fp-mono" style={{ textAlign: 'right', fontWeight: 600 }}>{value}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <div className="fp-grid-2" style={{ marginBottom: 24 }}>
        <div className="fp-card">
          <div className="fp-card-head">
            <div className="fp-card-title">Qualita Dataset</div>
            <span className={`fp-badge ${overview?.checks?.allCoreStatsLoaded ? 'fp-badge-green' : 'fp-badge-gold'}`}>
              {overview?.checks?.allCoreStatsLoaded ? 'Core stats OK' : 'Copertura da completare'}
            </span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="fp-table">
              <tbody>
                {[
                  ['xG', formatPct(coverage?.xg?.pct ?? 0, 1)],
                  ['Tiri', formatPct(coverage?.shots?.pct ?? 0, 1)],
                  ['Tiri in porta', formatPct(coverage?.shotsOnTarget?.pct ?? 0, 1)],
                  ['Falli', formatPct(coverage?.fouls?.pct ?? 0, 1)],
                  ['Gialli', formatPct(coverage?.yellowCards?.pct ?? 0, 1)],
                ].map(([label, value]) => (
                  <tr key={label}>
                    <td style={{ color: 'var(--text-2)' }}>{label}</td>
                    <td className="fp-mono" style={{ textAlign: 'right', fontWeight: 600 }}>{value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        <div className="fp-card">
          <div className="fp-card-head">
            <div className="fp-card-title">Archivio Quote</div>
            <span className="fp-badge fp-badge-gray">
              {oddsArchive?.matchesWithMultipleSnapshots ?? 0} match con piu snapshot
            </span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="fp-table">
              <tbody>
                {[
                  ['Snapshot totali', oddsArchive?.totalSnapshots ?? 0],
                  ['Match coperti', oddsArchive?.matchesCovered ?? 0],
                  ['Con quote reali', oddsArchive?.snapshotsWithRealOdds ?? 0],
                  ['Con completamento modello', oddsArchive?.snapshotsWithSyntheticCompletion ?? 0],
                  ['Solo bookmaker preferito', oddsArchive?.snapshotsUsingEurobetPure ?? 0],
                ].map(([label, value]) => (
                  <tr key={label}>
                    <td style={{ color: 'var(--text-2)' }}>{label}</td>
                    <td className="fp-mono" style={{ textAlign: 'right', fontWeight: 600 }}>{String(value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {sourceBreakdown.length > 0 && (
            <div className="fp-card-body" style={{ borderTop: '1px solid var(--border)' }}>
              <div style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '1px', marginBottom: 8 }}>
                Fonti principali
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
                {sourceBreakdown.map(([source, count]) => (
                  <span key={source} className="fp-badge fp-badge-gray">
                    {source}: {String(count)}
                  </span>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="fp-grid-2" style={{ marginBottom: 24 }}>
        <div className="fp-card">
          <div className="fp-card-head">
            <div className="fp-card-title">Pipeline Notturna</div>
            <span className={`fp-badge ${scraperStatus?.isUpdating ? 'fp-badge-blue' : 'fp-badge-gray'}`}>
              {scraperStatus?.isUpdating ? 'Job attivo' : 'Schedulata'}
            </span>
          </div>
          <div className="fp-card-body" style={{ display: 'grid', gap: 16 }}>
            {[
              {
                title: 'Import dati Understat',
                scheduler: understatScheduler,
                details: [
                  ['Orario', understatScheduler?.time ?? '-'],
                  ['Ultimo run', formatDateTime(understatScheduler?.lastRunAt)],
                  ['Durata', formatDuration(understatScheduler?.lastDurationMs)],
                  ['Nuove partite', understatScheduler?.lastResult?.newMatchesImported ?? 0],
                  ['Aggiornate', understatScheduler?.lastResult?.existingMatchesUpdated ?? 0],
                  ['Prossimo run', formatDateTime(understatScheduler?.nextRunAt)],
                ],
              },
              {
                title: 'Snapshot quote',
                scheduler,
                details: [
                  ['Orario', scheduler?.time ?? '-'],
                  ['Ultimo run', formatDateTime(scheduler?.lastRunAt)],
                  ['Durata', formatDuration(scheduler?.lastDurationMs)],
                  ['Competizioni OK', Array.isArray(scheduler?.lastResults) ? scheduler.lastResults.filter((entry: any) => entry.success).length : 0],
                  ['Snapshot salvati', Array.isArray(scheduler?.lastResults) ? scheduler.lastResults.reduce((sum: number, entry: any) => sum + Number(entry.savedSnapshots ?? 0), 0) : 0],
                  ['Prossimo run', formatDateTime(scheduler?.nextRunAt)],
                ],
              },
              {
                title: 'Learning review',
                scheduler: learningScheduler,
                details: [
                  ['Orario', learningScheduler?.time ?? '-'],
                  ['Ultimo run', formatDateTime(learningScheduler?.lastRunAt)],
                  ['Durata', formatDuration(learningScheduler?.lastDurationMs)],
                  ['Review create', learningScheduler?.lastResult?.created ?? 0],
                  ['Review refresh', learningScheduler?.lastResult?.refreshed ?? 0],
                  ['Prossimo run', formatDateTime(learningScheduler?.nextRunAt)],
                ],
              },
            ].map((item) => (
              <div key={item.title} style={{ border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', background: 'var(--surface2)' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '14px 16px 10px' }}>
                  <div style={{ fontWeight: 700 }}>{item.title}</div>
                  <span className={`fp-badge ${getSchedulerTone(item.scheduler)}`}>{getSchedulerLabel(item.scheduler)}</span>
                </div>
                <div style={{ overflowX: 'auto', padding: '0 16px 8px' }}>
                  <table className="fp-table">
                    <tbody>
                      {item.details.map(([label, value]) => (
                        <tr key={`${item.title}-${String(label)}`}>
                          <td style={{ color: 'var(--text-2)' }}>{label}</td>
                          <td className="fp-mono" style={{ textAlign: 'right', fontWeight: 600 }}>{String(value)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {item.scheduler?.lastError && (
                  <div className="fp-alert fp-alert-warning" style={{ margin: '0 16px 16px' }}>
                    {item.scheduler.lastError}
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>

        <div className="fp-card">
          <div className="fp-card-head">
            <div className="fp-card-title">Closing Line Tracking</div>
            <span className={`fp-badge ${(userClv?.positiveClvRate ?? 0) >= 50 ? 'fp-badge-green' : 'fp-badge-gold'}`}>
              {formatPct(userClv?.positiveClvRate ?? 0, 1)} positivo
            </span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="fp-table">
              <tbody>
                {[
                  ['Bet tracciate', userClv?.trackedBets ?? 0],
                  ['Con closing line', userClv?.betsWithClosingLine ?? 0],
                  ['CLV medio', formatPct(userClv?.avgClvPct ?? 0, 2)],
                ].map(([label, value]) => (
                  <tr key={label}>
                    <td style={{ color: 'var(--text-2)' }}>{label}</td>
                    <td className="fp-mono" style={{ textAlign: 'right', fontWeight: 600 }}>{String(value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="fp-card-body" style={{ borderTop: '1px solid var(--border)' }}>
            <div className="fp-alert fp-alert-info">
              Il replay e il backtest usano prima le quote storiche archiviate. Se uno snapshot manca, il sistema passa al fallback del modello.
            </div>
          </div>
        </div>
      </div>

      <div className="fp-card" style={{ marginBottom: 24 }}>
        <div className="fp-card-head">
          <div className="fp-card-title">Storico Ultimi 7 Run</div>
          <span className="fp-badge fp-badge-gray">{recentSchedulerRuns.length} eventi</span>
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table className="fp-table">
            <thead>
              <tr>
                <th>Job</th>
                <th>Esito</th>
                <th>Avvio</th>
                <th>Durata</th>
                <th>Dettaglio</th>
              </tr>
            </thead>
            <tbody>
              {recentSchedulerRuns.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ color: 'var(--text-2)', textAlign: 'center' }}>Nessun run storico disponibile.</td>
                </tr>
              ) : recentSchedulerRuns.map((run: any) => {
                const summary = run?.summary ?? {};
                const detail = run?.error
                  ? run.error
                  : run?.schedulerName === 'understat'
                    ? `${Number(summary?.newMatchesImported ?? 0)} nuove, ${Number(summary?.existingMatchesUpdated ?? 0)} aggiornate`
                    : run?.schedulerName === 'odds'
                      ? `${Number(summary?.savedSnapshots ?? 0)} snapshot, ${Number(summary?.okCount ?? 0)}/${Number(summary?.totalCompetitions ?? 0)} leghe`
                      : `${Number(summary?.created ?? 0)} create, ${Number(summary?.refreshed ?? 0)} refresh`;
                return (
                  <tr key={String(run?.runId ?? `${run?.schedulerName}-${run?.startedAt}`)}>
                    <td style={{ fontWeight: 600 }}>{formatSchedulerName(run?.schedulerName)}</td>
                    <td>
                      <span className={`fp-badge ${run?.success ? 'fp-badge-green' : 'fp-badge-red'}`}>
                        {run?.success ? 'OK' : 'Errore'}
                      </span>
                    </td>
                    <td className="fp-mono">{formatDateTime(run?.startedAt)}</td>
                    <td className="fp-mono">{formatDuration(run?.durationMs)}</td>
                    <td style={{ color: 'var(--text-2)' }}>{detail}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {recentBets.length > 0 && (
        <div className="fp-card">
          <div className="fp-card-head">
            <div className="fp-card-title">Ultime Scommesse</div>
            <span className="fp-badge fp-badge-gray">{recentBets.length} recenti</span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="fp-table">
              <thead>
                <tr>
                  <th>Mercato</th>
                  <th>Selezione</th>
                  <th>Quota</th>
                  <th>Puntata</th>
                  <th>P. Nostra</th>
                  <th>EV</th>
                  <th>Stato</th>
                  <th>Profitto</th>
                </tr>
              </thead>
              <tbody>
                {recentBets.map((bet: any) => (
                  <tr key={bet.bet_id}>
                    <td style={{ fontWeight: 600 }}>{bet.market_name}</td>
                    <td style={{ color: 'var(--text-2)' }}>{bet.selection}</td>
                    <td className="fp-mono">{Number(bet.odds ?? 0).toFixed(2)}</td>
                    <td className="fp-mono">{formatCurrency(bet.stake)}</td>
                    <td className="fp-mono">{formatPct((bet.our_probability ?? 0) * 100, 2)}</td>
                    <td className="fp-mono" style={{ color: 'var(--green)', fontWeight: 600 }}>
                      +{formatPct((bet.expected_value ?? 0) * 100, 2)}
                    </td>
                    <td>
                      <span className={`fp-badge ${bet.status === 'WON' ? 'fp-badge-green' : bet.status === 'LOST' ? 'fp-badge-red' : bet.status === 'PENDING' ? 'fp-badge-blue' : 'fp-badge-gray'}`}>
                        {bet.status === 'WON' ? 'VINTA' : bet.status === 'LOST' ? 'PERSA' : bet.status === 'PENDING' ? 'ATTESA' : bet.status}
                      </span>
                    </td>
                    <td
                      className="fp-mono"
                      style={{
                        color: bet.profit > 0 ? 'var(--green)' : bet.profit < 0 ? 'var(--red)' : 'var(--text-2)',
                        fontWeight: 600,
                      }}
                    >
                      {bet.profit !== null ? `${bet.profit > 0 ? '+' : ''}${formatCurrency(bet.profit)}` : '-'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
};

export default Dashboard;
