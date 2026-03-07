import express from 'express';
import cors from 'cors';
import routes from './api/routes';

const app = express();
const PORT = process.env.PORT ?? 3001;
const AUTO_SYNC_ON_BOOT =
  String(process.env.AUTO_SYNC_ON_BOOT ?? 'true').trim().toLowerCase() !== 'false';

app.use(cors({ origin: 'http://localhost:3000' }));
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, _res, next) => {
  if (req.path === '/api/health') {
    return next();
  }
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

app.use('/api', routes);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ success: false, error: 'Not found' });
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(err.stack);
  res.status(500).json({ success: false, error: err.message });
});

async function runBootDataSync(): Promise<void> {
  if (!AUTO_SYNC_ON_BOOT) {
    console.log('[bootstrap-sync] Disabled (AUTO_SYNC_ON_BOOT=false)');
    return;
  }

  console.log('[bootstrap-sync] Starting automatic FotMob + Transfermarkt sync...');
  try {
    const response = await fetch(`http://localhost:${PORT}/api/scraper/fotmob`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'single',
        competition: 'Serie A',
        yearsBack: 2,
        importPlayers: false,
        includeMatchDetails: false,
        forceRefresh: false,
      }),
    });

    const payload: any = await response.json().catch(() => ({}));
    if (!response.ok || payload?.success === false) {
      console.error('[bootstrap-sync] Failed:', payload?.error ?? `HTTP ${response.status}`);
      return;
    }

    const data = payload?.data ?? {};
    console.log(
      `[bootstrap-sync] Done. New matches: ${Number(data?.newMatchesImported ?? 0)}, ` +
      `updated: ${Number(data?.existingMatchesUpdated ?? 0)}.`,
    );
  } catch (err: any) {
    console.error('[bootstrap-sync] Error:', err?.message ?? err);
  }
}

app.listen(PORT, () => {
  console.log(`Football Predictor Backend running on http://localhost:${PORT}`);
  console.log(`API available at http://localhost:${PORT}/api`);
  setTimeout(() => {
    void runBootDataSync();
  }, 1500);
});

export default app;
