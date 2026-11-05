#!/usr/bin/env node
'use strict';

// Explicit local sandbox only; importing this module never opens a DB or network.
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createHash } = require('node:crypto');
const { localDatabasePath, verifyCacheSidecar, runSourceFeedCollector } = require('./collect-source-feeds');
const codes = { SA: 'Serie A', PL: 'Premier League', PD: 'La Liga', BL1: 'Bundesliga', FL1: 'Ligue 1' };
const csvCodes = { SA: 'I1', PL: 'E0', PD: 'SP1', BL1: 'D1', FL1: 'F1' };
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const usage = 'stage-alternative-sources --stage --sandbox <NEW-local-file> --source-cache <dedicated-cache> --seed-matches <JSON> --mapping <reviewed-JSON> --season YYYY [--collect] [--apply-verified-subset] [--csv-directory DIR --csv-acquired-at UTC]';

function parseArguments(args) {
  const values = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!['--stage', '--collect', '--help', '--apply-verified-subset', '--sandbox', '--source-cache', '--seed-matches', '--mapping', '--season', '--csv-directory', '--csv-acquired-at'].includes(key)
      || Object.hasOwn(values, key)) throw Error('stage_invalid_arguments');
    if (['--stage', '--collect', '--help', '--apply-verified-subset'].includes(key)) values[key] = true;
    else {
      if (!args[i + 1] || args[i + 1].startsWith('--')) throw Error('stage_invalid_arguments');
      values[key] = args[++i];
    }
  }
  if (!values['--stage'] || values['--help']) return { enabled: false, usage };
  if (['--sandbox', '--source-cache', '--seed-matches', '--mapping', '--season'].some(key => !values[key])
    || !/^20\d{2}$/.test(values['--season']) || Boolean(values['--csv-directory']) !== Boolean(values['--csv-acquired-at'])) throw Error('stage_invalid_arguments');
  return { enabled: true, values };
}

function validateSeed(rows, season) {
  const { sourceFeedUtc } = require('../dist/services/FootballDataOrgFeed');
  if (!Array.isArray(rows) || !rows.length || rows.length > 2500) throw Error('stage_invalid_seed');
  const ids = new Set();
  for (const row of rows) {
    if (typeof row?.match_id !== 'string' || !row.match_id || ids.has(row.match_id)
      || !Object.values(codes).includes(row.competition) || row.season !== `${season}/${season + 1}`
      || ![row.home_team_id, row.away_team_id, row.home_team_name, row.away_team_name].every(v => typeof v === 'string' && v.trim())
      || row.home_team_id === row.away_team_id || !sourceFeedUtc(row.date) || typeof row.source !== 'string') throw Error('stage_invalid_seed');
    ids.add(row.match_id);
    for (const field of ['home_goals', 'away_goals', 'home_shots', 'away_shots', 'home_shots_on_target', 'away_shots_on_target', 'home_yellow_cards', 'away_yellow_cards', 'home_red_cards', 'away_red_cards', 'home_fouls', 'away_fouls', 'home_corners', 'away_corners']) {
      if (row[field] != null && (!Number.isSafeInteger(row[field]) || row[field] < 0)) throw Error('stage_invalid_seed');
    }
    for (const field of ['home_xg', 'away_xg', 'home_possession', 'away_possession']) if (row[field] != null && (typeof row[field] !== 'number' || !Number.isFinite(row[field]) || row[field] < 0)) throw Error('stage_invalid_seed');
    if (Object.hasOwn(row, 'created_at') && row.created_at !== null) {
      const timestamp = typeof row.created_at === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(row.created_at)
        ? `${row.created_at.replace(' ', 'T')}Z` : row.created_at;
      if (!sourceFeedUtc(timestamp)) throw Error('stage_invalid_seed');
    }
  }
  return rows;
}

