'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = path.resolve(__dirname, '../../..');
const { buildForecastInput, baselineManifest } = require('../../dist/research/ForecastCore');
const { predictHybrid, validateArtifact } = require('../../dist/research/CatBoostModel');
const { filterChallengerHistory, CHALLENGER_DATA_QUALITY_POLICY_HASH } = require('../../dist/research/ChallengerDataQuality');
const { resolveNightlyForecastAt } = require('../../dist/research/ForecastDecisionTime');
const { coherentProbabilityPipelineHash } = require('../../dist/research/CoherentProbabilityPipeline');
const { buildProbabilityConfiguration } = require('../../dist/research/ProbabilityConfiguration');
const { researchHash } = require('../../dist/research/ResearchStore');
const { settleGoalQuote } = require('../../dist/research/GoalSettlement');
const { appRecommendationQuote } = require('../../dist/research/AppRecommendationQuotes');
const { CURRENT_CHALLENGER_RELEASE } = require('../../dist/research/CurrentChallengerRelease');
const adapter = require('./selector-math.cjs');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const args = {};
for (let index = 2; index < process.argv.length; index += 2) {
  if (!['--inputs', '--out', '--limit'].includes(process.argv[index]) || !process.argv[index + 1]) throw Error('Invalid replay option');
  args[process.argv[index].slice(2)] = process.argv[index + 1];
}
if (!args.inputs || !args.out || fs.existsSync(args.out)) throw Error('Inputs and a new output path are required');
const inputs = path.resolve(args.inputs);
const modelFile = path.join(root, 'backend/current-models/challenger.json');
const datasetFile = path.join(root, 'backend/artifacts/operations/shared-baseline-20261107/candidate-v2-current-dataset.json');
const files = [modelFile, datasetFile, ...['history.json', 'matches.json', 'quotes.json', 'models.json', 'deployment.json', 'freeze-manifest.json'].map(file => path.join(inputs, file)),
  path.join(root, 'backend/src/research/original-holdout-policy.json'), path.join(root, 'backend/src/research/challenger-data-quarantine.json')];
const originalHashes = Object.fromEntries(files.map(file => [path.relative(root, file).replaceAll('\\', '/'), sha(file)]));
const adapterIdentity = adapter.identities();
assert(Object.values(adapterIdentity.buildParity).every(Boolean), 'Compiled current modules must match current source');
const artifact = read(modelFile);
const dataset = read(datasetFile);
const quoteData = read(path.join(inputs, 'quotes.json'));
const history = filterChallengerHistory(read(path.join(inputs, 'history.json')));
const historyById = new Map(history.map(row => [row.matchId, row]));
const frozenById = new Map(dataset.rows.map(row => [row.matchId, row]));
assert.equal(frozenById.size, dataset.rows.length);
assert.equal(historyById.size, history.length);
assert.equal(artifact.version, CURRENT_CHALLENGER_RELEASE.modelVersion);
assert.equal(CURRENT_CHALLENGER_RELEASE.selectorPolicy, 'canonical-binary-v1');
assert.equal(artifact.baselineVersion, baselineManifest().version);
assert.equal(dataset.baselineManifest.version, artifact.baselineVersion);
assert.equal(sha(datasetFile), artifact.datasetHash);
assert.equal(researchHash(artifact), CURRENT_CHALLENGER_RELEASE.artifactHash);
assert.equal(artifact.pipelineHashV2, coherentProbabilityPipelineHash());
validateArtifact(artifact);
const registry = read(path.join(inputs, 'models.json'));
const deployment = read(path.join(inputs, 'deployment.json'));
const remote = registry.find(row => row.version === artifact.version);
assert.equal(remote?.artifact_hash, researchHash(artifact));
if (deployment.length) assert.equal(JSON.parse(deployment[0].deployment_json).modelVersion, artifact.version);
const configuration = buildProbabilityConfiguration({ family: 'C', baselineVersion: artifact.baselineVersion,
  pipelineHashV2: artifact.pipelineHashV2, mode: artifact.probabilityCalibrationMode,
  temperature: artifact.probabilityTemperature, profile: artifact.calibrationProfilesV2.C });
assert.equal(configuration.hash, CURRENT_CHALLENGER_RELEASE.probabilityConfigurationHash);
for (const source of quoteData.sources) assert.equal(sha(path.join(root, source.file)), source.sha256);

function targetOf(match) {
  return { matchId: match.matchId, homeTeamId: match.homeTeamId, awayTeamId: match.awayTeamId,
    date: match.date, competition: match.competition, season: match.season };
}
function reconstruct(record, past = history) {
  const match = historyById.get(record.matchId);
  if (!match) throw Error('Target absent from clean history');
  return { ...buildForecastInput(past, targetOf(match), resolveNightlyForecastAt(match.date, { hour: 3, minute: 7 })),
    dataQualityPolicyHash: CHALLENGER_DATA_QUALITY_POLICY_HASH, dataQualityBaselineClean: true };
}

