const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { createClient } = require('@libsql/client');
const feedModule = require('../dist/services/FootballDataOrgFeed');
const storeModule = require('../dist/services/SourceFeedStore');
const readinessModule = require('../dist/services/SourceFeedReadiness');
const { FOOTBALL_DATA_COMPETITIONS } = require('../dist/services/modelAResearchCalendar');
const { normalizeFootballDataOrgFeed, collectFootballDataOrgFeeds, SOURCE_FEED_COOLDOWN_MS } = feedModule;
const { SOURCE_FEED_TRANSIENT_FAILURE_REASONS, SOURCE_FEED_TRANSIENT_FAILURE_BACKOFF_MS } = feedModule;
const { SourceFeedStore } = storeModule;
const { runSourceFeedCollector, localDatabasePath } = require('../scripts/collect-source-feeds');
const timestamp = '2026-11-05T12:00:00.000Z';

function payload(competition = 'PL') {
  const count = ['BL1', 'FL1'].includes(competition) ? 18 : 20;
  const season = { id: 1001, startDate: '2026-08-01', endDate: '2027-05-31' };
  const matches = [];
  for (let home = 1; home <= count; home++) for (let away = 1; away <= count; away++) if (home !== away) {
    matches.push({ id: matches.length + 1, competition: { id: FOOTBALL_DATA_COMPETITIONS[competition], code: competition }, season,
      utcDate: '2026-08-02T12:00:00Z', status: 'FINISHED', lastUpdated: '2026-08-02T15:00:00Z',
      homeTeam: { id: home, name: `Team ${home}` }, awayTeam: { id: away, name: `Team ${away}` },
      score: { fullTime: { home: 0, away: 0 } } });
  }
  return { competition: { id: FOOTBALL_DATA_COMPETITIONS[competition], code: competition }, filters: { season: '2026' }, season, matches };
}
const normalize = (data = payload(), competition = 'PL', acquiredAt = timestamp) => normalizeFootballDataOrgFeed({ payload: data, competition, season: 2026, acquiredAt });
async function cache(t) {
  const client = createClient({ url: 'file::memory:' });
  t.after(() => client.close());
  const store = new SourceFeedStore(client);
  await store.initialize({ allowCreate: true });
  return { client, store };
}

test('full source calendars retain provider namespaces, genuine zeros, unknown publication and unsupported fields', () => {
  for (const competition of Object.keys(FOOTBALL_DATA_COMPETITIONS)) {
    const snapshot = normalize(payload(competition), competition);
    assert.equal(snapshot.coverage.expectedTeams, ['BL1', 'FL1'].includes(competition) ? 18 : 20);
    assert.equal(snapshot.coverage.calendarComplete, true);
    assert.equal(snapshot.coverage.results, snapshot.coverage.expectedFixtures);
    assert.match(snapshot.fixtures[0].id, /^football-data\.org:match:/);
    assert.match(snapshot.fixtures[0].homeTeamId, /^football-data\.org:team:/);
    assert.match(snapshot.seasonId, /^football-data\.org:competition:\d+:season:2026$/);
    assert.equal(snapshot.fixtures[0].homeGoals, 0);
    assert.equal(snapshot.fixtures[0].resultAvailable, true);
    assert.equal(snapshot.providerPublishedAt, null);
    assert.equal(snapshot.fixtures[0].providerPublishedAt, null);
    for (const field of ['xg', 'shots', 'shotsOnTarget', 'yellowCards', 'redCards', 'playerStats', 'odds']) {
      assert.deepEqual(snapshot.fieldAvailability[field], { supported: false, available: false, reason: 'not_provided_by_this_feed' });
      assert.equal(snapshot.fixtures[0][field], undefined);
    }
  }
});