function seedMatch(row, seedSha256) {
  const fields = { homeTotalShots: 'home_shots', awayTotalShots: 'away_shots', homeShotsOnTarget: 'home_shots_on_target', awayShotsOnTarget: 'away_shots_on_target',
    homeYellowCards: 'home_yellow_cards', awayYellowCards: 'away_yellow_cards', homeRedCards: 'home_red_cards', awayRedCards: 'away_red_cards',
    homeFouls: 'home_fouls', awayFouls: 'away_fouls', homeCorners: 'home_corners', awayCorners: 'away_corners',
    homePossession: 'home_possession', awayPossession: 'away_possession' };
  return { matchId: row.match_id, homeTeamId: row.home_team_id, awayTeamId: row.away_team_id,
    homeTeamName: row.home_team_name, awayTeamName: row.away_team_name, date: row.date, homeGoals: row.home_goals, awayGoals: row.away_goals,
    homeXG: row.home_xg, awayXG: row.away_xg, competition: row.competition, season: row.season, source: row.source, sourceMatchId: row.source_match_id,
    referee: row.referee, ...Object.fromEntries(Object.entries(fields).map(([key, field]) => [key, row[field] ?? null])),
    rawJson: JSON.stringify({ sandboxSeed: { sha256: seedSha256, originalRawJsonNotExported: true } }) };
}

/** Used only after runStage reserves a new isolated target; never changes the shared DB service. */
async function seedSandboxMatches(db, rows, seedSha256) {
  await db.upsertMatches(rows.map(row => seedMatch(row, seedSha256)));
  const timestamps = rows.filter(row => Object.hasOwn(row, 'created_at')).map(row => ({
    sql: 'UPDATE matches SET created_at=? WHERE match_id=?', args: [row.created_at, row.match_id],
  }));
  if (timestamps.length) await db.db.batch(timestamps, 'write');
}