const reconstructionChecks = [];
function maximumNumericDifference(actual, expected) {
  if (typeof actual === 'number' && typeof expected === 'number') return Math.abs(actual - expected);
  if (Array.isArray(actual) && Array.isArray(expected)) {
    assert.equal(actual.length, expected.length);
    return Math.max(0, ...actual.map((value, index) => maximumNumericDifference(value, expected[index])));
  }
  if (actual && expected && typeof actual === 'object' && typeof expected === 'object') {
    assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
    return Math.max(0, ...Object.keys(actual).map(key => maximumNumericDifference(actual[key], expected[key])));
  }
  assert.deepEqual(actual, expected);
  return 0;
}
for (const league of [...new Set(quoteData.rows.map(row => row.competition))]) {
  const record = quoteData.rows.find(row => row.competition === league && frozenById.has(row.matchId));
  if (!record) continue;
  const frozen = frozenById.get(record.matchId), rebuilt = reconstruct(record);
  const project = row => artifact.featureNames.map(name => row.features[row.featureNames.indexOf(name)]);
  let maximumDifference = maximumNumericDifference(project(rebuilt), project(frozen));
  for (const field of ['baselineMatrix', 'baselineProbabilities', 'lambdaHome', 'lambdaAway',
    'maxTrainingAvailableAt', 'trainingCount', 'modelFitAt', 'forecastAt', 'baselineVersion']) maximumDifference = Math.max(maximumDifference,
      maximumNumericDifference(rebuilt[field], frozen[field]));
  assert(maximumDifference <= 1e-12, `${record.matchId}: reference reconstruction drift`);
  reconstructionChecks.push({ matchId: record.matchId, competition: league, consumedFeatureCount: artifact.featureNames.length,
    maximumAbsoluteDifference: maximumDifference, tolerance: 1e-12 });
}
const sentinels = [];
for (const record of quoteData.rows.filter(row => !frozenById.has(row.matchId)).slice(0, 2)) {
  const normal = reconstruct(record);
  const changed = history.map(row => row.matchId === record.matchId ? { ...row, homeGoals: 97, awayGoals: 98, homeXG: 96, awayXG: 95 } : row);
  assert.deepEqual(reconstruct(record, changed), normal, 'Target outcome leaked into forecast inputs');
  sentinels.push({ matchId: record.matchId, targetOutcomeAndXgPerturbed: true, forecastUnchanged: true });
}

function quotesFor(record) {
  const common = { bookmaker: record.bookmaker, source: record.source, priceType: 'closing',
    capturedAt: record.archiveAcquiredAt, timestampEvidence: 'observed_snapshot', historicalPriceTimestamp: null };
  const result = [];
  const add = (selection, price) => {
    const parsed = appRecommendationQuote(selection, { ...common, odds: price });
    assert(parsed, `Invalid current selection alias: ${selection}`);
    result.push(parsed);
  };
  if (record.sheets['1x2']) ['homeWin', 'draw', 'awayWin'].forEach((selection, index) => add(selection, record.sheets['1x2'].prices[index]));
  if (record.sheets.totals) ['over25', 'under25'].forEach((selection, index) => add(selection, record.sheets.totals.prices[index]));
  if (record.sheets.asian_handicap) {
    const threshold = String(-record.asianHomeLine);
    add(`ahcp_${threshold}`, record.sheets.asian_handicap.prices[0]);
    add(`ahcp_away_${threshold}`, record.sheets.asian_handicap.prices[1]);
    assert(result.at(-2).line === record.asianHomeLine);
    assert(result.at(-1).line === -record.asianHomeLine);
  }
  return result;
}

