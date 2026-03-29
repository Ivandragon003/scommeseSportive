import cors from 'cors';
import express from 'express';
import routes from './api/routes';
import { DatabaseService } from './db/DatabaseService';

const app = express();
const schedulerDb = new DatabaseService();
const PORT = Number(process.env.PORT ?? 3001);
const AUTO_SYNC_ON_BOOT =
  String(process.env.AUTO_SYNC_ON_BOOT ?? 'true').trim().toLowerCase() !== 'false';
const UNDERSTAT_SCHEDULER_ENABLED =
  String(process.env.UNDERSTAT_SCHEDULER_ENABLED ?? 'true').trim().toLowerCase() === 'true';
const UNDERSTAT_SCHEDULER_TIME = String(process.env.UNDERSTAT_SCHEDULER_TIME ?? '01:00').trim() || '01:00';
const UNDERSTAT_SCHEDULER_MODE =
  String(process.env.UNDERSTAT_SCHEDULER_MODE ?? 'top5').trim().toLowerCase() === 'single'
    ? 'single'
    : 'top5';
const UNDERSTAT_SCHEDULER_COMPETITION = String(process.env.UNDERSTAT_SCHEDULER_COMPETITION ?? 'Serie A').trim() || 'Serie A';
const UNDERSTAT_SCHEDULER_YEARS_BACK = Math.max(
  1,
  Math.min(Number(process.env.UNDERSTAT_SCHEDULER_YEARS_BACK ?? 1), 5)
);
const UNDERSTAT_SCHEDULER_IMPORT_PLAYERS =
  String(process.env.UNDERSTAT_SCHEDULER_IMPORT_PLAYERS ?? 'true').trim().toLowerCase() === 'true';
const UNDERSTAT_SCHEDULER_INCLUDE_MATCH_DETAILS =
  String(process.env.UNDERSTAT_SCHEDULER_INCLUDE_MATCH_DETAILS ?? 'true').trim().toLowerCase() === 'true';
const UNDERSTAT_SCHEDULER_FORCE_REFRESH =
  String(process.env.UNDERSTAT_SCHEDULER_FORCE_REFRESH ?? 'false').trim().toLowerCase() === 'true';
const ODDS_SNAPSHOT_SCHEDULER_ENABLED =
  String(process.env.ODDS_SNAPSHOT_SCHEDULER_ENABLED ?? 'false').trim().toLowerCase() === 'true';
const ODDS_SNAPSHOT_SCHEDULER_TIME = String(process.env.ODDS_SNAPSHOT_SCHEDULER_TIME ?? '02:15').trim() || '02:15';
const ODDS_SNAPSHOT_RUN_ON_BOOT =
  String(process.env.ODDS_SNAPSHOT_RUN_ON_BOOT ?? 'false').trim().toLowerCase() === 'true';
const ODDS_SNAPSHOT_INTERVAL_HOURS = Math.max(
  6,
  Math.min(Number(process.env.ODDS_SNAPSHOT_INTERVAL_HOURS ?? 24), 168)
);
const LEARNING_REVIEW_SCHEDULER_ENABLED =
  String(process.env.LEARNING_REVIEW_SCHEDULER_ENABLED ?? 'false').trim().toLowerCase() === 'true';
const LEARNING_REVIEW_SCHEDULER_TIME = String(process.env.LEARNING_REVIEW_SCHEDULER_TIME ?? '03:00').trim() || '03:00';
const LEARNING_REVIEW_RUN_ON_BOOT =
  String(process.env.LEARNING_REVIEW_RUN_ON_BOOT ?? 'true').trim().toLowerCase() === 'true';
const LEARNING_REVIEW_INTERVAL_HOURS = Math.max(
  2,
  Math.min(Number(process.env.LEARNING_REVIEW_INTERVAL_HOURS ?? 6), 168)
);
const LEARNING_REVIEW_MATCH_LIMIT = Math.max(
  10,
  Math.min(Number(process.env.LEARNING_REVIEW_MATCH_LIMIT ?? 80), 250)
);
const ODDS_SNAPSHOT_COMPETITIONS = String(
  process.env.ODDS_SNAPSHOT_COMPETITIONS
    ?? 'Serie A,Premier League,La Liga,Bundesliga,Ligue 1'
)
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const DEFAULT_ODDS_MARKETS = String(
  process.env.ODDS_SNAPSHOT_MARKETS
    ?? 'h2h,totals,spreads'
)
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);