test('missing final scores remain null and live/provisional scores cannot become completed results', () => {
  const data = payload();
  data.matches[0].score.fullTime.away = null;
  data.matches[1].status = 'IN_PLAY';
  data.matches[1].score.fullTime = { home: 2, away: 3 };
  const snapshot = normalize(data);
  assert.equal(snapshot.fixtures[0].homeGoals, 0);
  assert.equal(snapshot.fixtures[0].awayGoals, null);
  assert.equal(snapshot.fixtures[0].resultUnavailableReason, 'finished_score_unavailable');
  assert.equal(snapshot.fixtures[1].homeGoals, null);
  assert.equal(snapshot.fixtures[1].awayGoals, null);
  assert.equal(snapshot.fixtures[1].resultUnavailableReason, 'fixture_not_finished');
  assert.equal(snapshot.coverage.missingFinishedResults, 1);
  assert.equal(snapshot.fieldAvailability.results.available, false);
});

for (const [name, mutate, reason] of [
  ['competition', (data) => { data.competition.id = 1; }, 'source_feed_scope_mismatch'],
  ['season filter', (data) => { data.filters.season = 2025; }, 'source_feed_scope_mismatch'],
  ['nested competition', (data) => { data.matches[0].competition.id = 1; }, 'source_feed_nested_competition_mismatch'],
  ['nested season', (data) => { data.matches[0].season = { id: 1002, startDate: '2026-08-01' }; }, 'source_feed_nested_season_mismatch'],
  ['duplicate ID', (data) => { data.matches[1].id = data.matches[0].id; }, 'source_feed_duplicate_fixture'],
  ['duplicate pair', (data) => { data.matches[1].awayTeam.id = data.matches[0].awayTeam.id; }, 'source_feed_duplicate_pair'],
  ['partial calendar', (data) => { data.matches.pop(); }, 'source_feed_calendar_incomplete'],
  ['invalid identity', (data) => { data.matches[0].id = '1'; }, 'source_feed_invalid_fixture'],
  ['invalid status', (data) => { data.matches[0].status = 'DONE'; }, 'source_feed_invalid_fixture'],
  ['invalid kickoff', (data) => { data.matches[0].utcDate = '2026-02-30T12:00:00Z'; }, 'source_feed_invalid_kickoff'],
  ['wrong kickoff season', (data) => { data.matches[0].utcDate = '2025-08-02T12:00:00Z'; }, 'source_feed_kickoff_outside_season'],
  ['future revision', (data) => { data.matches[0].lastUpdated = '2026-11-06T12:00:00Z'; }, 'source_feed_invalid_provider_update'],
]) test(`strict source normalizer rejects ${name}`, () => {
  const data = payload();
  // Break fixture references intentionally so mutations affect one row only.
  const detached = structuredClone(data);
  detached.matches = detached.matches.map((match) => structuredClone(match));
  mutate(detached);
  assert.throws(() => normalize(detached), { message: reason });
});

for (const invalid of [true, '', '0', -1, 0.5]) test(`final score ${JSON.stringify(invalid)} is never coerced into a count`, () => {
  const data = payload(); data.matches[0].score.fullTime.home = invalid;
  assert.throws(() => normalize(data), { message: 'source_feed_invalid_final_score' });
});

test('source cache initialization refuses any operational or unmarked existing schema', async (t) => {
  const client = createClient({ url: 'file::memory:' }); t.after(() => client.close());
  await client.execute('CREATE TABLE matches (id INTEGER PRIMARY KEY, home_goals INTEGER)');
  await client.execute('INSERT INTO matches VALUES (1,0)');
  await assert.rejects(new SourceFeedStore(client).initialize({ allowCreate: true }), { message: 'source_feed_database_not_dedicated' });
  assert.equal((await client.execute('SELECT home_goals FROM matches')).rows[0].home_goals, 0);
  assert.deepEqual((await client.execute("SELECT name FROM sqlite_master WHERE type='table'")).rows.map((row) => row.name), ['matches']);
  const empty = createClient({ url: 'file::memory:' }); t.after(() => empty.close());
  await assert.rejects(new SourceFeedStore(empty).initialize(), { message: 'source_feed_database_not_dedicated' });
});

