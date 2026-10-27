/* Historical price export is SELECT-only. All report/forecast writes are local files. */
const { createClient } = require('@libsql/client');
const { readFileSync, writeFileSync, mkdirSync } = require('node:fs');
const { resolve, dirname, join } = require('node:path');
const { createHash } = require('node:crypto');

function options(argv) {
  const out = { command: argv[0] };
  for (let i = 1; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || !argv[i + 1]) throw new Error('Expected --option value');
    out[argv[i].slice(2)] = argv[i + 1];
  }
  return out;
}
const load = (path) => JSON.parse(readFileSync(resolve(path), 'utf8'));
function save(path, value) { mkdirSync(dirname(resolve(path)), { recursive: true }); writeFileSync(resolve(path), JSON.stringify(value)); }
const hash = (path) => createHash('sha256').update(readFileSync(resolve(path))).digest('hex');
const tally = (values, key) => Object.fromEntries([...new Set(values.map(key))].sort().map((name) => [name, values.filter((row) => key(row) === name).length]));
function adapter() { return require(process.env.RESEARCH_ODDS_MODULE || '../dist/research/HistoricalResearchOdds'); }
function identityNormalizer() {
  const { canonicalTeamName } = require('../dist/services/FootballDataService');
  const { normalizeTeamForOdds } = require('../dist/services/odds-provider/oddsProviderUtils');
  return (name) => canonicalTeamName(normalizeTeamForOdds(name));
}

async function exportArchive(out) {
  if (!process.env.TURSO_DATABASE_URL) throw new Error('TURSO_DATABASE_URL required; only SELECT statements are used');
  const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_AUTH_TOKEN });
  try {
    const matches = (await db.execute(`SELECT match_id,date,competition,season,home_team_name,away_team_name,fd_odds_json
      FROM matches WHERE home_goals IS NOT NULL AND away_goals IS NOT NULL ORDER BY date,match_id`)).rows;
    const snapshots = (await db.execute(`SELECT os.snapshot_id,os.match_id,os.commence_time,os.source,
      os.selected_bookmaker_key,os.selected_bookmaker_name,os.selected_odds_json,os.live_selected_odds_json,
      os.home_team_name,os.away_team_name,
      os.all_bookmaker_odds_json,os.used_fallback_bookmaker,os.used_synthetic_odds,os.captured_at,
      m.date AS match_date,COALESCE(m.competition,os.competition) AS competition,m.season FROM odds_snapshots os
      LEFT JOIN matches m ON m.match_id=os.match_id ORDER BY os.captured_at,os.snapshot_id`)).rows;
    save(out, { readOnlyExport: true, exportedAt: new Date().toISOString(), matches, snapshots });
    console.log(JSON.stringify({ readOnly: true, matches: matches.length, snapshots: snapshots.length }));
  } finally { db.close(); }
}

