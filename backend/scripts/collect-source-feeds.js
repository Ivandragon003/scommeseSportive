#!/usr/bin/env node
// Standalone source cache. Importing or invoking without --collect is inert.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const CACHE_MARKER = 'dedicated_source_feed_cache_v2';

const usage = 'collect-source-feeds --collect --database <new-or-dedicated-local-file> --season YYYY [--competitions PL,SA,PD,BL1,FL1]';
function parseArguments(args) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--collect' || arg === '--help') {
      if (options[arg] !== undefined) throw Error('source_feed_duplicate_argument');
      options[arg] = true;
    } else if (['--database', '--season', '--competitions'].includes(arg)) {
      if (options[arg] !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) throw Error('source_feed_invalid_argument');
      options[arg] = args[++index];
    } else throw Error('source_feed_invalid_argument');
  }
  if (options['--help'] || !options['--collect']) return { collect: false, help: !!options['--help'] };
  if (!options['--database'] || !/^\d{4}$/.test(options['--season'] ?? '')) throw Error('source_feed_explicit_database_and_season_required');
  const season = Number(options['--season']);
  if (season < 1900 || season > 2100) throw Error('source_feed_invalid_scope');
  const competitions = options['--competitions'] ? options['--competitions'].split(',') : ['PL', 'SA', 'PD', 'BL1', 'FL1'];
  if (!competitions.length || competitions.length > 5 || new Set(competitions).size !== competitions.length
    || competitions.some((value) => !['PL', 'SA', 'PD', 'BL1', 'FL1'].includes(value))) throw Error('source_feed_invalid_scope');
  return { collect: true, database: options['--database'], season, competitions };
}

function localDatabasePath(value) {
  if (typeof value !== 'string' || !value.trim() || /[\0?#]/.test(value) || value === ':memory:'
    || (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value))) throw Error('source_feed_local_file_required');
  const resolved = path.resolve(value);
  if (fs.existsSync(resolved)) {
    const stat = fs.lstatSync(resolved);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('source_feed_local_file_required');
  }
  return resolved;
}

function verifyCacheSidecar(databasePath) {
  const markerPath = `${databasePath}.source-feed-cache.json`;
  if (!fs.existsSync(markerPath)) throw Error('source_feed_cache_marker_required');
  const stat = fs.lstatSync(markerPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 4096) throw Error('source_feed_cache_marker_invalid');
  let marker;
  try { marker = JSON.parse(fs.readFileSync(markerPath, 'utf8')); }
  catch { throw Error('source_feed_cache_marker_invalid'); }
  if (marker.marker !== CACHE_MARKER || marker.canonicalPath !== fs.realpathSync(databasePath)) throw Error('source_feed_cache_marker_invalid');
}

function summarizeSourceFeedCollection(result, buildReadiness = require('../dist/services/SourceFeedReadiness').buildSourceFeedReadiness) {
  return {
    mode: 'source_cache_only', provider: result.provider, season: result.season,
    requested: result.requested, networkRequests: result.networkRequests, successful: result.successful,
    cached: result.cached, failed: result.failed, available: result.available, operationalWrites: 0,
    readiness: buildReadiness(result.feeds),
    modelReadiness: { decision: 'ABSTAIN', reasons: ['source_feed_does_not_establish_model_readiness', 'xg_not_provided', 'model_state_not_verified'] },
    feeds: result.feeds.map((feed) => ({
      provider: feed.provider, competition: feed.competition, season: feed.season,
      available: feed.available, status: feed.status, reason: feed.reason,
      acquiredAt: feed.snapshot?.acquiredAt ?? null, providerUpdatedAt: feed.snapshot?.providerUpdatedAt ?? null,
      contentSha256: feed.snapshot?.contentSha256 ?? null, payloadSha256: feed.snapshot?.payloadSha256 ?? null,
      lastVerifiedAt: feed.lastVerifiedAt,
      providerPublishedAt: null, coverage: feed.snapshot?.coverage ?? null,
      fieldAvailability: feed.snapshot?.fieldAvailability ?? null,
      latestAttempt: feed.latestAttempt ? { status: feed.latestAttempt.status, requestedAt: feed.latestAttempt.requestedAt,
        finishedAt: feed.latestAttempt.finishedAt, acquiredAt: feed.latestAttempt.acquiredAt,
        payloadSha256: feed.latestAttempt.payloadSha256, reason: feed.latestAttempt.reason } : null,
    })),
  };
}

async function runSourceFeedCollector(args = [], dependencies = {}) {
  const options = parseArguments(args);
  if (!options.collect) return { mode: options.help ? 'help' : 'disabled', reason: 'explicit_collect_required', networkRequests: 0, operationalWrites: 0, usage };
  const databasePath = localDatabasePath(options.database);
  const env = dependencies.env ?? process.env;
  const apiKey = String(env.FOOTBALL_DATA_ORG_API_KEY ?? '').trim();
  if (!/^[\x21-\x7e]+$/.test(apiKey)) throw Error('source_feed_api_key_required');
  // Reserve a genuinely new local file without ever replacing an existing one.
  const existed = fs.existsSync(databasePath);
  if (existed) verifyCacheSidecar(databasePath);
  else {
    fs.closeSync(fs.openSync(databasePath, 'wx'));
    const descriptor = fs.openSync(`${databasePath}.source-feed-cache.json`, 'wx', 0o600);
    try { fs.writeFileSync(descriptor, JSON.stringify({ marker: CACHE_MARKER, canonicalPath: fs.realpathSync(databasePath) })); }
    finally { fs.closeSync(descriptor); }
  }
  const createClient = dependencies.createClient ?? require('@libsql/client').createClient;
  const { SourceFeedStore } = dependencies.storeModule ?? require('../dist/services/SourceFeedStore');
  const { collectFootballDataOrgFeeds } = dependencies.feedModule ?? require('../dist/services/FootballDataOrgFeed');
  const client = createClient({ url: pathToFileURL(databasePath).href });
  try {
    const store = new SourceFeedStore(client);
    await store.initialize({ allowCreate: !existed });
    const result = await collectFootballDataOrgFeeds({ store, season: options.season, competitions: options.competitions,
      apiKey, fetcher: dependencies.fetcher, now: dependencies.now, sleep: dependencies.sleep });
    return summarizeSourceFeedCollection(result, dependencies.readinessModule?.buildSourceFeedReadiness);
  } finally { client.close?.(); }
}

module.exports = { parseArguments, localDatabasePath, verifyCacheSidecar, runSourceFeedCollector, summarizeSourceFeedCollection };
if (require.main === module) {
  runSourceFeedCollector(process.argv.slice(2)).then((result) => {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.failed > 0 || (result.mode === 'source_cache_only' && result.available !== result.requested)) process.exitCode = 1;
  }).catch((error) => {
    const code = /^source_feed_[a-z_]{1,100}$/.test(String(error?.message)) ? error.message : 'source_feed_collection_failed';
    process.stdout.write(`${JSON.stringify({ mode: 'source_cache_only', success: false, error: code, operationalWrites: 0 })}\n`);
    process.exitCode = 1;
  });
}