let isUpdating = false;
let lastUpdate: { at: Date; success: boolean; message: string } | null = null;
let understatSchedulerTimer: NodeJS.Timeout | null = null;
let oddsSchedulerTimer: NodeJS.Timeout | null = null;
let learningSchedulerTimer: NodeJS.Timeout | null = null;

const understatSchedulerState: {
  enabled: boolean;
  running: boolean;
  time: string;
  mode: 'single' | 'top5';
  competition: string;
  yearsBack: number;
  importPlayers: boolean;
  includeMatchDetails: boolean;
  forceRefresh: boolean;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  lastDurationMs: number | null;
  lastError: string | null;
  lastResult: {
    newMatchesImported?: number;
    existingMatchesUpdated?: number;
    upcomingMatchesImported?: number;
    playersUpdated?: number;
    teamsRecomputed?: number;
    isUpToDate?: boolean;
    message?: string;
  } | null;
} = {
  enabled: UNDERSTAT_SCHEDULER_ENABLED,
  running: false,
  time: UNDERSTAT_SCHEDULER_TIME,
  mode: UNDERSTAT_SCHEDULER_MODE,
  competition: UNDERSTAT_SCHEDULER_COMPETITION,
  yearsBack: UNDERSTAT_SCHEDULER_YEARS_BACK,
  importPlayers: UNDERSTAT_SCHEDULER_IMPORT_PLAYERS,
  includeMatchDetails: UNDERSTAT_SCHEDULER_INCLUDE_MATCH_DETAILS,
  forceRefresh: UNDERSTAT_SCHEDULER_FORCE_REFRESH,
  lastRunAt: null,
  nextRunAt: null,
  lastDurationMs: null,
  lastError: null,
  lastResult: null,
};

const oddsSchedulerState: {
  enabled: boolean;
  running: boolean;
  time: string;
  runOnBoot: boolean;
  intervalHours: number;
  competitions: string[];
  markets: string[];
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  lastDurationMs: number | null;
  lastError: string | null;
  lastResults: Array<{
    competition: string;
    success: boolean;
    matchesFound?: number;
    savedSnapshots?: number;
    remainingRequests?: number | null;
    error?: string;
  }>;
} = {
  enabled: ODDS_SNAPSHOT_SCHEDULER_ENABLED,
  running: false,
  time: ODDS_SNAPSHOT_SCHEDULER_TIME,
  runOnBoot: ODDS_SNAPSHOT_RUN_ON_BOOT,
  intervalHours: ODDS_SNAPSHOT_INTERVAL_HOURS,
  competitions: ODDS_SNAPSHOT_COMPETITIONS,
  markets: DEFAULT_ODDS_MARKETS,
  lastRunAt: null,
  nextRunAt: null,
  lastDurationMs: null,
  lastError: null,
  lastResults: [],
};

