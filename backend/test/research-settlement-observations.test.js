const test = require('node:test');
const assert = require('node:assert/strict');
const { settleResearchBets } = require('../dist/research/ResearchRuntime');

const baseQuote = { selection: 'awayWin', market: '1x2', side: 'away', odds: 2,
  bookmaker: 'Test Bookmaker', source: 'odds_api', capturedAt: '2026-01-01T10:00:00Z', updatedAt: '2026-01-01T10:00:00Z' };
async function scenario(home, away, family = 'C', quote = baseQuote) {
  const writes = [];
  const match = { home_goals: home, away_goals: away, date: '2026-01-01T12:00:00Z', source: 'understat' };
  const db = { getMatchById: async () => match, research: {
    listBets: async () => [{ id: 'test', matchId: 'fixture', family, executionDecisionId: family === 'A' ? 'execution' : null, snapshot: { quote } }],
    settleBet: async (...args) => { writes.push(args); return { settled: true }; },
  } };
  return { summary: await settleResearchBets(db), writes };
}

test('settlement refuses missing and invalid score inputs for both families', async () => {
  const invalid = [null, undefined, '', ' ', true, false, NaN, Infinity, -1, '-1', 1.5, '2.5', 'not-a-score', {}, Number.MAX_SAFE_INTEGER + 1];
  for (const family of ['A', 'C']) for (const value of invalid) for (const side of ['home', 'away']) {
    const result = await scenario(side === 'home' ? value : 1, side === 'away' ? value : 1, family);
    assert.deepEqual(result.summary, { checked: 1, settled: 0, unresolved: 1 }, `${family} ${side}: ${String(value)}`);
    assert.equal(result.writes.length, 0);
  }
});

test('settlement preserves real zeros and numeric strings for both families', async () => {
  for (const family of ['A', 'C']) for (const zero of [0, '0']) {
    const result = await scenario(zero, '1', family);
    assert.deepEqual(result.summary, { checked: 1, settled: 1, unresolved: 0 });
    assert.equal(result.writes[0][1], 2);
    assert.equal(result.writes[0][2].homeGoals, 0);
    assert.equal(result.writes[0][2].awayGoals, 1);
  }
});

test('a missing fixture remains unresolved without attempting settlement', async () => {
  const db = { getMatchById: async () => null, research: {
    listBets: async () => [{ id: 'missing-fixture', matchId: 'absent' }],
    settleBet: async () => assert.fail('missing fixture must never settle'),
  } };
  assert.deepEqual(await settleResearchBets(db), { checked: 1, settled: 0, unresolved: 1 });
});

test('valid Asian handicap outcome and payout remain unchanged', async () => {
  const quote = { ...baseQuote, selection: 'ahcp_away_0.25', market: 'asian_handicap', side: 'away', line: 0.25 };
  for (const family of ['A', 'C']) {
    const result = await scenario(1, 1, family, quote);
    assert.equal(result.summary.settled, 1);
    assert.equal(result.writes[0][1], 1.5);
    assert.equal(result.writes[0][2].status, 'HALF_WON');
  }
});

test('a completed or live provider event cannot rewrite a future kickoff', async () => {
  const { ResearchRuntime } = require('../dist/research/ResearchRuntime');
  const now = '2026-01-02T12:00:00.000Z';
  const kickoff = '2026-01-02T14:00:00.000Z';
  const fixture = { match_id: 'fixture', home_team_id: 'h', away_team_id: 'a', home_team_name: 'Home', away_team_name: 'Away',
    date: kickoff, competition: 'Serie A', season: '2025/26', home_goals: null, away_goals: null };
  const job = { id: 'job', matchId: 'fixture', kickoffAt: kickoff, targetAt: now, leaseToken: 'lease' };
  const cases = [
    { commenceTime: '2026-01-01T14:00:00.000Z', completed: true },
    { commenceTime: '2026-01-02T15:00:00.000Z', live: true },
    { commenceTime: '2026-01-02T15:00:00.000Z', completed: true },
  ];
  for (const override of cases) {
    const updates = [];
    const event = { matchId: 'event', homeTeam: 'Home', awayTeam: 'Away', provider: 'odds_api',
      capturedAt: now, bookmakers: [], live: false, completed: false, ...override };
    const db = { research: {}, getMatchById: async () => fixture, updateMatchKickoff: async (...args) => updates.push(args),
      saveSchedulerRun: async () => {} };
    const runtime = new ResearchRuntime(db, { clock: () => new Date(now),
      odds: { getOdds: async () => [event] }, nightly: { quoteMaxAgeMs: 300000 } });
    const result = await runtime.prepareNightly(job);
    assert.equal(result.status, 'started');
    assert.deepEqual(updates, []);
  }
});

test('a matching future provider event still reports and stores its shifted kickoff', async () => {
  const { ResearchRuntime } = require('../dist/research/ResearchRuntime');
  const now = '2026-01-02T12:00:00.000Z', kickoff = '2026-01-02T14:00:00.000Z', shifted = '2026-01-02T15:00:00.000Z';
  const fixture = { match_id: 'fixture', home_team_id: 'h', away_team_id: 'a', home_team_name: 'Home', away_team_name: 'Away',
    date: kickoff, competition: 'Serie A', season: '2025/26', home_goals: null, away_goals: null };
  const updates = [];
  const db = { research: {}, getMatchById: async () => fixture, updateMatchKickoff: async (...args) => updates.push(args),
    saveSchedulerRun: async () => {} };
  const event = { matchId: 'event', homeTeam: 'Home', awayTeam: 'Away', provider: 'odds_api', commenceTime: shifted,
    capturedAt: now, bookmakers: [], live: false, completed: false };
  const runtime = new ResearchRuntime(db, { clock: () => new Date(now), odds: { getOdds: async () => [event] }, nightly: { quoteMaxAgeMs: 300000 } });
  const result = await runtime.prepareNightly({ id: 'job', matchId: 'fixture', kickoffAt: kickoff, targetAt: now, leaseToken: 'lease' });
  assert.equal(result.status, 'upcoming');
  assert.equal(result.kickoffAt, shifted);
  assert.deepEqual(updates, [['fixture', shifted]]);
});


test('a past changed kickoff without explicit live or completed status preserves rescheduling', async () => {
  const { ResearchRuntime } = require('../dist/research/ResearchRuntime');
  const now = '2026-01-02T12:00:00.000Z', kickoff = '2026-01-02T14:00:00.000Z', shifted = '2026-01-02T11:55:00.000Z';
  const fixture = { match_id: 'fixture', home_team_id: 'h', away_team_id: 'a', home_team_name: 'Home', away_team_name: 'Away',
    date: kickoff, competition: 'Serie A', season: '2025/26', home_goals: null, away_goals: null };
  const updates = [];
  const db = { research: {}, getMatchById: async () => fixture, updateMatchKickoff: async (...args) => updates.push(args),
    saveSchedulerRun: async () => {} };
  const event = { matchId: 'event', homeTeam: 'Home', awayTeam: 'Away', provider: 'odds_api', commenceTime: shifted,
    capturedAt: now, bookmakers: [], live: false, completed: false };
  const runtime = new ResearchRuntime(db, { clock: () => new Date(now), odds: { getOdds: async () => [event] }, nightly: { quoteMaxAgeMs: 300000 } });
  const result = await runtime.prepareNightly({ id: 'job', matchId: 'fixture', kickoffAt: kickoff, targetAt: now, leaseToken: 'lease' });
  assert.equal(result.status, 'upcoming');
  assert.equal(result.kickoffAt, shifted);
  assert.deepEqual(updates, [['fixture', shifted]]);
});
