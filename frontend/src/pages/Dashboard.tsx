import React, { useEffect, useState } from 'react';
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
}

const formatCurrency = (value: number | null | undefined) => `EUR ${Number(value ?? 0).toFixed(2)}`;
const formatPct = (value: number | null | undefined, digits = 1) => `${Number(value ?? 0).toFixed(digits)}%`;
const formatDateTime = (value?: string | null) => {
  if (!value) return '-';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '-' : parsed.toLocaleString('it-IT');
};

const Dashboard: React.FC<DashboardProps> = ({ activeUser }) => {
  const [budget, setBudget] = useState<any>(null);
  const [recentBets, setRecentBets] = useState<any[]>([]);
  const [matchCount, setMatchCount] = useState(0);
  const [analytics, setAnalytics] = useState<any>(null);
  const [scraperStatus, setScraperStatus] = useState<any>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [initAmount, setInitAmount] = useState('1000');
  const [showInit, setShowInit] = useState(false);

  useEffect(() => {
    void loadData();
  }, [activeUser]);

  const loadData = async () => {
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
  const learningLoop = analytics?.learningLoop ?? {};
  const adaptiveTuning = analytics?.adaptiveTuning ?? {};
  const overview = analytics?.overview ?? {};
  const coverage = overview?.coverage?.fields ?? {};
  const scheduler = scraperStatus?.oddsSnapshotScheduler ?? null;
  const learningScheduler = scraperStatus?.learningReviewScheduler ?? null;
  const sourceBreakdown = Object.entries(oddsArchive?.sourceBreakdown ?? {}).slice(0, 4);
  const topAdaptiveCategories = Object.entries(adaptiveTuning?.categories ?? {}).slice(0, 4);

  return (
    <div style={{ padding: '40px 32px', minHeight: '100vh' }}>
      <div style={{ marginBottom: 32 }}>
        <h1 className="fp-page-title fp-gradient-blue">Dashboard</h1>
        <p style={{ fontSize: 12, color: 'var(--text-2)', margin: 0, fontFamily: 'DM Mono, monospace' }}>
          Stato operativo del sistema | {activeUser}
        </p>
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
            <div className="fp-card-title">Qualità Dataset</div>
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
                  ['Solo Eurobet', oddsArchive?.snapshotsUsingEurobetPure ?? 0],
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
            <div className="fp-card-title">Scheduler Quote</div>
            <span className={`fp-badge ${scheduler?.enabled ? 'fp-badge-blue' : 'fp-badge-gray'}`}>
              {scheduler?.enabled ? 'Attivo' : 'Disattivo'}
            </span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="fp-table">
              <tbody>
                {[
                  ['Intervallo', scheduler ? `${scheduler.intervalHours}h` : '-'],
                  ['Competizioni', scheduler?.competitions?.length ?? 0],
                  ['Ultimo run', formatDateTime(scheduler?.lastRunAt)],
                  ['Prossimo run', formatDateTime(scheduler?.nextRunAt)],
                  ['Esecuzione in corso', scheduler?.running ? 'Si' : 'No'],
                ].map(([label, value]) => (
                  <tr key={label}>
                    <td style={{ color: 'var(--text-2)' }}>{label}</td>
                    <td className="fp-mono" style={{ textAlign: 'right', fontWeight: 600 }}>{String(value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {scheduler?.lastError && (
            <div className="fp-alert fp-alert-warning" style={{ margin: '0 20px 20px' }}>
              {scheduler.lastError}
            </div>
          )}
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

      <div className="fp-grid-2" style={{ marginBottom: 24 }}>
        <div className="fp-card">
          <div className="fp-card-head">
            <div className="fp-card-title">Taratura Adattiva</div>
            <span className={`fp-badge ${topAdaptiveCategories.length > 0 ? 'fp-badge-blue' : 'fp-badge-gray'}`}>
              {adaptiveTuning?.totalReviews ?? 0} review usate
            </span>
          </div>
          {topAdaptiveCategories.length > 0 ? (
            <div style={{ overflowX: 'auto' }}>
              <table className="fp-table">
                <thead>
                  <tr>
                    <th>Categoria</th>
                    <th>Campioni</th>
                    <th>EV delta</th>
                    <th>Coherence</th>
                    <th>Rank x</th>
                  </tr>
                </thead>
                <tbody>
                  {topAdaptiveCategories.map(([category, tuning]: [string, any]) => (
                    <tr key={category}>
                      <td style={{ fontWeight: 600 }}>{category}</td>
                      <td className="fp-mono">{tuning?.sampleSize ?? 0}</td>
                      <td className="fp-mono">{Number((tuning?.evDelta ?? 0) * 100).toFixed(2)}%</td>
                      <td className="fp-mono">{Number(tuning?.coherenceDelta ?? 0).toFixed(3)}</td>
                      <td className="fp-mono">{Number(tuning?.rankingMultiplier ?? 1).toFixed(3)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="fp-card-body">
              <div className="fp-alert fp-alert-info">
                Nessuna taratura adattiva attiva. Si popola quando il sistema accumula review post-partita sufficienti.
              </div>
            </div>
          )}
        </div>

        <div className="fp-card">
          <div className="fp-card-head">
            <div className="fp-card-title">Scheduler Learning</div>
            <span className={`fp-badge ${learningScheduler?.enabled ? 'fp-badge-blue' : 'fp-badge-gray'}`}>
              {learningScheduler?.enabled ? 'Attivo' : 'Disattivo'}
            </span>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="fp-table">
              <tbody>
                {[
                  ['Intervallo', learningScheduler ? `${learningScheduler.intervalHours}h` : '-'],
                  ['Match per ciclo', learningScheduler?.matchLimit ?? '-'],
                  ['Ultimo run', formatDateTime(learningScheduler?.lastRunAt)],
                  ['Prossimo run', formatDateTime(learningScheduler?.nextRunAt)],
                  ['Review create', learningScheduler?.lastResult?.created ?? 0],
                ].map(([label, value]) => (
                  <tr key={label}>
                    <td style={{ color: 'var(--text-2)' }}>{label}</td>
                    <td className="fp-mono" style={{ textAlign: 'right', fontWeight: 600 }}>{String(value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {learningScheduler?.lastError && (
            <div className="fp-alert fp-alert-warning" style={{ margin: '0 20px 20px' }}>
              {learningScheduler.lastError}
            </div>
          )}
        </div>
      </div>

      <div className="fp-card" style={{ marginBottom: 24 }}>
        <div className="fp-card-head">
          <div className="fp-card-title">Apprendimento Post-partita</div>
          <span className={`fp-badge ${(learningLoop?.actionableReviews ?? 0) > 0 ? 'fp-badge-gold' : 'fp-badge-gray'}`}>
            {learningLoop?.actionableReviews ?? 0} review azionabili
          </span>
        </div>
        <div className="fp-grid-2" style={{ padding: '0 20px 20px' }}>
          <div style={{ overflowX: 'auto' }}>
            <table className="fp-table">
              <tbody>
                {[
                  ['Review totali', learningLoop?.totalReviews ?? 0],
                  ['Review azionabili', learningLoop?.actionableReviews ?? 0],
                  ['Missed winners', learningLoop?.missedWinningSelections ?? 0],
                  ['Ranking error', learningLoop?.reviewTypeBreakdown?.ranking_error ?? 0],
                  ['Filter rejection', learningLoop?.reviewTypeBreakdown?.filter_rejection ?? 0],
                ].map(([label, value]) => (
                  <tr key={label}>
                    <td style={{ color: 'var(--text-2)' }}>{label}</td>
                    <td className="fp-mono" style={{ textAlign: 'right', fontWeight: 600 }}>{String(value)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="fp-card-body" style={{ padding: 0 }}>
            {Array.isArray(learningLoop?.recentReviews) && learningLoop.recentReviews.length > 0 ? (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {learningLoop.recentReviews.slice(0, 3).map((review: any) => (
                  <div
                    key={`${review.matchId}_${review.updatedAt}`}
                    style={{
                      padding: 14,
                      borderRadius: 'var(--radius-sm)',
                      border: '1px solid var(--border)',
                      background: 'var(--surface2)',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, marginBottom: 6 }}>
                      <strong>{review.headline || review.reviewType}</strong>
                      <span className="fp-badge fp-badge-gray">{review.reviewType}</span>
                    </div>
                    <div style={{ color: 'var(--text-2)', fontSize: 13, lineHeight: 1.5 }}>
                      {review.humanSummary}
                    </div>
                    <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-3)', fontFamily: 'DM Mono, monospace' }}>
                      {review.competition || 'N/D'} · {formatDateTime(review.updatedAt)}
                    </div>
                  </div>
                ))}
              </div>
            ) : (
              <div className="fp-alert fp-alert-info">
                Nessuna review post-partita salvata. Si popolano quando apri il replay di una partita conclusa.
              </div>
            )}
          </div>
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