test('deduplicated content retains separate acquisition evidence for every successful fetch', async (t) => {
  const { store, client } = await cache(t);
  const [first, competing] = await Promise.all([store.beginAttempt('PL', 2026, timestamp), store.beginAttempt('PL', 2026, timestamp)]);
  assert.equal([first, competing].filter((id) => id !== null).length, 1);
  const attempt = first ?? competing;
  const snapshot = normalize();
  await store.succeed(attempt, snapshot, timestamp);
  await store.succeed(attempt, snapshot, timestamp);
  let state = await store.read('PL', 2026, '2026-11-05T12:05:00Z');
  assert.equal(state.available, true);
  assert.equal(state.snapshot.acquiredAt, timestamp);
  assert.equal(await store.beginAttempt('PL', 2026, '2026-11-05T12:05:00Z'), null);
  const nextTime = '2026-11-05T12:16:00Z';
  const next = await store.beginAttempt('PL', 2026, nextTime);
  const nextPayload = { ...payload(), ignoredExtra: 'different raw response with identical normalized content' };
  const nextSnapshot = normalize(nextPayload, 'PL', nextTime);
  assert.equal(nextSnapshot.contentSha256, snapshot.contentSha256);
  assert.notEqual(nextSnapshot.payloadSha256, snapshot.payloadSha256);
  await store.succeed(next, nextSnapshot, nextTime);
  state = await store.read('PL', 2026, nextTime);
  assert.equal(state.available, true);
  assert.equal(state.snapshot.acquiredAt, new Date(nextTime).toISOString());
  assert.equal(state.snapshot.payloadSha256, nextSnapshot.payloadSha256);
  assert.equal(state.latestAttempt.acquiredAt, state.snapshot.acquiredAt);
  assert.equal(state.latestAttempt.payloadSha256, state.snapshot.payloadSha256);
  assert.equal(state.lastVerifiedAt, new Date(nextTime).toISOString());
  assert.equal((await client.execute('SELECT COUNT(*) AS n FROM source_feed_snapshots')).rows[0].n, 1);
  assert.equal((await client.execute('SELECT COUNT(*) AS n FROM source_feed_attempts')).rows[0].n, 2);
  const attempts = (await client.execute('SELECT acquired_at,payload_sha256 FROM source_feed_attempts ORDER BY id')).rows;
  assert.equal(attempts[0].acquired_at, timestamp);
  assert.equal(attempts[0].payload_sha256, snapshot.payloadSha256);
  assert.equal(attempts[1].payload_sha256, nextSnapshot.payloadSha256);
  assert.equal((await store.read('PL', 2026, '2026-11-05T12:31:00Z')).status, 'stale');
});

test('later failures remain unavailable despite a retained snapshot and enforce cooldown without another GET', async (t) => {
  const { store } = await cache(t);
  let clock = Date.parse(timestamp), calls = 0;
  const now = () => new Date(clock);
  const sleep = async (ms) => { clock += ms; };
  const fetcher = async () => { calls++; return { payload: payload(), acquiredAt: now().toISOString() }; };
  await collectFootballDataOrgFeeds({ store, competitions: ['PL'], season: 2026, apiKey: 'synthetic-key', now, sleep, fetcher });
  clock += SOURCE_FEED_COOLDOWN_MS + 1;
  const failed = await collectFootballDataOrgFeeds({ store, competitions: ['PL'], season: 2026, apiKey: 'synthetic-key', now, sleep,
    fetcher: async () => { calls++; throw Error('https://unsafe.invalid/?key=synthetic-secret'); } });
  assert.equal(failed.available, 0);
  assert.equal(failed.feeds[0].status, 'failure');
  assert.equal(failed.feeds[0].reason, 'source_feed_fetch_failed');
  assert.ok(failed.feeds[0].snapshot);
  assert.equal(failed.feeds[0].snapshot.acquiredAt, timestamp);
  assert.equal(failed.feeds[0].latestAttempt.acquiredAt, null);
  assert.equal(failed.feeds[0].latestAttempt.payloadSha256, null);
  assert.equal(failed.feeds[0].lastVerifiedAt, timestamp);
  const repeat = await collectFootballDataOrgFeeds({ store, competitions: ['PL'], season: 2026, apiKey: 'synthetic-key', now, sleep, fetcher });
  assert.equal(repeat.networkRequests, 0); assert.equal(repeat.available, 0); assert.equal(calls, 2);
  assert.equal(repeat.feeds[0].latestAttempt.finishedAt, failed.feeds[0].latestAttempt.finishedAt);
  assert.equal(JSON.stringify(repeat).includes('synthetic-secret'), false);
});