function auditArchive(archive, trainer) {
  const { historicalSnapshotObservation, selectHistoricalObservation, footballDataHistoricalEvidence, linkHistoricalSnapshot, buildHistoricalFixtureIndex } = adapter();
  const normalize = identityNormalizer();
  const fixtureIndex = buildHistoricalFixtureIndex(archive.matches, normalize);
  const linked = archive.snapshots.map((row) => linkHistoricalSnapshot(row, fixtureIndex, normalize));
  const parsed = linked.map((entry) => historicalSnapshotObservation(entry.row));
  const observations = parsed.flatMap((row) => row.observation ? [row.observation] : []);
  const completedIds = new Set(archive.matches.map((row) => row.match_id));
  const completedObservations = observations.filter((row) => completedIds.has(row.matchId));
  const matched = (predictions, modelAvailableThrough) => predictions.flatMap((row) => {
    const observation = selectHistoricalObservation(observations, { matchId: row.matchId,
      forecastCutoff: row.forecastAt, modelAvailableThrough });
    return observation ? [{ ...row, observationAt: observation.observationAt, quoteCount: observation.quotes.length,
      marketKeys: [...new Set(observation.quotes.map((quote) => quote.market))] }] : [];
  });
  const tests = trainer.predictions || [];
  const allTests = matched(tests);
  const folds = (trainer.folds || []).map((fold) => {
    const predictions = tests.filter((row) => row.versionC === fold.version);
    const calibration = matched(fold.calibrationPredictions || []);
    const test = matched(predictions), usable = matched(predictions, fold.validationThrough);
    return { fold: fold.fold, modelVersion: fold.version, trainN: fold.trainN, selectionN: fold.validationN,
      probabilityCalibrationN: fold.calibrationN, testN: predictions.length,
      calibrationWithObservedPrices: calibration.length, testWithObservedPrices: test.length,
      testPricesAfterModelValidation: usable.length, providerUpdateTimestampKnown: 0, verifiedT15Freshness: 0,
      calibrationByLeague: tally(calibration, (row) => row.competition), testByLeague: tally(test, (row) => row.competition),
      testBySeason: tally(test, (row) => row.season), testMarketCoverage: Object.fromEntries(
        [...new Set(test.flatMap((row) => row.marketKeys))].sort().map((market) => [market, test.filter((row) => row.marketKeys.includes(market)).length])) };
  });
  const footballData = archive.matches.map((row) => ({ ...row, evidence: footballDataHistoricalEvidence(row.fd_odds_json) }));
  return { protocol: 'historical-odds-read-only-audit-v1', exportedAt: archive.exportedAt,
    matches: archive.matches.length, footballData: { availableMatches: footballData.filter((row) => row.evidence.available).length,
      economicAdmissible: 0, reason: 'Stored opening/closing maps omit original columns, actual bookmaker and observation time; aggregate prices are not execution prices.',
      byLeague: tally(footballData.filter((row) => row.evidence.available), (row) => row.competition),
      byLeagueSeason: tally(footballData.filter((row) => row.evidence.available), (row) => `${row.competition}:${row.season}`) },
    snapshots: { total: archive.snapshots.length, sources: tally(archive.snapshots, (row) => row.source),
      acceptedPrematchObservations: observations.length, matchesWithPrematchObservations: new Set(observations.map((row) => row.matchId)).size,
      completedMatchPrematchObservations: completedObservations.length,
      completedMatchesWithPrematchObservations: new Set(completedObservations.map((row) => row.matchId)).size,
      fixtureLinks: tally(linked, (entry) => entry.reason || entry.row.matchLinkEvidence?.method || 'unknown'),
      rejectedReasons: tally(parsed.filter((row) => row.reason), (row) => row.reason),
      knownProviderUpdateTimestamp: 0, verifiedT15Freshness: 0,
      byLeague: tally(observations, (row) => row.competition || 'unknown'),
      byLeagueSeason: tally(observations, (row) => `${row.competition}:${row.season}`) },
    originalBenchmark: { observations: tests.length, withPriorObservedPrices: allTests.length,
      byLeague: tally(allTests, (row) => row.competition), folds },
    economicEvidence: { roi: null, clv: null, status: 'not_validated',
      blockers: ['Original T-15 features cannot be paired with older prices as though still available.',
        'Snapshot-time forecasts must be rebuilt at the actual observation timestamp.',
        'A distinct quote-labelled payout calibration cohort is not part of the original probability-only split.',
        'The already consulted final 745 matches must not be used to fit prudential corrections or tune thresholds.'] },
    limitations: ['An observed snapshot records a genuine archived price, not the bookmaker last_update.',
      'Prematch snapshot analysis is not an opening/closing execution or a T-15 backtest.',
      'No new sports source download, commercial API, database migration or remote write was performed.'] };
}