const learningSchedulerState: {
  enabled: boolean;
  running: boolean;
  time: string;
  runOnBoot: boolean;
  intervalHours: number;
  matchLimit: number;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  lastDurationMs: number | null;
  lastError: string | null;
  lastResult: {
    considered?: number;
    created?: number;
    refreshed?: number;
    skippedExisting?: number;
    skippedNoSnapshot?: number;
    skippedNoOdds?: number;
    usedModelFallbackReviews?: number;
    adaptiveTuningReviews?: number;
  } | null;
} = {
  enabled: LEARNING_REVIEW_SCHEDULER_ENABLED,
  running: false,
  time: LEARNING_REVIEW_SCHEDULER_TIME,
  runOnBoot: LEARNING_REVIEW_RUN_ON_BOOT,
  intervalHours: LEARNING_REVIEW_INTERVAL_HOURS,
  matchLimit: LEARNING_REVIEW_MATCH_LIMIT,
  lastRunAt: null,
  nextRunAt: null,
  lastDurationMs: null,
  lastError: null,
  lastResult: null,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

app.use(cors({ origin: 'http://localhost:3000' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

app.use((req, _res, next) => {
  if (req.path === '/api/health') {
    return next();
  }
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.use('/api', routes);

app.get('/api/scraper/status', async (_req, res) => {
  const recentSchedulerRuns = await schedulerDb.listRecentSchedulerRuns(7).catch(() => []);
  res.json({
    success: true,
    data: {
      isUpdating,
      lastUpdate,
      bootSyncEnabled: AUTO_SYNC_ON_BOOT,
      understatScheduler: understatSchedulerState,
      oddsSnapshotScheduler: oddsSchedulerState,
      learningReviewScheduler: learningSchedulerState,
      recentSchedulerRuns,
    },
  });
});

app.use((_req, res) => {
  res.status(404).json({ success: false, error: 'Not found' });
});

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ success: false, error: err.message });
});

async function runBootDataSync(): Promise<void> {
  if (!AUTO_SYNC_ON_BOOT) {
    console.log('[bootstrap-sync] Disabled (AUTO_SYNC_ON_BOOT=false)');
    return;
  }

  isUpdating = true;
  console.log('[bootstrap-sync] Starting automatic Understat sync for all top 5 leagues...');
  try {
    const maxAttempts = 3;
    let lastErrorMessage = 'Unknown error';
    let completed = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${PORT}/api/scraper/understat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: 'top5',
            yearsBack: 1,
            importPlayers: true,
            includeMatchDetails: true,
            forceRefresh: false,
          }),
        });

        const payload: any = await response.json().catch(() => ({}));
        if (!response.ok || payload?.success === false) {
          lastErrorMessage = payload?.error ?? `HTTP ${response.status}`;
          console.error(`[bootstrap-sync] Attempt ${attempt}/${maxAttempts} failed:`, lastErrorMessage);
          if (attempt < maxAttempts) {
            await sleep(1500 * attempt);
            continue;
          }
          break;
        }

        const data = payload?.data ?? {};
        console.log(
          `[bootstrap-sync] Done. New matches: ${Number(data?.newMatchesImported ?? 0)}, ` +
          `updated: ${Number(data?.existingMatchesUpdated ?? 0)}.`,
        );
        lastUpdate = {
          at: new Date(),
          success: true,
          message: `Imported ${Number(data?.newMatchesImported ?? 0)} matches`,
        };
        completed = true;
        break;
      } catch (err: any) {
        lastErrorMessage = err?.message ?? 'Unknown error';
        console.error(`[bootstrap-sync] Attempt ${attempt}/${maxAttempts} error:`, lastErrorMessage);
        if (attempt < maxAttempts) {
          await sleep(1500 * attempt);
        }
      }
    }

    if (!completed) {
      lastUpdate = { at: new Date(), success: false, message: lastErrorMessage };
    }
  } catch (err: any) {
    console.error('[bootstrap-sync] Error:', err?.message ?? err);
    lastUpdate = { at: new Date(), success: false, message: err?.message ?? 'Unknown error' };
  } finally {
    isUpdating = false;
  }
}