test('two injected GET responses with identical normalized content bind each fetch hash and acquisition time', async (t) => {
  const { store, client } = await cache(t);
  let clock = Date.parse(timestamp), calls = 0;
  const options = { store, season: 2026, competitions: ['PL'], apiKey: 'synthetic-key', now: () => new Date(clock),
    fetcher: async () => {
      calls++; clock += 1000;
      return { payload: { ...payload(), ignoredRawField: `fetch-${calls}` }, acquiredAt: new Date(clock).toISOString() };
    }, sleep: async (ms) => { clock += ms; } };
  const first = await collectFootballDataOrgFeeds(options);
  clock += SOURCE_FEED_COOLDOWN_MS + 1;
  const second = await collectFootballDataOrgFeeds(options);
  const before = first.feeds[0], latest = second.feeds[0];
  assert.equal(calls, 2);
  assert.equal(before.snapshot.contentSha256, latest.snapshot.contentSha256);
  assert.notEqual(before.snapshot.payloadSha256, latest.snapshot.payloadSha256);
  assert.notEqual(before.snapshot.acquiredAt, latest.snapshot.acquiredAt);
  assert.equal(latest.latestAttempt.acquiredAt, latest.snapshot.acquiredAt);
  assert.equal(latest.latestAttempt.payloadSha256, latest.snapshot.payloadSha256);
  assert.equal(latest.lastVerifiedAt, new Date(clock).toISOString());
  assert.equal((await client.execute('SELECT COUNT(*) AS n FROM source_feed_snapshots')).rows[0].n, 1);
  assert.equal((await client.execute('SELECT COUNT(*) AS n FROM source_feed_attempts')).rows[0].n, 2);
  const cached = await collectFootballDataOrgFeeds(options);
  assert.equal(calls, 2); assert.equal(cached.networkRequests, 0);
  assert.equal(cached.feeds[0].snapshot.acquiredAt, latest.snapshot.acquiredAt);
  assert.equal(cached.feeds[0].snapshot.payloadSha256, latest.snapshot.payloadSha256);
  assert.equal(cached.feeds[0].lastVerifiedAt, latest.lastVerifiedAt);
});

test('delayed persistence cannot make an old acquisition fresh', async (t) => {
  const { store } = await cache(t);
  const attempt = await store.beginAttempt('PL', 2026, timestamp);
  const completion = '2026-11-05T12:30:00.000Z';
  await store.succeed(attempt, normalize(), completion);
  const state = await store.read('PL', 2026, completion);
  assert.equal(state.status, 'stale');
  assert.equal(state.available, false);
  assert.equal(state.snapshot.acquiredAt, timestamp);
  assert.equal(state.latestAttempt.acquiredAt, timestamp);
  assert.equal(state.latestAttempt.finishedAt, completion);
  assert.equal(state.lastVerifiedAt, completion);
});

test('the five-league collector bounds requests and spaces actual GETs by at least seven seconds', async (t) => {
  const { store } = await cache(t);
  let clock = Date.parse(timestamp);
  const requests = [], pauses = [];
  const result = await collectFootballDataOrgFeeds({ store, season: 2026, apiKey: 'synthetic-key', now: () => new Date(clock),
    sleep: async (ms) => { pauses.push(ms); clock += ms; }, fetcher: async ({ competition }) => {
      requests.push(clock); return { payload: payload(competition), acquiredAt: new Date(clock).toISOString() };
    } });
  assert.equal(result.networkRequests, 5); assert.equal(result.available, 5);
  assert.equal(pauses.length, 4);
  assert.ok(requests.slice(1).every((at, index) => at - requests[index] >= 7000));
  const repeated = await collectFootballDataOrgFeeds({ store, season: 2026, apiKey: 'synthetic-key', now: () => new Date(clock),
    fetcher: async () => assert.fail('fresh cache cannot fetch'), sleep: async () => assert.fail('cache hits cannot sleep') });
  assert.equal(repeated.cached, 5); assert.equal(repeated.networkRequests, 0);
});

