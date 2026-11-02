const test = require('node:test');
const assert = require('node:assert/strict');
const { createClient } = require('@libsql/client');
const { readFileSync, rmSync } = require('node:fs');
const { join } = require('node:path');
const { tmpdir } = require('node:os');
const { randomUUID } = require('node:crypto');
const express = require('express');
const { ResearchStore } = require('../dist/research/ResearchStore');
const { ManualModelBetService } = require('../dist/services/ManualModelBetService');
const { createApiRouter } = require('../dist/api/routes');
const START = '2026-11-02T12:00:00.000Z', KICKOFF = '2026-11-02T13:00:00.000Z';
async function setup(t, options = {}) {
  const path = join(tmpdir(), `manual-${randomUUID()}.db`);
  const client = createClient({ url: `file:${path}` });
  t.after(() => { client.close(); try { rmSync(path, { force: true }); } catch { /* Windows can release native DB handles after test teardown. */ } });
  for (const migration of ['015_research_platform.sql', '026_manual_model_bets.sql']) {
    await client.executeMultiple(readFileSync(join(__dirname, '../migrations', migration), 'utf8'));
  }
  await client.execute('CREATE TABLE matches(match_id TEXT PRIMARY KEY,date TEXT,home_goals INTEGER,away_goals INTEGER)');
  await client.execute({ sql: 'INSERT INTO matches VALUES (?,?,NULL,NULL)', args: ['fixture', KICKOFF] });
  const clock = () => new Date(START), research = new ResearchStore(client, async () => {}, { now: clock });
  await research.initializePortfolios();
  const captured = options.stale ? '2026-11-02T11:30:00.000Z' : START;
  const quote = { selection: 'homeWin', market: '1x2', side: 'home', odds: 2, bookmaker: 'Real Bookmaker', source: 'odds_api',
    priceType: 'prematch', capturedAt: captured, updatedAt: captured };
  const choice = { selection: 'homeWin', bookmakerOdds: 2, confidence: options.confidence || 'MEDIUM', marketTier: options.marketTier, ourProbability: 60 };
  const db = { research, getMatchById: async () => ({ match_id: 'fixture', date: KICKOFF, home_goals: null, away_goals: null,
    home_team_id: 'home', away_team_id: 'away', competition: 'Serie A', home_team_name: 'Home', away_team_name: 'Away' }),
  getLatestRealOddsSnapshotForMatch: async () => ({ source: 'odds_api', captured_at: captured,
    allBookmakerOdds: { 'Real Bookmaker': { homeWin: 2, draw: 3, awayWin: 4 } }, usedSyntheticOdds: options.synthetic }) };
  const service = new ManualModelBetService(db, { predict: async () => ({ canonicalRecommendation: { model: { version: 'A-current' }, selected: choice }, valueOpportunities: [choice] }) },
    { preview: async () => ({ status: 'RECOMMENDED', modelVersion: 'C-current', quote, recommendationPacket: { selected: choice } }) }, clock);
  const input = { family: 'A', matchId: 'fixture', selection: 'homeWin', bookmakerOdds: 2, bookmakerName: 'Real Bookmaker', stakeCents: 1000 };
  return { client, research, service, input };
}

test('manual A/C debit independent portfolios, merge into wallet reads and settle exactly once', async (t) => {
  const { client, research, service, input } = await setup(t);
  const a = await service.place(input), c = await service.place({ ...input, family: 'C' });
  assert.notEqual(a.betId, c.betId);
  for (const p of await research.listPortfolios()) { assert.equal(p.availableCents, 99000); assert.equal(p.committedCents, 1000); }
  const repeat = await service.place(input); assert.equal(repeat.betId, a.betId); assert.equal(repeat.alreadyRegistered, true);
  assert.equal((await research.listBets()).length, 2); assert.equal((await research.listBetViews()).length, 2);
  assert.equal((await research.listBetViews({ portfolioId: 'shadow_A' }))[0].snapshot.decisionMode, 'MANUAL');
  assert.equal((await service.evidence(a.betId)).decisions[0].origin, 'MANUAL');
  assert.equal((await client.execute('SELECT COUNT(*) AS n FROM research_jobs')).rows[0].n, 0);
  const evidence = { source: 'understat', homeGoals: 2, awayGoals: 0 };
  assert.equal((await research.settleBet(a.betId, 2, evidence)).settled, true);
  assert.equal((await research.settleBet(a.betId, 2, evidence)).settled, false);
  const after = await research.listPortfolios();
  assert.equal(after.find(x => x.family === 'A').availableCents, 101000);
  assert.equal(after.find(x => x.family === 'C').availableCents, 99000);
  assert.equal(await research.hasManualBet(client, 'shadow_A', 'fixture'), true);
});

test('price/bookmaker/selection/family/exposure mismatch cannot create a debit', async (t) => {
  const { research, service, input } = await setup(t);
  for (const changes of [{ family: 'B' }, { selection: 'awayWin' }, { bookmakerOdds: 3 }, { bookmakerName: 'Other' }, { stakeCents: 5001 }, { stakeCents: 100001 }]) {
    await assert.rejects(() => service.place({ ...input, ...changes }));
  }
  assert.equal((await research.listLedger()).length, 2); assert.equal((await research.listBets()).length, 0);
});