async function postInternal(path: string, body: Record<string, unknown>): Promise<{ response: Response; payload: any }> {
  const response = await fetch(`http://localhost:${PORT}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload: any = await response.json().catch(() => ({}));
  return { response, payload };
}

async function persistSchedulerRun(entry: {
  schedulerName: 'understat' | 'odds' | 'learning';
  trigger: 'boot' | 'scheduled';
  startedAt: Date;
  endedAt: Date;
  success: boolean;
  durationMs: number;
  summary?: Record<string, unknown> | null;
  error?: string | null;
}): Promise<void> {
  await schedulerDb.saveSchedulerRun({
    schedulerName: entry.schedulerName,
    trigger: entry.trigger,
    startedAt: entry.startedAt.toISOString(),
    endedAt: entry.endedAt.toISOString(),
    success: entry.success,
    durationMs: entry.durationMs,
    summary: entry.summary ?? null,
    error: entry.error ?? null,
  }).catch((err) => {
    console.error(`[scheduler-history] Failed to save ${entry.schedulerName} run:`, err?.message ?? err);
  });
}

function parseDailyTime(value: string): { hours: number; minutes: number; label: string } {
  const match = String(value ?? '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (!match) {
    return { hours: 1, minutes: 0, label: '01:00' };
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return {
    hours,
    minutes,
    label: `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`,
  };
}

function computeNextDailyRun(value: string): Date {
  const { hours, minutes } = parseDailyTime(value);
  const now = new Date();
  const next = new Date(now);
  next.setHours(hours, minutes, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setDate(next.getDate() + 1);
  }
  return next;
}

function scheduleNextUnderstatRun(): void {
  if (!UNDERSTAT_SCHEDULER_ENABLED) {
    understatSchedulerState.nextRunAt = null;
    return;
  }

  if (understatSchedulerTimer) {
    clearTimeout(understatSchedulerTimer);
  }

  const nextRunAt = computeNextDailyRun(UNDERSTAT_SCHEDULER_TIME);
  understatSchedulerState.nextRunAt = nextRunAt;
  understatSchedulerTimer = setTimeout(() => {
    void runUnderstatScheduledSync('scheduled');
  }, Math.max(1000, nextRunAt.getTime() - Date.now()));
}

async function runUnderstatScheduledSync(trigger: 'scheduled'): Promise<void> {
  if (!UNDERSTAT_SCHEDULER_ENABLED || understatSchedulerState.running) {
    return;
  }

  const startedAt = new Date();
  understatSchedulerState.running = true;
  understatSchedulerState.lastError = null;
  understatSchedulerState.nextRunAt = null;
  isUpdating = true;

  try {
    const { response, payload } = await postInternal('/api/scraper/understat', {
      mode: UNDERSTAT_SCHEDULER_MODE,
      competition: UNDERSTAT_SCHEDULER_COMPETITION,
      yearsBack: UNDERSTAT_SCHEDULER_YEARS_BACK,
      importPlayers: UNDERSTAT_SCHEDULER_IMPORT_PLAYERS,
      includeMatchDetails: UNDERSTAT_SCHEDULER_INCLUDE_MATCH_DETAILS,
      forceRefresh: UNDERSTAT_SCHEDULER_FORCE_REFRESH,
    });

    if (!response.ok || payload?.success === false) {
      const message = String(payload?.error ?? `HTTP ${response.status}`);
      understatSchedulerState.lastError = message;
      lastUpdate = {
        at: new Date(),
        success: false,
        message: `Sync Understat ${trigger} fallita: ${message}`,
      };
      await persistSchedulerRun({
        schedulerName: 'understat',
        trigger,
        startedAt,
        endedAt: new Date(),
        success: false,
        durationMs: Date.now() - startedAt.getTime(),
        error: message,
      });
      return;
    }

    const data = payload?.data ?? {};
    if (data?.alreadyRunning || data?.inProgress) {
      understatSchedulerState.lastError = 'Scheduler Understat saltato: import già in corso.';
      understatSchedulerState.lastDurationMs = Date.now() - startedAt.getTime();
      lastUpdate = {
        at: new Date(),
        success: true,
        message: 'Sync notturna saltata: un import era già in corso.',
      };
      await persistSchedulerRun({
        schedulerName: 'understat',
        trigger,
        startedAt,
        endedAt: new Date(),
        success: true,
        durationMs: Date.now() - startedAt.getTime(),
        summary: { skippedBecauseAlreadyRunning: true },
      });
      return;
    }

    understatSchedulerState.lastRunAt = new Date();
    understatSchedulerState.lastDurationMs = Date.now() - startedAt.getTime();
    understatSchedulerState.lastResult = {
      newMatchesImported: Number(data?.newMatchesImported ?? 0),
      existingMatchesUpdated: Number(data?.existingMatchesUpdated ?? 0),
      upcomingMatchesImported: Number(data?.upcomingMatchesImported ?? 0),
      playersUpdated: Number(data?.playersUpdated ?? 0),
      teamsRecomputed: Number(data?.teamsRecomputed ?? 0),
      isUpToDate: Boolean(data?.isUpToDate),
      message: String(data?.message ?? ''),
    };
    lastUpdate = {
      at: new Date(),
      success: true,
      message: data?.message
        ? String(data.message)
        : `Sync notturna completata: ${Number(data?.newMatchesImported ?? 0)} nuove partite importate.`,
    };
    console.log(
      `[understat-scheduler] ${trigger} run completed: new ${Number(data?.newMatchesImported ?? 0)}, updated ${Number(data?.existingMatchesUpdated ?? 0)}.`
    );
    await persistSchedulerRun({
      schedulerName: 'understat',
      trigger,
      startedAt,
      endedAt: new Date(),
      success: true,
      durationMs: Date.now() - startedAt.getTime(),
      summary: {
        newMatchesImported: Number(data?.newMatchesImported ?? 0),
        existingMatchesUpdated: Number(data?.existingMatchesUpdated ?? 0),
        upcomingMatchesImported: Number(data?.upcomingMatchesImported ?? 0),
        playersUpdated: Number(data?.playersUpdated ?? 0),
        teamsRecomputed: Number(data?.teamsRecomputed ?? 0),
        isUpToDate: Boolean(data?.isUpToDate),
      },
    });
  } catch (err: any) {
    const message = err?.message ?? 'Unknown understat scheduler error';
    understatSchedulerState.lastDurationMs = Date.now() - startedAt.getTime();
    understatSchedulerState.lastError = message;
    lastUpdate = {
      at: new Date(),
      success: false,
      message: `Sync Understat ${trigger} fallita: ${message}`,
    };
    await persistSchedulerRun({
      schedulerName: 'understat',
      trigger,
      startedAt,
      endedAt: new Date(),
      success: false,
      durationMs: Date.now() - startedAt.getTime(),
      error: message,
    });
  } finally {
    isUpdating = false;
    understatSchedulerState.running = false;
    scheduleNextUnderstatRun();
  }
}

function startUnderstatScheduler(): void {
  if (!UNDERSTAT_SCHEDULER_ENABLED) {
    console.log('[understat-scheduler] Disabled (UNDERSTAT_SCHEDULER_ENABLED=false)');
    return;
  }

  const { label } = parseDailyTime(UNDERSTAT_SCHEDULER_TIME);
  understatSchedulerState.time = label;
  console.log(
    `[understat-scheduler] Enabled | daily at ${label} | mode=${UNDERSTAT_SCHEDULER_MODE} | yearsBack=${UNDERSTAT_SCHEDULER_YEARS_BACK}`
  );
  scheduleNextUnderstatRun();
}

function scheduleNextOddsSnapshotRun(delayMs?: number): void {
  if (!ODDS_SNAPSHOT_SCHEDULER_ENABLED) {
    oddsSchedulerState.nextRunAt = null;
    return;
  }

  if (oddsSchedulerTimer) {
    clearTimeout(oddsSchedulerTimer);
  }
  const nextRunAt = delayMs !== undefined
    ? new Date(Date.now() + Math.max(1, Math.trunc(delayMs)))
    : computeNextDailyRun(ODDS_SNAPSHOT_SCHEDULER_TIME);
  oddsSchedulerState.nextRunAt = nextRunAt;
  oddsSchedulerTimer = setTimeout(() => {
    void runOddsSnapshotCapture('scheduled');
  }, Math.max(1000, nextRunAt.getTime() - Date.now()));
}

async function runOddsSnapshotCapture(trigger: 'boot' | 'scheduled'): Promise<void> {
  if (!ODDS_SNAPSHOT_SCHEDULER_ENABLED || oddsSchedulerState.running) {
    return;
  }

  const startedAt = new Date();
  const configuredApiKey = String(
    process.env.ODDS_API_KEY
      ?? process.env.THE_ODDS_API_KEY
      ?? ''
  ).trim();

  if (!configuredApiKey) {
    oddsSchedulerState.lastError = 'ODDS_API_KEY non configurata: scheduler quote non eseguito.';
    oddsSchedulerState.lastDurationMs = Date.now() - startedAt.getTime();
    await persistSchedulerRun({
      schedulerName: 'odds',
      trigger,
      startedAt,
      endedAt: new Date(),
      success: false,
      durationMs: Date.now() - startedAt.getTime(),
      error: oddsSchedulerState.lastError,
    });
    scheduleNextOddsSnapshotRun();
    return;
  }

  oddsSchedulerState.running = true;
  oddsSchedulerState.lastError = null;
  oddsSchedulerState.nextRunAt = null;
  const results: Array<{
    competition: string;
    success: boolean;
    matchesFound?: number;
    savedSnapshots?: number;
    remainingRequests?: number | null;
    error?: string;
  }> = [];

  try {
    for (const competition of ODDS_SNAPSHOT_COMPETITIONS) {
      try {
        const { response, payload } = await postInternal('/api/scraper/odds', {
          competition,
          markets: DEFAULT_ODDS_MARKETS,
        });
        const entry = {
          competition,
          success: response.ok && payload?.success !== false,
          matchesFound: Number(payload?.data?.matchesFound ?? 0),
          savedSnapshots: Number(payload?.data?.savedSnapshots ?? 0),
          remainingRequests:
            payload?.data?.remainingRequests === null || payload?.data?.remainingRequests === undefined
              ? null
              : Number(payload?.data?.remainingRequests),
          error: response.ok && payload?.success !== false ? undefined : String(payload?.error ?? `HTTP ${response.status}`),
        };
        results.push(entry);

        if (entry.remainingRequests !== null && entry.remainingRequests <= 10) {
          oddsSchedulerState.lastError = `Scheduler fermato: restano solo ${entry.remainingRequests} richieste The Odds API.`;
          break;
        }
      } catch (err: any) {
        results.push({
          competition,
          success: false,
          error: err?.message ?? 'Unknown scheduler error',
        });
      }
    }

    oddsSchedulerState.lastResults = results;
    oddsSchedulerState.lastRunAt = new Date();
    oddsSchedulerState.lastDurationMs = Date.now() - startedAt.getTime();

    const okCount = results.filter((item) => item.success).length;
    console.log(`[odds-scheduler] ${trigger} run completed: ${okCount}/${results.length} competitions updated.`);
    await persistSchedulerRun({
      schedulerName: 'odds',
      trigger,
      startedAt,
      endedAt: new Date(),
      success: !oddsSchedulerState.lastError && results.some((item) => item.success),
      durationMs: Date.now() - startedAt.getTime(),
      summary: {
        okCount,
        totalCompetitions: results.length,
        savedSnapshots: results.reduce((sum, item) => sum + Number(item.savedSnapshots ?? 0), 0),
      },
      error: oddsSchedulerState.lastError,
    });
  } finally {
    oddsSchedulerState.running = false;
    scheduleNextOddsSnapshotRun();
  }
}

function startOddsSnapshotScheduler(): void {
  if (!ODDS_SNAPSHOT_SCHEDULER_ENABLED) {
    console.log('[odds-scheduler] Disabled (ODDS_SNAPSHOT_SCHEDULER_ENABLED=false)');
    return;
  }

  const { label } = parseDailyTime(ODDS_SNAPSHOT_SCHEDULER_TIME);
  oddsSchedulerState.time = label;
  console.log(
    `[odds-scheduler] Enabled | daily at ${label} | competitions: ${ODDS_SNAPSHOT_COMPETITIONS.join(', ')}`
  );

  if (ODDS_SNAPSHOT_RUN_ON_BOOT) {
    oddsSchedulerState.nextRunAt = new Date(Date.now() + 20000);
    setTimeout(() => {
      void runOddsSnapshotCapture('boot');
    }, 20000);
    return;
  }

  scheduleNextOddsSnapshotRun();
}

function scheduleNextLearningReviewRun(delayMs?: number): void {
  if (!LEARNING_REVIEW_SCHEDULER_ENABLED) {
    learningSchedulerState.nextRunAt = null;
    return;
  }

  if (learningSchedulerTimer) {
    clearTimeout(learningSchedulerTimer);
  }
  const nextRunAt = delayMs !== undefined
    ? new Date(Date.now() + Math.max(1, Math.trunc(delayMs)))
    : computeNextDailyRun(LEARNING_REVIEW_SCHEDULER_TIME);
  learningSchedulerState.nextRunAt = nextRunAt;
  learningSchedulerTimer = setTimeout(() => {
    void runLearningReviewSync('scheduled');
  }, Math.max(1000, nextRunAt.getTime() - Date.now()));
}

async function runLearningReviewSync(trigger: 'boot' | 'scheduled'): Promise<void> {
  if (!LEARNING_REVIEW_SCHEDULER_ENABLED || learningSchedulerState.running) {
    return;
  }

  const startedAt = new Date();
  learningSchedulerState.running = true;
  learningSchedulerState.lastError = null;
  learningSchedulerState.nextRunAt = null;

  try {
    const { response, payload } = await postInternal('/api/learning/reviews/sync', {
      limit: LEARNING_REVIEW_MATCH_LIMIT,
      forceRefresh: false,
    });
    if (!response.ok || payload?.success === false) {
      learningSchedulerState.lastError = String(payload?.error ?? `HTTP ${response.status}`);
      learningSchedulerState.lastDurationMs = Date.now() - startedAt.getTime();
      await persistSchedulerRun({
        schedulerName: 'learning',
        trigger,
        startedAt,
        endedAt: new Date(),
        success: false,
        durationMs: Date.now() - startedAt.getTime(),
        error: learningSchedulerState.lastError,
      });
      return;
    }

    const data = payload?.data ?? {};
    learningSchedulerState.lastRunAt = new Date();
    learningSchedulerState.lastDurationMs = Date.now() - startedAt.getTime();
    learningSchedulerState.lastResult = {
      considered: Number(data?.considered ?? 0),
      created: Number(data?.created ?? 0),
      refreshed: Number(data?.refreshed ?? 0),
      skippedExisting: Number(data?.skippedExisting ?? 0),
      skippedNoSnapshot: Number(data?.skippedNoSnapshot ?? 0),
      skippedNoOdds: Number(data?.skippedNoOdds ?? 0),
      usedModelFallbackReviews: Number(data?.usedModelFallbackReviews ?? 0),
      adaptiveTuningReviews: Number(data?.adaptiveTuning?.totalReviews ?? 0),
    };
    console.log(
      `[learning-scheduler] ${trigger} run completed: created ${learningSchedulerState.lastResult.created ?? 0}, refreshed ${learningSchedulerState.lastResult.refreshed ?? 0}.`
    );
    await persistSchedulerRun({
      schedulerName: 'learning',
      trigger,
      startedAt,
      endedAt: new Date(),
      success: true,
      durationMs: Date.now() - startedAt.getTime(),
      summary: {
        considered: Number(data?.considered ?? 0),
        created: Number(data?.created ?? 0),
        refreshed: Number(data?.refreshed ?? 0),
      },
    });
  } catch (err: any) {
    learningSchedulerState.lastDurationMs = Date.now() - startedAt.getTime();
    learningSchedulerState.lastError = err?.message ?? 'Unknown learning scheduler error';
    await persistSchedulerRun({
      schedulerName: 'learning',
      trigger,
      startedAt,
      endedAt: new Date(),
      success: false,
      durationMs: Date.now() - startedAt.getTime(),
      error: learningSchedulerState.lastError,
    });
  } finally {
    learningSchedulerState.running = false;
    scheduleNextLearningReviewRun();
  }
}

function startLearningReviewScheduler(): void {
  if (!LEARNING_REVIEW_SCHEDULER_ENABLED) {
    console.log('[learning-scheduler] Disabled (LEARNING_REVIEW_SCHEDULER_ENABLED=false)');
    return;
  }

  const { label } = parseDailyTime(LEARNING_REVIEW_SCHEDULER_TIME);
  learningSchedulerState.time = label;
  console.log(
    `[learning-scheduler] Enabled | daily at ${label} | recent matches limit ${LEARNING_REVIEW_MATCH_LIMIT}`
  );

  if (LEARNING_REVIEW_RUN_ON_BOOT) {
    learningSchedulerState.nextRunAt = new Date(Date.now() + 30000);
    setTimeout(() => {
      void runLearningReviewSync('boot');
    }, 30000);
    return;
  }

  scheduleNextLearningReviewRun();
}

app.listen(PORT, () => {
  console.log(`Football Predictor Backend running on http://localhost:${PORT}`);
  console.log(`API available at http://localhost:${PORT}/api`);
  setTimeout(() => {
    void runBootDataSync();
  }, 1500);
  startUnderstatScheduler();
  startOddsSnapshotScheduler();
  startLearningReviewScheduler();
});

export default app;