test('a corrupted persisted snapshot cannot be reported as available', async (t) => {
  const { store, client } = await cache(t);
  const attempt = await store.beginAttempt('PL', 2026, timestamp);
  await store.succeed(attempt, normalize(), timestamp);
  await client.execute("UPDATE source_feed_snapshots SET snapshot_json='{}'");
  const state = await store.read('PL', 2026, timestamp);
  assert.equal(state.available, false); assert.equal(state.snapshot, null);
});

test('CLI is inert by default and rejects remote or incomplete collection configuration before opening a DB', async () => {
  const dependencies = { createClient: () => assert.fail('DB must remain unopened'), env: { FOOTBALL_DATA_ORG_API_KEY: 'synthetic-key' } };
  const defaultResult = await runSourceFeedCollector([], dependencies);
  assert.equal(defaultResult.mode, 'disabled'); assert.equal(defaultResult.networkRequests, 0);
  await runSourceFeedCollector(['--database', 'ignored.db', '--season', '2026'], dependencies);
  for (const database of ['https://example.invalid/db', 'libsql://example.invalid', 'file:operational.db', ':memory:']) {
    assert.throws(() => localDatabasePath(database), { message: 'source_feed_local_file_required' });
  }
  await assert.rejects(runSourceFeedCollector(['--collect', '--season', '2026'], dependencies));
});

test('CLI creates only an explicitly selected dedicated temporary cache, reports ABSTAIN and refuses operational files', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'source-feed-test-'));
  t.after(async () => {
    assert.ok(typeof directory === 'string' && directory.length > 0);
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.resolve(directory).startsWith(`${path.resolve(os.tmpdir())}${path.sep}source-feed-test-`));
    await new Promise((resolve) => setTimeout(resolve, 50));
    await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  const filename = path.join(directory, 'feed.sqlite');
  const dependencies = { env: { FOOTBALL_DATA_ORG_API_KEY: 'synthetic-key' }, feedModule, storeModule, readinessModule,
    now: () => new Date(timestamp), fetcher: async () => ({ payload: payload(), acquiredAt: timestamp }) };
  const args = ['--collect', '--database', filename, '--season', '2026', '--competitions', 'PL'];
  const result = await runSourceFeedCollector(args, dependencies);
  assert.equal(result.available, 1); assert.equal(result.operationalWrites, 0);
  assert.equal(result.modelReadiness.decision, 'ABSTAIN');
  assert.equal(result.readiness.competitions[0].markets.every((market) => market.action === 'ABSTAIN' && market.probabilities === null), true);
  assert.equal(JSON.stringify(result).includes('synthetic-key'), false);
  assert.equal(result.feeds[0].fixtures, undefined, 'CLI does not print raw fixture data');
  assert.equal((await runSourceFeedCollector(args, { ...dependencies, fetcher: async () => assert.fail('must use cache') })).networkRequests, 0);
  const operational = path.join(directory, 'operational.sqlite');
  const db = createClient({ url: `file:${operational}` });
  await db.execute('CREATE TABLE matches(id INTEGER)'); db.close();
  const digest = () => createHash('sha256').update(fs.readFileSync(operational)).digest('hex');
  const before = digest();
  await assert.rejects(runSourceFeedCollector(['--collect', '--database', operational, '--season', '2026'], {
    ...dependencies, createClient: () => assert.fail('an unmarked existing DB must not even be opened'),
  }), { message: 'source_feed_cache_marker_required' });
  assert.equal(digest(), before);
  const oldCache = path.join(directory, 'old-cache.sqlite');
  fs.writeFileSync(oldCache, 'old-cache-must-remain-unopened');
  fs.writeFileSync(`${oldCache}.source-feed-cache.json`, JSON.stringify({
    marker: 'dedicated_source_feed_cache_v1', canonicalPath: fs.realpathSync(oldCache),
  }));
  const oldHash = createHash('sha256').update(fs.readFileSync(oldCache)).digest('hex');
  await assert.rejects(runSourceFeedCollector(['--collect', '--database', oldCache, '--season', '2026'], {
    ...dependencies, createClient: () => assert.fail('old cache formats must not be opened or migrated'),
  }), { message: 'source_feed_cache_marker_invalid' });
  assert.equal(createHash('sha256').update(fs.readFileSync(oldCache)).digest('hex'), oldHash);
});

