const test = require('node:test');
const assert = require('node:assert/strict');
const { buildResearchComparison, comparisonPeriod } = require('../dist/research/ResearchComparison');

const NOW = new Date('2026-10-29T12:00:00Z');
const PERIOD = { period: 'custom', from: '2026-10-20', to: '2026-10-29' };

function fixture() {
  const state = { portfolios: [], bets: [], ledger: [], decisions: [], jobs: [] };
  const store = Object.fromEntries(['Portfolios', 'Bets', 'Ledger', 'Decisions', 'Jobs'].map((name) =>
    [`list${name}`, async () => state[name.toLowerCase()]]));
  store.initializePortfolios = () => { throw new Error('A comparison GET must not create wallets'); };
  function open(family) {
    const id = `shadow_${family}`;
    state.portfolios.push({ id, family, equityCents: 100000, availableCents: 100000, committedCents: 0 });
    state.ledger.push({ id: `open:${id}`, portfolioId: id, event: 'OPEN', availableDeltaCents: 100000,
      committedDeltaCents: 0, createdAt: '2026-10-01T00:00:00Z' });
  }
  function bet(id, family, placedAt, { stakeCents = 1000, odds = 2, settledAt, multiplier, market = '1x2' } = {}) {
    const portfolioId = `shadow_${family}`;
    const row = { id, matchId: `match:${id}`, family, portfolioId, modelVersion: `${family}-fixture`, placedAt,
      stakeCents, odds, market, selection: 'homeWin', status: settledAt ? 'SETTLED' : 'PENDING',
      snapshot: { match: { matchId: `match:${id}`, homeTeam: 'Napoli', awayTeam: 'Roma', competition: 'Serie A', kickoffAt: '2026-10-29T20:00:00Z' },
        quote: { odds, bookmaker: 'Fixture bookmaker', source: 'odds_api', capturedAt: placedAt, updatedAt: placedAt, priceType: 'prematch' } } };
    state.ledger.push({ id: `stake:${id}`, portfolioId, betId: id, event: 'STAKE', availableDeltaCents: -stakeCents,
      committedDeltaCents: stakeCents, createdAt: placedAt });
    if (settledAt) {
      row.settledAt = settledAt; row.multiplier = multiplier; row.returnCents = Math.round(stakeCents * multiplier);
      row.profitCents = row.returnCents - stakeCents;
      state.ledger.push({ id: `settle:${id}`, portfolioId, betId: id, event: 'SETTLE', availableDeltaCents: row.returnCents,
        committedDeltaCents: -stakeCents, createdAt: settledAt });
    }
    state.bets.push(row);
    return row;
  }
  function balance() {
    for (const portfolio of state.portfolios) {
      const ledger = state.ledger.filter((row) => row.portfolioId === portfolio.id && Date.parse(row.createdAt) <= NOW.getTime());
      portfolio.availableCents = ledger.reduce((value, row) => value + row.availableDeltaCents, 0);
      portfolio.committedCents = ledger.reduce((value, row) => value + row.committedDeltaCents, 0);
      portfolio.equityCents = portfolio.availableCents + portfolio.committedCents;
    }
  }
  return { state, store, open, bet, balance };
}

