// Offline CPU benchmark: synthetic matches, real models, local in-memory libSQL cache.
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { createClient } = require('@libsql/client');
const { DatabaseService } = require('../dist/db/DatabaseService.js');
const { PredictionService } = require('../dist/services/PredictionService.js');
const { DixonColesModel } = require('../dist/models/core/DixonColesModel.js');

const DAY = 86400000;
const rows = [];
for (let season = 0; season < 5; season++) {
  for (let round = 0; round < 38; round++) {
    for (let pair = 0; pair < 10; pair++) {
      const home = (pair + round) % 20;
      const away = (home + 1 + round % 19) % 20;
      rows.push({
        match_id: `fixture-${rows.length}`, home_team_id: `team-${home}`, away_team_id: `team-${away}`,
        date: new Date(Date.UTC(2021 + season, 7, 7) + round * 7 * DAY + pair * 3600000).toISOString(),
        competition: 'Synthetic league', season: `${2021 + season}/${2022 + season}`,
        home_goals: (round + pair * 3) % 4, away_goals: (round * 2 + pair) % 3,
        home_xg: 0.6 + (round + pair) % 12 / 6, away_xg: 0.4 + (round * 3 + pair) % 10 / 6,
        home_shots: 10 + pair, away_shots: 8 + pair,
        home_shots_on_target: 3 + pair % 4, away_shots_on_target: 2 + pair % 3,
        home_yellow_cards: pair % 4, away_yellow_cards: round % 4, home_red_cards: 0, away_red_cards: 0,
        home_corners: 4 + pair % 4, away_corners: 3 + pair % 3,
        home_fouls: 9 + pair, away_fouls: 10 + pair,
      });
    }
  }
}
const odds = Object.fromEntries(rows.map((row) => [row.match_id, {
  odds: { homeWin: 2.2, draw: 3.3, awayWin: 3.4, over25: 1.95, under25: 1.95 },
}]));

async function run() {
  const client = createClient({ url: 'file::memory:' });
  const originalFit = DixonColesModel.prototype.fitModel;
  let fits = 0;
  DixonColesModel.prototype.fitModel = function (...args) { fits++; return originalFit.apply(this, args); };
  try {
    await client.executeMultiple(readFileSync(join(__dirname, '../migrations/014_runtime_calibration_cache.sql'), 'utf8'));
    const database = Object.create(DatabaseService.prototype);
    database.db = client;
    database.initPromise = Promise.resolve();
    database.getMatches = async () => rows;
    database.getHistoricalOddsDetailMap = async () => odds;
    const createService = () => new PredictionService(database, {
      getMatchDetails: async () => { throw new Error('Provider calls are forbidden in this offline benchmark'); },
    });
    const asOf = new Date(Date.UTC(2026, 9, 17));
    const measure = async (label, service, force = false) => {
      const start = performance.now();
      const cpu = process.cpuUsage();
      const previousFits = fits;
      const profile = await service.getCalibrationProfile('Synthetic league', force, asOf);
      const consumed = process.cpuUsage(cpu);
      console.log(JSON.stringify({
        label, matches: rows.length, elapsedMs: Math.round(performance.now() - start),
        cpuMs: Math.round((consumed.user + consumed.system) / 1000), fits: fits - previousFits,
        observations: profile.nObservations,
      }));
      return profile;
    };
    const first = createService();
    const cold = await measure('cold-complete-calculation', first);
    assert.deepEqual(await measure('same-process-memory-cache', first), cold);
    const previousFits = fits;
    assert.deepEqual(await measure('new-service-persisted-profile', createService()), cold);
    assert.equal(fits, previousFits, 'the persisted path must execute no historical fits');
    console.log('Profiles are deeply identical. These local synthetic timings exclude hosting and remote DB latency.');
  } finally {
    DixonColesModel.prototype.fitModel = originalFit;
    client.close();
  }
}
run().catch((error) => { console.error(error); process.exitCode = 1; });