test('durable spacing is shared by concurrent scopes using the same dedicated cache', async (t) => {
  const { store } = await cache(t);
  const claims = await Promise.all([store.beginAttempt('PL', 2026, timestamp), store.beginAttempt('SA', 2025, timestamp)]);
  assert.equal(claims.filter((attempt) => attempt !== null).length, 1);
  assert.equal(await store.nextRequestDelay(timestamp), 7000);
  assert.equal(await store.nextRequestDelay('2026-11-05T12:00:06Z'), 1000);
  const blockedCompetition = claims[0] === null ? 'PL' : 'SA';
  const blockedSeason = blockedCompetition === 'PL' ? 2026 : 2025;
  assert.equal(await store.beginAttempt(blockedCompetition, blockedSeason, '2026-11-05T12:00:06Z'), null);
  assert.ok(await store.beginAttempt(blockedCompetition, blockedSeason, '2026-11-05T12:00:07Z'));
});

for (const reason of [...SOURCE_FEED_TRANSIENT_FAILURE_REASONS, 'calendar_http_500', 'calendar_http_503', 'calendar_http_599']) {
  test(`transient ${reason} recovers only on a new invocation at 60 seconds, never at 59`, async (t) => {
    const { store } = await cache(t);
    let clock = Date.parse(timestamp), calls = 0;
    const now = () => new Date(clock);
    const failedFetch = async () => {
      calls++;
      if (reason === 'source_feed_invalid_fixture') {
        const invalid = payload(); invalid.matches[0].id = null;
        return { payload: invalid, acquiredAt: now().toISOString() };
      }
      throw Error(reason);
    };
    const options = { store, competitions: ['PL'], season: 2026, apiKey: 'synthetic-key', now,
      sleep: async () => assert.fail('the later invocation needs no rate-limit wait') };
    const failed = await collectFootballDataOrgFeeds({ ...options, fetcher: failedFetch });
    assert.equal(failed.networkRequests, 1); assert.equal(failed.available, 0); assert.equal(calls, 1);
    assert.equal(failed.feeds[0].reason, reason);
    const successfulFetch = async () => { calls++; return { payload: payload(), acquiredAt: now().toISOString() }; };
    clock += SOURCE_FEED_TRANSIENT_FAILURE_BACKOFF_MS - 1000;
    const before = await collectFootballDataOrgFeeds({ ...options, fetcher: successfulFetch });
    assert.equal(before.networkRequests, 0); assert.equal(before.available, 0); assert.equal(calls, 1);
    assert.equal(before.feeds[0].status, 'failure');
    assert.equal(await store.beginAttempt('PL', 2026, now().toISOString()), null, 'the SQL claim also enforces the short backoff');
    clock += 1000;
    const recovered = await collectFootballDataOrgFeeds({ ...options, fetcher: successfulFetch });
    assert.equal(recovered.networkRequests, 1); assert.equal(recovered.available, 1); assert.equal(calls, 2);
    assert.equal(recovered.feeds[0].status, 'available');
    assert.equal(recovered.feeds[0].snapshot.acquiredAt, now().toISOString());
    const cached = await collectFootballDataOrgFeeds({ ...options, fetcher: successfulFetch });
    assert.equal(cached.networkRequests, 0); assert.equal(calls, 2);
  });
}