async function runStage(args = [], dependencies = {}) {
  const parsed = parseArguments(args);
  if (!parsed.enabled) return { mode: 'disabled', operationalWrites: 0, networkRequests: 0, usage };
  const v = parsed.values, season = Number(v['--season']);
  const targetPath = localDatabasePath(v['--sandbox']);
  if (fs.existsSync(targetPath)) throw Error('stage_target_must_be_new');
  const cachePath = localDatabasePath(v['--source-cache']);
  if (!fs.existsSync(cachePath) || targetPath === cachePath) throw Error('stage_cache_required');
  verifyCacheSidecar(cachePath);
  const seedBytes = fs.readFileSync(v['--seed-matches']);
  const rows = validateSeed(JSON.parse(seedBytes.toString('utf8')), season);
  const mappingBytes = fs.readFileSync(v['--mapping']);
  const mapping = JSON.parse(mappingBytes.toString('utf8'));
  if (mapping?.version !== 'reviewed-source-mapping-v1' || typeof mapping.reference !== 'string' || !mapping.reference.trim()
    || !Number.isFinite(Date.parse(mapping.reviewedAt)) || !mapping.teams) throw Error('stage_mapping_required');
  const previous = { TURSO_DATABASE_URL: process.env.TURSO_DATABASE_URL, TURSO_AUTH_TOKEN: process.env.TURSO_AUTH_TOKEN, PLAYER_DATA_ENABLED: process.env.PLAYER_DATA_ENABLED };
  let db, cache;
  const startedAt = new Date().toISOString();
  const report = { mode: 'isolated_source_import', startedAt, sandbox: targetPath, seedSha256: sha(seedBytes), mappingSha256: sha(mappingBytes),
    operationalWrites: 0, networkRequests: 0, sources: [], supplements: [], recomputedTeams: 0,
    predictions: { action: 'ABSTAIN', computed: false, probabilities: null, reason: 'alternative_inputs_not_statistically_validated' },
    quotes: { requested: false, reason: 'prediction_admission_blocked' }, newBets: 0, scientificCollectionStarted: false };
  try {
    if (v['--collect']) {
      const collected = await runSourceFeedCollector(['--collect', '--database', cachePath, '--season', String(season)], { env: dependencies.env ?? process.env });
      report.networkRequests = collected.networkRequests;
      report.collection = { successful: collected.successful, cached: collected.cached, failed: collected.failed, available: collected.available,
        feeds: collected.feeds.map(feed => ({ competition: feed.competition, status: feed.status, reason: feed.reason })) };
    }
    // A genuinely new target is reserved before configuring the DB service.
    fs.closeSync(fs.openSync(targetPath, 'wx'));
    process.env.TURSO_DATABASE_URL = pathToFileURL(targetPath).href;
    process.env.TURSO_AUTH_TOKEN = 'isolated-source-stage-only';
    process.env.PLAYER_DATA_ENABLED = 'false';
    const { DatabaseService } = require('../dist/db/DatabaseService');
    const { createClient } = require('@libsql/client');
    const { SourceFeedStore } = require('../dist/services/SourceFeedStore');
    const { runSourceFeedImport } = require('../dist/services/SourceFeedImport');
    const { importCapturedSupplement } = require('../dist/services/SourceSupplementImport');
    db = new DatabaseService();
    await db.getMatches();
    const teams = new Map();
    for (const row of rows) for (const side of ['home', 'away']) {
      const id = row[`${side}_team_id`], name = row[`${side}_team_name`];
      if (teams.has(id) && teams.get(id).name !== name) throw Error('stage_seed_team_conflict');
      teams.set(id, { teamId: id, name, competition: row.competition });
    }
    for (const team of teams.values()) await db.upsertTeam(team);
    await seedSandboxMatches(db, rows, report.seedSha256);
    const seeded = new Map((await db.getMatches()).map(row => [row.match_id, row]));
    for (const row of rows) for (const [field, value] of Object.entries(row)) {
      if (!Object.hasOwn(seeded.get(row.match_id), field) || seeded.get(row.match_id)[field] !== value) throw Error('stage_seed_projection_mismatch');
    }
    report.seedProjectionVerified = true;
    cache = createClient({ url: pathToFileURL(cachePath).href });
    const store = new SourceFeedStore(cache);
    await store.initialize();
    const client = db.db; // Existing DB service owns this explicitly isolated client.
    for (const [competition, localName] of Object.entries(codes)) {
      const asOf = new Date().toISOString();
      const result = await runSourceFeedImport({ client, store, competition, season, asOf,
        mapping: { version: mapping.version, competition, season, reviewedAt: mapping.reviewedAt, reference: mapping.reference, teams: mapping.teams[localName] },
        allowCreateFixtures: true });
      if (result.plan.status === 'ready' || (v['--apply-verified-subset'] && result.plan.status === 'blocked')) {
        result.result = await require('../dist/services/SourceFeedImport').applySourceFeedImport({ client, store, plan: result.plan, asOf,
          allowVerifiedSubset: v['--apply-verified-subset'] === true && result.plan.status === 'blocked', expectedPlanHash: result.plan.planHash });
      }
      report.sources.push({ competition, planHash: result.plan.planHash, status: result.plan.status, reason: result.plan.reason, counts: result.plan.counts, result: result.result,
        conflicts: result.plan.entries.filter(entry => entry.action === 'BLOCK'), skipped: result.plan.entries.filter(entry => entry.action === 'SKIP').length });
      if (v['--csv-directory']) {
        const filename = path.join(v['--csv-directory'], `${csvCodes[competition]}-${String(season).slice(-2)}${String(season + 1).slice(-2)}.csv`);
        const csv = fs.readFileSync(filename, 'utf8');
        const imported = await importCapturedSupplement({ client, csv, competition: localName, seasonStart: season,
          acquiredAt: v['--csv-acquired-at'], asOf: new Date().toISOString(), sha256: sha(csv), sourceUrl: `https://www.football-data.co.uk/mmz4281/${String(season).slice(-2)}${String(season + 1).slice(-2)}/${csvCodes[competition]}.csv` });
        report.supplements.push({ competition, ...imported });
      }
    }
    await db.recomputeTeamAveragesBatch([...teams.keys()]);
    report.recomputedTeams = teams.size;
    report.fixtureCount = (await db.getMatches()).length;
    report.finishedAt = new Date().toISOString();
    return report;
  } finally {
    cache?.close();
    await db?.close();
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

module.exports = { parseArguments, validateSeed, seedMatch, seedSandboxMatches, runStage };
if (require.main === module) runStage(process.argv.slice(2)).then(report => {
  process.stdout.write(`${JSON.stringify(report)}\n`);
  if (report.sources?.some(source => source.status !== 'ready')) process.exitCode = 1;
}).catch(error => { process.stdout.write(`${JSON.stringify({ error: /^stage_|^source_import_|^supplement_/.test(error.message) ? error.message : 'stage_failed', operationalWrites: 0 })}\n`); process.exitCode = 1; });