// An independent arithmetic settlement checks the production settlement, including split handicaps.
function independentReturn(quote, home, away) {
  if (quote.market === '1x2') return (quote.side === 'home' ? home > away : quote.side === 'away' ? away > home : home === away) ? quote.odds : 0;
  if (quote.market === 'totals') return (quote.side === 'over' ? home + away > quote.line : home + away < quote.line) ? quote.odds : home + away === quote.line ? 1 : 0;
  const difference = quote.side === 'home' ? home - away : away - home;
  const settle = adjustment => difference + adjustment > 0 ? quote.odds : difference + adjustment === 0 ? 1 : 0;
  const halves = quote.line * 2;
  return Number.isInteger(halves) ? settle(quote.line) : (settle(Math.floor(halves) / 2) + settle(Math.ceil(halves) / 2)) / 2;
}
function label(quote) {
  if (quote.market === '1x2') return { home: 'Vittoria casa (1)', away: 'Vittoria ospite (2)', draw: 'Pareggio (X)' }[quote.side];
  if (quote.market === 'totals') return `${quote.side === 'under' ? 'Under' : 'Over'} ${String(quote.line).replace('.', ',')} gol`;
  return `Handicap asiatico ${quote.side === 'home' ? 'casa' : 'ospite'} ${quote.line > 0 ? '+' : ''}${String(quote.line).replace('.', ',')}`;
}
function ranking(bets) {
  const groups = new Map();
  for (const bet of bets) {
    const key = JSON.stringify([bet.quote.market, bet.quote.side, bet.quote.line ?? null]);
    const row = groups.get(key) || { label: label(bet.quote), market: bet.quote.market, side: bet.quote.side, line: bet.quote.line ?? null,
      total: 0, WON: 0, LOST: 0, HALF_WON: 0, HALF_LOST: 0, VOID: 0 };
    row.total++; row[bet.status]++; groups.set(key, row);
  }
  return [...groups.values()].map(row => ({ ...row, negativeOutcomes: row.LOST + row.HALF_LOST,
    negativeRate: (row.LOST + row.HALF_LOST) / (row.total - row.VOID), voidExcludedDenominator: row.total - row.VOID }))
    .sort((a, b) => b.negativeOutcomes - a.negativeOutcomes || b.LOST - a.LOST || b.total - a.total || a.label.localeCompare(b.label));
}
let records = quoteData.rows;
if (args.limit) records = records.slice(0, Number(args.limit));
const rows = [], bets = [], exclusions = {};
const count = key => { exclusions[key] = (exclusions[key] || 0) + 1; };
for (const record of records) {
  const frozen = frozenById.get(record.matchId);
  const input = frozen || reconstruct(record);
  assert.equal(input.kickoffAt, record.kickoffAt);
  assert.equal(input.competition, record.competition);
  if (frozen) { assert.equal(frozen.homeGoals, record.homeGoals); assert.equal(frozen.awayGoals, record.awayGoals); }
  assert(Date.parse(input.forecastAt) > Date.parse(artifact.validationThrough));
  assert(Date.parse(input.forecastAt) < Date.parse(record.kickoffAt));
  assert(!input.maxTrainingAvailableAt || Date.parse(input.maxTrainingAvailableAt) <= Date.parse(input.forecastAt));
  assert(Date.parse(input.modelFitAt) <= Date.parse(input.forecastAt));
  const indices = artifact.featureNames.map(name => input.featureNames.indexOf(name));
  assert(indices.every(index => index >= 0));
  const raw = predictHybrid({ ...input, featureNames: artifact.featureNames, featureSchema: artifact.featureSchema,
    features: indices.map(index => input.features[index]) }, artifact);
  const quotes = quotesFor(record);
  const pipeline = adapter.calibrateAndBlend({ matrix: raw.matrix, rawProbabilities: raw.probabilities,
    profile: artifact.calibrationProfilesV2.C, mode: artifact.probabilityCalibrationMode,
    temperature: artifact.probabilityTemperature, forecastAt: input.forecastAt, quotes });
  assert(pipeline.marketBlendingApplied, 'A complete real closing 1X2 sheet must blend');
  const decision = { modelVersion: artifact.version, prospectiveMatrix: pipeline.matrix,
    probabilityConfiguration: configuration.descriptor, probabilityConfigurationHash: configuration.hash };
  const packet = adapter.evaluateGoalRecommendations({ decision, quotes, competition: record.competition,
    allowedMarkets: ['1x2', 'totals', 'asian_handicap'] });
  for (const [reason, countValue] of Object.entries(packet.exclusions || {})) exclusions[reason] = (exclusions[reason] || 0) + countValue;
  const selected = adapter.qualifyAll(packet.opportunities, packet.probabilityConfiguration);
  const betIds = [];
  for (const opportunity of selected) {
    const quote = opportunity.quote;
    assert.equal(quote.source, 'football_data_csv');
    assert.equal(quote.bookmaker, 'Bet365');
    assert.equal(quote.priceType, 'closing');
    assert.equal(quote.updatedAt, undefined);
    const settled = settleGoalQuote(quote, record.homeGoals, record.awayGoals);
    assert.notEqual(settled.status, 'UNRESOLVED');
    assert(Math.abs(settled.returnMultiplier - independentReturn(quote, record.homeGoals, record.awayGoals)) < 1e-12);
    const id = `${record.matchId}:${opportunity.selectionKey}`;
    betIds.push(id);
    bets.push({ id, matchId: record.matchId, competition: record.competition, season: record.season,
      kickoffAt: record.kickoffAt, featureForecastAt: input.forecastAt, home: record.home, away: record.away,
      goals: [record.homeGoals, record.awayGoals], quote, probability: opportunity.probability,
      expectedValue: opportunity.ev, confidence: opportunity.confidence, suggestedStakePercent: opportunity.suggestedStakePercent,
      status: settled.status, returnMultiplier: settled.returnMultiplier, flatUnitProfit: settled.returnMultiplier - 1,
      sourceSha256: record.sourceSha256, csvRowNumber: record.csvRowNumber, selectionKey: opportunity.selectionKey,
      strictOperationalEligible: false });
  }
  if (!selected.length) count('match_abstained');
  rows.push({ matchId: record.matchId, competition: record.competition, season: record.season,
    kickoffAt: record.kickoffAt, featureForecastAt: input.forecastAt, historicalPriceTimestamp: null,
    inputOrigin: frozen ? 'original_frozen_training_dataset' : 'chronological_reconstruction_current_history',
    opportunitiesBeforeExecutionFilters: packet.opportunities.length, bets: betIds,
    strictOperationalEligible: false, artifactCreatedAfterFeatureForecast: Date.parse(artifact.createdAt) > Date.parse(input.forecastAt) });
  if (rows.length % 50 === 0) console.log(JSON.stringify({ processed: rows.length, cohort: records.length, selected: bets.length }));
}
assert.equal(new Set(bets.map(bet => bet.id)).size, bets.length);
for (const [file, expected] of Object.entries(originalHashes)) assert.equal(sha(path.join(root, file)), expected, `Input changed: ${file}`);
for (const source of quoteData.sources) assert.equal(sha(path.join(root, source.file)), source.sha256);
const summaryFor = subset => ({ matches: subset.length, matchesWithBet: subset.filter(row => row.bets.length).length,
  abstentions: subset.filter(row => !row.bets.length).length, selectedBets: subset.reduce((total, row) => total + row.bets.length, 0) });