test('stale authentic quotes are archive-only and never move funds', async (t) => {
  const { research, service, input } = await setup(t, { stale: true, confidence: 'LOW' });
  await assert.rejects(() => service.place(input));
  await service.archive({ ...input, classification: 'LOW' }); await service.archive({ ...input, classification: 'LOW' });
  const records = await service.listArchives(); assert.equal(records.length, 1); assert.equal(records[0].family, 'A');
  assert.equal(records[0].snapshot.executionEligible, false); assert.equal(records[0].snapshot.quoteAgeSeconds, 1800);
  assert.equal((await research.listLedger()).length, 2);
});

test('speculative classification takes precedence over confidence', async (t) => {
  const { service, input } = await setup(t, { confidence: 'HIGH', marketTier: 'SPECULATIVE' });
  await service.archive({ ...input, classification: 'SPECULATIVE' });
  assert.equal((await service.listArchives())[0].classification, 'SPECULATIVE');
});

test('synthetic quotes and invented C LOW classification are rejected', async (t) => {
  const { service, input } = await setup(t, { synthetic: true });
  await assert.rejects(() => service.place(input)); await assert.rejects(() => service.archive({ ...input, classification: 'LOW' }));
  await assert.rejects(() => service.archive({ ...input, family: 'C', classification: 'LOW' }));
});

test('cache-only odds miss never instantiates a provider', async (t) => {
  let calls = 0;
  const app = express(); app.use(express.json());
  app.use('/api', createApiRouter({ db: { getLatestRealOddsSnapshotForMatch: async () => null }, svc: {},
    createOddsProviderCoordinatorBundle: () => { calls++; throw Error('provider forbidden'); } }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/scraper/odds/match`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ matchId: 'cache-only-fixture', homeTeam: 'Home', awayTeam: 'Away', cacheOnly: true }),
  });
  assert.equal(response.status, 200); assert.equal((await response.json()).data.found, false); assert.equal(calls, 0);
});

test('only an explicit single-match request opts into informational provider network', async (t) => {
  const previous = process.env.ODDS_INFORMATIONAL_NETWORK_ENABLED;
  process.env.ODDS_INFORMATIONAL_NETWORK_ENABLED = 'false';
  t.after(() => { if (previous === undefined) delete process.env.ODDS_INFORMATIONAL_NETWORK_ENABLED; else process.env.ODDS_INFORMATIONAL_NETWORK_ENABLED = previous; });
  const options = [];
  const app = express(); app.use(express.json());
  app.use('/api', createApiRouter({ db: { getLatestRealOddsSnapshotForMatch: async () => null }, svc: {},
    createOddsProviderCoordinatorBundle: (config) => { options.push(config); return { apiKey: '', primaryProviderName: 'odds_api', fallbackProviderName: null, coordinator: {} }; } }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  for (const requestNetwork of [false, true]) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/scraper/odds/match`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ matchId: 'explicit-fixture', homeTeam: 'Home', awayTeam: 'Away', cacheOnly: false, requestNetwork }),
    });
    assert.equal(response.status, 503);
  }
  assert.deepEqual(options.map(x => x.allowNetwork), [false, true]);
  assert.ok(options.every(x => x.priority === 'informational'));
});

test('refreshing a match skips both in-memory and persisted stale quotes', async (t) => {
  const markets = require('../dist/services/OddsMarketPolicy').enabledMatchEventMarkets();
  let calls = 0;
  const snapshot = { source: 'odds_api', captured_at: new Date(Date.now() - 20 * 60_000).toISOString(),
    selectedBookmakerName: 'Real Bookmaker', selectedOdds: { homeWin: 2, draw: 3, awayWin: 4 },
    allBookmakerOdds: { 'Real Bookmaker': { homeWin: 2, draw: 3, awayWin: 4 } }, marketsRequested: markets };
  const app = express(); app.use(express.json());
  app.use('/api', createApiRouter({ db: { getLatestRealOddsSnapshotForMatch: async () => snapshot }, svc: {},
    createOddsProviderCoordinatorBundle: (config) => { calls++; assert.equal(config.allowNetwork, true); assert.equal(config.cacheMaxAgeMs, 300000);
      return { apiKey: '', primaryProviderName: 'odds_api', fallbackProviderName: null, coordinator: {} }; } }));
  const server = app.listen(0, '127.0.0.1'); await new Promise(r => server.once('listening', r));
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  const url = `http://127.0.0.1:${server.address().port}/api/scraper/odds/match`;
  const send = body => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ matchId: 'stale-refresh-fixture', homeTeam: 'Home', awayTeam: 'Away', ...body }) });
  const cached = await send({ cacheOnly: true }); assert.equal((await cached.json()).data.found, true); assert.equal(calls, 0);
  const refreshed = await send({ cacheOnly: false, requestNetwork: true }); assert.equal(refreshed.status, 503); assert.equal(calls, 1);
});


test('C archives only its own computed LOW or speculative selection without moving funds', async (t) => {
  for (const options of [{confidence:'LOW'}, {confidence:'HIGH',marketTier:'SPECULATIVE'}]) {
    const {research, service, input} = await setup(t, options);
    const classification = options.marketTier || options.confidence;
    await service.archive({...input,family:'C',classification});
    assert.equal((await service.listArchives())[0].classification,classification);
    assert.equal((await research.listBets()).length,0);
    assert.equal((await research.listLedger()).length,2);
  }
});