test('comparison separates placement counts from settled profit, carries prior bets and preserves two wallets', async () => {
  const f = fixture(); f.open('A'); f.open('C');
  f.bet('old', 'A', '2026-10-18T10:00:00Z', { settledAt: '2026-10-20T20:00:00Z', multiplier: 2 });
  f.bet('loss', 'A', '2026-10-21T10:00:00Z', { stakeCents: 1010, settledAt: '2026-10-22T20:00:00Z', multiplier: 0 });
  f.bet('open', 'A', '2026-10-23T10:00:00Z', { stakeCents: 999 });
  f.bet('void', 'A', '2026-10-24T10:00:00Z', { stakeCents: 999, settledAt: '2026-10-25T20:00:00Z', multiplier: 1, market: 'dnb' });
  f.bet('not-yet-settled', 'A', '2026-10-26T10:00:00Z', { stakeCents: 999, settledAt: '2026-10-30T20:00:00Z', multiplier: 2 });
  f.bet('half-win', 'C', '2026-10-21T10:00:00Z', { settledAt: '2026-10-22T20:00:00Z', multiplier: 1.5, market: 'asian_handicap' });
  f.bet('half-loss', 'C', '2026-10-23T10:00:00Z', { stakeCents: 1005, settledAt: '2026-10-24T20:00:00Z', multiplier: .5, market: 'asian_handicap' });
  f.state.portfolios.push({ id: 'main', family: null, equityCents: 200000 });
  f.state.bets.push({ ...f.state.bets[0], id: 'legacy-main', portfolioId: 'main', placedAt: '2026-10-21T10:00:00Z' });
  f.balance();
  const output = await buildResearchComparison(f.store, PERIOD, NOW);
  const [a, c] = output.portfolios;
  assert.equal(output.portfolios.length, 2);
  assert.equal(a.portfolioId, 'shadow_A'); assert.equal(c.portfolioId, 'shadow_C');
  assert.equal(a.initialCents, 100000); assert.equal(c.initialCents, 100000);
  assert.equal(a.startEquityCents, 100000); assert.equal(a.endEquityCents, 99990);
  assert.equal(a.currentEquityCents, 99990); assert.equal(a.currentCommittedCents, 1998);
  assert.equal(a.profitCents, -10); assert.equal(a.roi, -10 / 3009);
  assert.equal(a.betCount, 4); assert.equal(a.stakeCents, 4007);
  assert.equal(a.settledCount, 3); assert.equal(a.settledStakeCents, 3009);
  assert.equal(a.openCount, 2); assert.equal(a.wonCount, 1); assert.equal(a.lostCount, 1); assert.equal(a.voidCount, 1);
  assert.equal(a.maxDrawdown, 1010 / 101000);
  assert.equal(c.profitCents, -2); assert.equal(c.currentEquityCents, 99998); assert.equal(c.roi, -2 / 2005);
  assert.equal(c.wonCount, 1); assert.equal(c.lostCount, 1);
  assert.equal(c.halfWonCount, 1); assert.equal(c.halfLostCount, 1);
  assert.equal(c.maxDrawdown, 502 / 100500);
  assert.equal(output.leader, 'C');
  assert.equal(output.bets.total, 6);
  const pending = output.bets.rows.find((row) => row.id === 'not-yet-settled');
  assert.equal(pending.status, 'PENDING'); assert.equal(pending.settledAt, null); assert.equal(pending.profitCents, null);
  assert.equal(pending.bookmaker, 'Fixture bookmaker'); assert.equal(pending.quote.source, 'odds_api');
  assert.equal(pending.matchLabel, 'Napoli – Roma');
  assert.equal(output.byLeague[0].label, 'Serie A'); assert.equal(output.byLeague[0].A.profitCents, -10);
  assert.equal(output.byMarket.find((row) => row.label === 'asian_handicap').C.halfLostCount, 1);
  assert.match(output.semantics.leader, /no claim of statistical/);
});

test('historical period does not leak subsequent settlement outcomes or subsequent equity movements', async () => {
  const f = fixture(); f.open('A'); f.open('C');
  f.bet('later-loss', 'A', '2026-10-21T10:00:00Z', { settledAt: '2026-10-25T20:00:00Z', multiplier: 0 });
  f.balance();
  const output = await buildResearchComparison(f.store, { period: 'custom', from: '2026-10-21', to: '2026-10-22' }, NOW);
  const a = output.portfolios[0];
  assert.equal(a.profitCents, 0); assert.equal(a.endEquityCents, 100000); assert.equal(a.currentEquityCents, 99000);
  assert.equal(a.betCount, 1); assert.equal(a.settledCount, 0); assert.equal(a.openCount, 1); assert.equal(a.roi, null);
  assert.equal(output.bets.rows[0].status, 'PENDING'); assert.equal(output.bets.rows[0].profitCents, null);
  assert.equal(output.leader, 'TIE');
});

test('opening capital is not profit and missing wallets are not silently initialized', async () => {
  const f = fixture();
  const missing = await buildResearchComparison(f.store, { period: 'all' }, NOW);
  assert.equal(missing.leader, null);
  assert.deepEqual(missing.portfolios.map((row) => row.initialized), [false, false]);
  assert.equal(missing.portfolios[0].initialCents, null); assert.equal(missing.portfolios[0].profitCents, null);
  assert.equal(missing.portfolios[0].roi, null); assert.deepEqual(missing.portfolios[0].equity, []);
  f.open('A'); f.open('C');
  const output = await buildResearchComparison(f.store, { period: 'all' }, NOW);
  assert.equal(output.portfolios[0].startEquityCents, 100000);
  assert.equal(output.portfolios[0].endEquityCents, 100000); assert.equal(output.portfolios[0].profitCents, 0);
  assert.equal(output.portfolios[0].roi, null); assert.equal(output.portfolios[0].maxDrawdown, 0);
  assert.equal(output.leader, 'TIE');
  assert.equal(output.period.from, '2026-10-01T00:00:00.000Z');
});