const report = { protocol: 'current-c-real-closing-selector-replay-v1', createdAt: new Date().toISOString(), modelVersion: artifact.version,
  baselineVersion: artifact.baselineVersion, artifactCreatedAt: artifact.createdAt, artifactHash: researchHash(artifact),
  probabilityConfigurationHash: configuration.hash, baselineManifest: baselineManifest(), sourceHashes: originalHashes,
  selectorAdapter: adapterIdentity, runnerSha256: sha(__filename), partial: !!args.limit, databaseWrites: 0, operationalStrategyChanged: false,
  scope: 'Retrospective fixed-current-C goal selector with real Bet365 closing prices; NOT historical Nightly execution, full-market evaluation or prospective validation.',
  assumptions: ['Feature snapshots use the historical nominal 03:07 Europe/Rome boundary; closing-price selection is a separate scenario.',
    'CSV archive acquisition time is preserved solely as provenance and for mathematical settlement, never as a historical price observation time.',
    'Historical prices are closing columns from one real bookmaker; no synthetic, average or market-maximum prices are used.',
    'The current artifact was created after all evaluated games. Dates are preserved and operational availability is never asserted.',
    '595 games from the prior season belong to a previously consulted test; this is retrospective evaluation, not a fresh independent test.',
    'The 745 original protected target IDs and 22 quarantine IDs remain excluded. Seasons before January 2026 cannot be evaluated out of sample with these fixed current weights.',
    'Only 1X2, total goals 2.5 and quoted Asian handicaps are covered; no real historical prices/state are available here for the remaining current C markets.',
    'All dynamically qualifying selections are counted; bankroll funding is not simulated.'],
  trainingSplit: artifact.trainingSplit, priceCoverage: quoteData.coverage, priceExclusions: quoteData.exclusions,
  coverage: summaryFor(rows), bySeason: Object.fromEntries([...new Set(rows.map(row => row.season))].sort().map(season => [season, summaryFor(rows.filter(row => row.season === season))])),
  ranking: ranking(bets), rankingBySeason: Object.fromEntries([...new Set(rows.map(row => row.season))].sort().map(season => [season, ranking(bets.filter(bet => bet.season === season))])),
  statusCounts: bets.reduce((all, bet) => ({ ...all, [bet.status]: (all[bet.status] || 0) + 1 }), {}),
  checks: { currentRegistryArtifactHashMatched: true, baselineAndPipelineMatched: true, inputHashesUnchanged: true,
    referenceReconstruction: reconstructionChecks, targetLeakageSentinels: sentinels,
    independentSettlementChecks: bets.length, uniqueSelections: bets.length, abstentionsPreserved: true, syntheticPrices: 0 },
  exclusions, rows, bets };
fs.writeFileSync(path.resolve(args.out), JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ report: args.out, coverage: report.coverage, bySeason: report.bySeason,
  statuses: report.statusCounts, ranking: report.ranking.slice(0, 12) }, null, 2));
