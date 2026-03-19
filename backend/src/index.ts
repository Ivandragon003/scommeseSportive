import cors from 'cors';
import express from 'express';
import routes from './api/routes';

const app = express();
const PORT = Number(process.env.PORT ?? 3001);
const AUTO_SYNC_ON_BOOT =
  String(process.env.AUTO_SYNC_ON_BOOT ?? 'true').trim().toLowerCase() !== 'false';
const ODDS_SNAPSHOT_SCHEDULER_ENABLED =
  String(process.env.ODDS_SNAPSHOT_SCHEDULER_ENABLED ?? 'false').trim().toLowerCase() === 'true';
const ODDS_SNAPSHOT_RUN_ON_BOOT =
  String(process.env.ODDS_SNAPSHOT_RUN_ON_BOOT ?? 'false').trim().toLowerCase() === 'true';
const ODDS_SNAPSHOT_INTERVAL_HOURS = Math.max(
  6,
  Math.min(Number(process.env.ODDS_SNAPSHOT_INTERVAL_HOURS ?? 24), 168)
);
const LEARNING_REVIEW_SCHEDULER_ENABLED =
  String(process.env.LEARNING_REVIEW_SCHEDULER_ENABLED ?? 'false').trim().toLowerCase() === 'true';
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
let oddsSchedulerTimer: NodeJS.Timeout | null = null;
let learningSchedulerTimer: NodeJS.Timeout | null = null;

const oddsSchedulerState: {
  enabled: boolean;
  running: boolean;
  runOnBoot: boolean;
  intervalHours: number;
  competitions: string[];
  markets: string[];
  lastRunAt: Date | null;
  nextRunAt: Date | null;
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
  runOnBoot: ODDS_SNAPSHOT_RUN_ON_BOOT,
  intervalHours: ODDS_SNAPSHOT_INTERVAL_HOURS,
  competitions: ODDS_SNAPSHOT_COMPETITIONS,
  markets: DEFAULT_ODDS_MARKETS,
  lastRunAt: null,
  nextRunAt: null,
  lastError: null,
  lastResults: [],
};

const learningSchedulerState: {
  enabled: boolean;
  running: boolean;
  runOnBoot: boolean;
  intervalHours: number;
  matchLimit: number;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  lastError: string | null;
  lastResult: {
    considered?: number;
    created?: number;
    refreshed?: number;
    skippedExisting?: number;
    skippedNoSnapshot?: number;
    skippedNoOdds?: number;
    adaptiveTuningReviews?: number;
  } | null;
} = {
  enabled: LEARNING_REVIEW_SCHEDULER_ENABLED,
  running: false,
  runOnBoot: LEARNING_REVIEW_RUN_ON_BOOT,
  intervalHours: LEARNING_REVIEW_INTERVAL_HOURS,
  matchLimit: LEARNING_REVIEW_MATCH_LIMIT,
  lastRunAt: null,
  nextRunAt: null,
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

app.get('/api/scraper/status', (_req, res) => {
  res.json({
    success: true,
    data: {
      isUpdating,
      lastUpdate,
      autoSyncEnabled: AUTO_SYNC_ON_BOOT,
      oddsSnapshotScheduler: oddsSchedulerState,
      learningReviewScheduler: learningSchedulerState,
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
  console.log('[bootstrap-sync] Starting automatic FotMob + Transfermarkt sync for all top 5 leagues...');
  try {
    const maxAttempts = 3;
    let lastErrorMessage = 'Unknown error';
    let completed = false;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const response = await fetch(`http://127.0.0.1:${PORT}/api/scraper/fotmob`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            mode: 'top5',
            yearsBack: 2,
            importPlayers: false,
            includeMatchDetails: false,
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

function scheduleNextOddsSnapshotRun(delayMs?: number): void {
  if (!ODDS_SNAPSHOT_SCHEDULER_ENABLED) {
    oddsSchedulerState.nextRunAt = null;
    return;
  }

  const intervalMs = Math.max(1, Math.trunc((delayMs ?? ODDS_SNAPSHOT_INTERVAL_HOURS * 60 * 60 * 1000)));
  if (oddsSchedulerTimer) {
    clearTimeout(oddsSchedulerTimer);
  }
  oddsSchedulerState.nextRunAt = new Date(Date.now() + intervalMs);
  oddsSchedulerTimer = setTimeout(() => {
    void runOddsSnapshotCapture('scheduled');
  }, intervalMs);
}

async function runOddsSnapshotCapture(trigger: 'boot' | 'scheduled'): Promise<void> {
  if (!ODDS_SNAPSHOT_SCHEDULER_ENABLED || oddsSchedulerState.running) {
    return;
  }

  const configuredApiKey = String(
    process.env.ODDS_API_KEY
      ?? process.env.THE_ODDS_API_KEY
      ?? ''
  ).trim();

  if (!configuredApiKey) {
    oddsSchedulerState.lastError = 'ODDS_API_KEY non configurata: scheduler quote non eseguito.';
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

    const okCount = results.filter((item) => item.success).length;
    console.log(`[odds-scheduler] ${trigger} run completed: ${okCount}/${results.length} competitions updated.`);
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

  console.log(
    `[odds-scheduler] Enabled | every ${ODDS_SNAPSHOT_INTERVAL_HOURS}h | competitions: ${ODDS_SNAPSHOT_COMPETITIONS.join(', ')}`
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

  const intervalMs = Math.max(1, Math.trunc((delayMs ?? LEARNING_REVIEW_INTERVAL_HOURS * 60 * 60 * 1000)));
  if (learningSchedulerTimer) {
    clearTimeout(learningSchedulerTimer);
  }
  learningSchedulerState.nextRunAt = new Date(Date.now() + intervalMs);
  learningSchedulerTimer = setTimeout(() => {
    void runLearningReviewSync('scheduled');
  }, intervalMs);
}

async function runLearningReviewSync(trigger: 'boot' | 'scheduled'): Promise<void> {
  if (!LEARNING_REVIEW_SCHEDULER_ENABLED || learningSchedulerState.running) {
    return;
  }

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
      return;
    }

    const data = payload?.data ?? {};
    learningSchedulerState.lastRunAt = new Date();
    learningSchedulerState.lastResult = {
      considered: Number(data?.considered ?? 0),
      created: Number(data?.created ?? 0),
      refreshed: Number(data?.refreshed ?? 0),
      skippedExisting: Number(data?.skippedExisting ?? 0),
      skippedNoSnapshot: Number(data?.skippedNoSnapshot ?? 0),
      skippedNoOdds: Number(data?.skippedNoOdds ?? 0),
      adaptiveTuningReviews: Number(data?.adaptiveTuning?.totalReviews ?? 0),
    };
    console.log(
      `[learning-scheduler] ${trigger} run completed: created ${learningSchedulerState.lastResult.created ?? 0}, refreshed ${learningSchedulerState.lastResult.refreshed ?? 0}.`
    );
  } catch (err: any) {
    learningSchedulerState.lastError = err?.message ?? 'Unknown learning scheduler error';
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

  console.log(
    `[learning-scheduler] Enabled | every ${LEARNING_REVIEW_INTERVAL_HOURS}h | recent matches limit ${LEARNING_REVIEW_MATCH_LIMIT}`
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
  startOddsSnapshotScheduler();
  startLearningReviewScheduler();
});

export default app;