test('custom Rome calendar dates honor both DST transitions and reject invalid ranges', () => {
  const spring = comparisonPeriod({ period: 'custom', from: '2026-03-29', to: '2026-03-29' }, NOW);
  assert.equal(spring.from, '2026-03-28T23:00:00.000Z'); assert.equal(spring.to, '2026-03-29T22:00:00.000Z');
  assert.equal(Date.parse(spring.to) - Date.parse(spring.from), 23 * 3600000);
  const autumn = comparisonPeriod({ period: 'custom', from: '2026-10-25', to: '2026-10-25' }, NOW);
  assert.equal(autumn.from, '2026-10-24T22:00:00.000Z'); assert.equal(autumn.to, '2026-10-25T23:00:00.000Z');
  assert.equal(Date.parse(autumn.to) - Date.parse(autumn.from), 25 * 3600000);
  const week = comparisonPeriod({ period: '7d' }, NOW);
  assert.equal(week.from, '2026-10-22T22:00:00.000Z'); assert.equal(week.to, NOW.toISOString());
  assert.throws(() => comparisonPeriod({ period: 'custom', from: '2026-02-30', to: '2026-03-01' }, NOW), /calendar date/);
  assert.throws(() => comparisonPeriod({ period: 'custom', from: '2026-10-26', to: '2026-10-25' }, NOW), /precedes/);
  assert.throws(() => comparisonPeriod({ period: 'custom' }, NOW), /requires/);
  assert.throws(() => comparisonPeriod({ period: '1d' }, NOW), /period/);
});

test('decision differences compare complete A/C choices on shared jobs and preserve bookmaker provenance', async () => {
  const f = fixture(); f.open('A'); f.open('C');
  const quote = { odds: 2.3, bookmaker: 'Actual bookmaker', source: 'odds_api', capturedAt: '2026-10-21T01:00:00Z', updatedAt: '2026-10-21T01:00:00Z' };
  function decision(jobId, family, action, selection = 'homeWin', market = '1x2', q = quote) {
    f.state.decisions.push({ id: `${jobId}:${family}`, jobId, family, portfolioId: `shadow_${family}`, action, selection, market,
      modelVersion: `${family}-fixture`, createdAt: '2026-10-21T01:00:01Z', snapshot: { quote: q, probability: family === 'A' ? .6 : .7 } });
  }
  f.state.jobs.push({ id: 'different', matchId: 'real-fixture-id', kickoffAt: '2026-10-21T20:00:00Z' });
  decision('different', 'A', 'BET'); decision('different', 'C', 'BET', 'over25', 'totals');
  decision('same-bet', 'A', 'BET'); decision('same-bet', 'C', 'BET');
  decision('same-abstain', 'A', 'ABSTAIN'); decision('same-abstain', 'C', 'ABSTAIN', 'anything');
  decision('only-a-bets', 'A', 'BET'); decision('only-a-bets', 'C', 'ABSTAIN');
  decision('incomplete', 'A', 'BET');
  f.state.decisions.push({ ...f.state.decisions[0], id: 'main', portfolioId: 'main' });
  const output = await buildResearchComparison(f.store, PERIOD, NOW);
  assert.equal(output.decisionDifferences.comparedCount, 4); assert.equal(output.decisionDifferences.differentCount, 2);
  assert.equal(output.decisionDifferences.sameCount, 2); assert.equal(output.decisionDifferences.incompleteCount, 1);
  const choice = output.decisionDifferences.rows.find((row) => row.matchId === 'real-fixture-id');
  assert.equal(choice.matchLabel, 'real-fixture-id'); assert.equal(choice.league, null);
  assert.equal(choice.kickoffAt, '2026-10-21T20:00:00Z');
  assert.deepEqual(choice.A.quote, quote); assert.equal(choice.A.bookmaker, 'Actual bookmaker');
  assert.equal(choice.C.market, 'totals');
});

test('totals and economics use all rows before independently truncating visible bet history', async () => {
  const f = fixture(); f.open('A'); f.open('C');
  const base = Date.parse('2026-10-25T12:00:00Z');
  for (let i = 0; i < 501; i++) f.bet(`fixture-${i}`, 'A', new Date(base + i * 1000).toISOString(), {
    settledAt: new Date(base + i * 1000 + 500).toISOString(), multiplier: 1,
  });
  f.balance();
  const output = await buildResearchComparison(f.store, PERIOD, NOW);
  assert.equal(output.bets.total, 501); assert.equal(output.bets.rows.length, 500); assert.equal(output.bets.truncated, true);
  assert.equal(output.portfolios[0].betCount, 501); assert.equal(output.portfolios[0].settledCount, 501);
  assert.equal(output.portfolios[0].stakeCents, 501000); assert.equal(output.portfolios[0].settledStakeCents, 501000);
  assert.equal(output.portfolios[0].profitCents, 0); assert.equal(output.portfolios[0].roi, 0);
  assert.equal(output.portfolios[0].endEquityCents, 100000);
  assert.equal(output.portfolios[0].equity.length, 1, 'unchanged equity is not expanded into redundant stake/void chart points');
  assert.equal(output.byLeague[0].A.betCount, 501);
});