for (const reason of ['calendar_http_400', 'calendar_http_401', 'calendar_http_403', 'calendar_http_429',
  'source_feed_scope_mismatch', 'source_feed_calendar_incomplete', 'source_feed_invalid_final_score']) {
  test(`${reason} retains the full fifteen-minute durable backoff`, async (t) => {
    const { store } = await cache(t);
    const attempt = await store.beginAttempt('PL', 2026, timestamp);
    await store.fail(attempt, reason, timestamp);
    assert.equal(await store.beginAttempt('PL', 2026, '2026-11-05T12:01:00Z'), null);
    assert.equal(await store.beginAttempt('PL', 2026, '2026-11-05T12:14:59Z'), null);
    const blocked = await collectFootballDataOrgFeeds({ store, competitions: ['PL'], season: 2026, apiKey: 'synthetic-key',
      now: () => new Date('2026-11-05T12:14:59Z'), fetcher: async () => assert.fail('protected failures cannot fetch early') });
    assert.equal(blocked.networkRequests, 0); assert.equal(blocked.available, 0);
    assert.ok(await store.beginAttempt('PL', 2026, '2026-11-05T12:15:00Z'));
  });
}

test('an interrupted pending attempt still blocks new requests for fifteen minutes', async (t) => {
  const { store } = await cache(t);
  await store.beginAttempt('PL', 2026, timestamp);
  assert.equal(await store.beginAttempt('PL', 2026, '2026-11-05T12:01:00Z'), null);
  const blocked = await collectFootballDataOrgFeeds({ store, competitions: ['PL'], season: 2026, apiKey: 'synthetic-key',
    now: () => new Date('2026-11-05T12:14:59Z'), fetcher: async () => assert.fail('pending claim cannot fetch early') });
  assert.equal(blocked.networkRequests, 0); assert.equal(blocked.feeds[0].status, 'pending');
  assert.ok(await store.beginAttempt('PL', 2026, '2026-11-05T12:15:00Z'));
});

test('a transient failure never reactivates a retained successful snapshot before an actual successful GET', async (t) => {
  const { store } = await cache(t);
  let clock = Date.parse(timestamp), calls = 0;
  const options = { store, competitions: ['PL'], season: 2026, apiKey: 'synthetic-key', now: () => new Date(clock) };
  const goodFetch = async () => { calls++; return { payload: payload(), acquiredAt: new Date(clock).toISOString() }; };
  await collectFootballDataOrgFeeds({ ...options, fetcher: goodFetch });
  clock += SOURCE_FEED_COOLDOWN_MS;
  const failed = await collectFootballDataOrgFeeds({ ...options, fetcher: async () => { calls++; throw Error('calendar_timeout'); } });
  assert.equal(failed.available, 0); assert.ok(failed.feeds[0].snapshot);
  assert.equal(failed.feeds[0].snapshot.acquiredAt, timestamp);
  clock += SOURCE_FEED_TRANSIENT_FAILURE_BACKOFF_MS - 1;
  const stillFailed = await collectFootballDataOrgFeeds({ ...options, fetcher: goodFetch });
  assert.equal(stillFailed.networkRequests, 0); assert.equal(stillFailed.available, 0); assert.equal(calls, 2);
  clock++;
  const recovered = await collectFootballDataOrgFeeds({ ...options, fetcher: goodFetch });
  assert.equal(recovered.available, 1); assert.equal(calls, 3);
  assert.equal(recovered.feeds[0].snapshot.acquiredAt, new Date(clock).toISOString());
});

test('successful fetch freshness and cooldown remain fifteen minutes', async (t) => {
  const { store } = await cache(t);
  const attempt = await store.beginAttempt('PL', 2026, timestamp);
  await store.succeed(attempt, normalize(), timestamp);
  assert.equal(await store.beginAttempt('PL', 2026, '2026-11-05T12:01:00Z'), null);
  assert.equal((await store.read('PL', 2026, '2026-11-05T12:14:59Z')).available, true);
  assert.equal((await store.read('PL', 2026, '2026-11-05T12:15:00Z')).status, 'stale');
  assert.ok(await store.beginAttempt('PL', 2026, '2026-11-05T12:15:00Z'));
});