async function prepareRows(args) {
  const { historicalSnapshotObservation, selectHistoricalObservation, linkHistoricalSnapshot, buildHistoricalFixtureIndex } = adapter();
  const normalize = identityNormalizer();
  const { buildForecastInput } = require('../dist/research/ForecastCore');
  const { predictHybrid } = require('../dist/research/CatBoostModel');
  const { applyResearchProbabilityPipeline } = require('../dist/research/ResearchProbabilityPipeline');
  const { applyCoherentProbabilityPipeline } = require('../dist/research/CoherentProbabilityPipeline');
  const { enrichLifecycleArtifact, enrichCoherentLifecycleArtifact } = require('../dist/research/ResearchLifecycle');
  const probabilityProtocol = args['probability-protocol'] || 'coherent-v2';
  const calibrationMode = args['calibration-mode'] || 'isotonic_1x2';
  if (!['coherent-v2', 'legacy-v1'].includes(probabilityProtocol)) throw new Error('Unknown --probability-protocol');
  if (!['identity', 'isotonic_1x2'].includes(calibrationMode)) throw new Error('--calibration-mode must be identity or isotonic_1x2');
  const archive = load(args.archive), trainer = load(args.report), history = load(args.matches);
  const fixtureIndex = buildHistoricalFixtureIndex(archive.matches, normalize);
  const observations = archive.snapshots.flatMap((row) => {
    const linked = linkHistoricalSnapshot(row, fixtureIndex, normalize);
    const parsed = historicalSnapshotObservation(linked.row); return parsed.observation ? [parsed.observation] : [];
  });
  const finalVersion = trainer.finalHoldout?.version;
  const testRows = [], exclusions = {}, folds = [];
  const exclude = (reason) => { exclusions[reason] = (exclusions[reason] || 0) + 1; };
  for (const fold of trainer.folds || []) {
    if (fold.version === finalVersion) {
      exclude('original_final_holdout_preserved'); continue;
    }
    const artifact = load(join(args.models, `fold-${fold.fold}`, 'artifact.json'));
    const enriched = probabilityProtocol === 'legacy-v1' ? enrichLifecycleArtifact(artifact)
      : enrichCoherentLifecycleArtifact(artifact, { mode: calibrationMode });
    const profiles = probabilityProtocol === 'legacy-v1' ? enriched.calibrationProfiles : enriched.calibrationProfilesV2;
    save(`${args.out}.models/fold-${fold.fold}-artifact.json`, enriched);
    let count = 0;
    for (const target of trainer.predictions.filter((row) => row.versionC === fold.version)) {
      const observation = selectHistoricalObservation(observations, { matchId: target.matchId,
        forecastCutoff: target.forecastAt, modelAvailableThrough: artifact.validationThrough });
      if (!observation) { exclude('no_admissible_snapshot_after_model_validation'); continue; }
      const match = history.find((row) => row.matchId === target.matchId);
      if (!match) { exclude('match_missing'); continue; }
      try {
        const input = buildForecastInput(history, match, observation.observationAt);
        const hybrid = predictHybrid(input, artifact);
        const A = probabilityProtocol === 'legacy-v1' ? applyResearchProbabilityPipeline(input.baselineProbabilities,
          profiles.A, observation.quotes, observation.observationAt) : applyCoherentProbabilityPipeline({
          matrix: input.baselineMatrix, rawProbabilities: input.baselineProbabilities, profile: profiles.A,
          quotes: observation.quotes, forecastAt: observation.observationAt, mode: calibrationMode });
        const C = probabilityProtocol === 'legacy-v1' ? applyResearchProbabilityPipeline(hybrid.probabilities,
          profiles.C, observation.quotes, observation.observationAt) : applyCoherentProbabilityPipeline({
          matrix: hybrid.matrix, rawProbabilities: hybrid.probabilities, profile: profiles.C,
          quotes: observation.quotes, forecastAt: observation.observationAt, mode: calibrationMode });
        testRows.push({ matchId: target.matchId, competition: target.competition, season: target.season,
          kickoffAt: target.kickoffAt, forecastAt: observation.observationAt, homeGoals: target.homeGoals,
          awayGoals: target.awayGoals, matrixA: A.matrix || input.baselineMatrix, matrixC: C.matrix || hybrid.matrix,
          probabilitiesA: A.decision, probabilitiesC: C.decision, quotes: observation.quotes,
          modelVersionA: input.baselineVersion, modelVersionC: enriched.version, phase: 'test',
          parentModelVersionC: artifact.version,
          probabilityProtocol, probabilityPipelineHash: enriched.pipelineHashV2 || enriched.pipelineHash,
          calibrationProfilesHash: createHash('sha256').update(JSON.stringify(profiles)).digest('hex'),
          originalT15ForecastAt: target.forecastAt,
          inputSnapshot: { observedAt: observation.observationAt, forecast: input, quotes: observation.quotes,
            historicalSnapshotId: observation.snapshotId, timestampEvidence: 'observed_snapshot' } });
        count++;
      } catch (error) { exclude(`forecast_rejected:${error.message}`); }
    }
    folds.push({ fold: fold.fold, modelVersion: enriched.version, parentVersion: fold.version, preparedMatches: count });
  }
  save(args.out, testRows);
  const report = { protocol: 'observed-snapshot-asof-forecast-v1', rows: testRows.length, folds, exclusions,
    probabilityProtocol, calibrationMode,
    forecastTime: 'actual_snapshot_observation', verifiedT15Freshness: 0,
    independentPayoutCalibrationSamples: 0, economicPerformanceAvailable: false, roi: null, clv: null,
    originalFinalHoldoutIncluded: false,
    inputHashes: { archive: hash(args.archive), trainerReport: hash(args.report), matches: hash(args.matches) },
    note: 'The original final holdout is excluded by default. This is exploratory historical snapshot analysis, not independent validation or T-15 execution.' };
  save(`${args.out}.metadata.json`, report);
  console.log(JSON.stringify(report));
}

async function main() {
  const args = options(process.argv.slice(2));
  if (!args.out) throw new Error('--out required');
  if (args.command === 'export') return exportArchive(args.out);
  if (args.command === 'audit') {
    if (!args.archive || !args.report) throw new Error('--archive and --report required');
    const report = auditArchive(load(args.archive), load(args.report));
    report.inputHashes = { archive: hash(args.archive), trainerReport: hash(args.report) };
    save(args.out, report); console.log(JSON.stringify({ snapshots: report.snapshots, benchmark: report.originalBenchmark })); return;
  }
  if (args.command === 'prepare') {
    if (!args.archive || !args.report || !args.models || !args.matches) throw new Error('--archive, --report, --models and --matches required');
    return prepareRows(args);
  }
  throw new Error('Commands: export --out archive.json; audit --archive archive.json --report trainer-report.json --out audit.json; prepare --archive archive.json --report trainer-report.json --models original-run-directory --matches matches.json --out rows.json');
}
if (require.main === module) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { auditArchive };
