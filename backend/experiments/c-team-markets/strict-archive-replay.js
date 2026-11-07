'use strict';
// Offline replay only: never opens a database, trains a model or calls a provider.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { CURRENT_CHALLENGER_RELEASE } = require('../../dist/research/CurrentChallengerRelease');
const { challengerTechnicalReason } = require('../../dist/research/ChallengerRecommendation');
const { buildChallengerTeamRecommendation } = require('../../dist/research/ChallengerTeamRecommendation');
const { CHALLENGER_TEAM_MARKETS, isChallengerStatMarket } = require('../../dist/research/ChallengerMarketCoverage');
const { recommendationQuoteReason } = require('../../dist/research/ResearchRecommendationPolicy');
const { appRecommendationQuote, settleAppRecommendationQuote } = require('../../dist/research/AppRecommendationQuotes');
const { isVisibleCanonicalTeamBet, operationalPredictionCodeHash, recommendationStateHash } = require('../../dist/services/CanonicalBetRecommendation');
const { predictionConfig } = require('../../dist/config/predictionConfig');
const { predictionEngineConfig } = require('../../dist/config/PredictionEngineConfig');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const jsonHash = value => hash(JSON.stringify(value));
const date = value => typeof value === 'string' && /(?:z|[+-]\d\d:\d\d)$/i.test(value) ? Date.parse(value) : NaN;
const expectedConfigHash = () => recommendationStateHash({ predictionConfig, predictionEngineConfig, minimumCalibrationSample: 30, anomalousEvPercent: 15 });
const goalSides = market => ['1x2', 'european_handicap'].includes(market) ? ['home', 'draw', 'away']
  : market === 'double_chance' ? ['1x', 'x2', '12'] : ['dnb', 'asian_handicap'].includes(market) ? ['home', 'away']
    : market === 'btts' ? ['yes', 'no'] : ['over', 'under'];
const sheetKey = q => JSON.stringify([q.market, q.bookmaker, q.source, q.capturedAt, q.updatedAt,
  q.market === 'asian_handicap' && q.side === 'away' ? -q.line : q.line ?? null, q.team ?? null]);
function completeSheet(quote, quotes) {
  const sides = goalSides(quote.market), found = new Map();
  for (const q of quotes.filter(q => sheetKey(q) === sheetKey(quote))) {
    if (!sides.includes(q.side) || found.has(q.side) && found.get(q.side) !== q.odds) return false;
    found.set(q.side, q.odds);
  }
  return sides.every(side => found.has(side));
}
function inspectRecord(record, expected = {}) {
  const reasons = [], reject = reason => { if (reason && !reasons.includes(reason)) reasons.push(reason); };
  record = record && typeof record === 'object' ? record : {};
  const snapshot = record.snapshot ?? {}, packet = snapshot.forecasts?.A, decision = snapshot.forecasts?.C?.decision;
  if (typeof record.id !== 'string' || !record.id.trim() || typeof record.matchId !== 'string' || !record.matchId.trim()) reject('record_identity_unavailable');
  const finalAt = date(snapshot.observedAt), asOf = date(packet?.asOf), kickoff = date(record.kickoffAt);
  if (!Number.isFinite(finalAt) || !Number.isFinite(asOf) || !Number.isFinite(kickoff) || asOf > finalAt || finalAt >= kickoff) reject('invalid_forecast_time');
  const expectedIdentity = { ...CURRENT_CHALLENGER_RELEASE };
  // Always retain the actual frozen C validation reason, even when A is invalid.
  let technical;
  try { technical = challengerTechnicalReason(decision, Number.isFinite(asOf) ? packet.asOf : snapshot.observedAt, expectedIdentity); }
  catch { technical = 'challenger_technical_validation_failed'; }
  reject(technical);
  const cAt = date(decision?.forecastAt), baseline = record.baselineInput, baselineAt = date(baseline?.forecastAt);
  const qualityFit = date(decision?.challengerQuality?.modelFitAt), qualityHistory = date(decision?.challengerQuality?.historyAvailableThrough);
  const calibrationAt = date(decision?.calibrationAvailableAt);
  if (![asOf, cAt, qualityFit, qualityHistory, calibrationAt].every(Number.isFinite)
    || cAt > asOf || qualityFit > cAt || qualityHistory > cAt || calibrationAt > cAt) reject('c_time_evidence_missing_or_future');
  const baselineFit = date(baseline?.modelFitAt), baselineHistory = date(baseline?.maxTrainingAvailableAt);
  if (!baseline || baseline.baselineVersion !== CURRENT_CHALLENGER_RELEASE.baselineVersion
    || baseline.matchId !== record.matchId || date(baseline.kickoffAt) !== kickoff
    || ![baselineAt, baselineFit, baselineHistory].every(Number.isFinite)
    || !Number.isSafeInteger(baseline.trainingCount) || baseline.trainingCount <= 0
    || baselineAt !== cAt || baselineAt > asOf || baselineFit > baselineAt || baselineHistory > baselineAt) {
    reject('baseline_training_evidence_missing_or_future');
  }
  if (!packet || packet.policyVersion !== 'match-page-recommendation-v1' || packet.model?.source !== 'PredictionService'
    || !/^APP-A-[a-f0-9]+$/.test(packet.model?.version ?? '') || !/^[a-f0-9]{64}$/i.test(packet.model?.stateHash ?? '')
    || packet.model?.codeHash !== (expected.codeHash ?? operationalPredictionCodeHash())
    || packet.model?.configHash !== (expected.configHash ?? expectedConfigHash())) reject('a_identity_mismatch');
  if (packet?.odds?.source !== 'odds_api' || !Number.isFinite(date(packet.odds.capturedAt)) || date(packet.odds.capturedAt) > asOf) reject('invalid_a_packet_odds');
  if (!Array.isArray(packet?.ranked) || !packet?.selected || !isVisibleCanonicalTeamBet(packet.selected)
    || !packet.ranked.some(op => op.selection === packet.selected.selection && Number(op.bookmakerOdds) === Number(packet.selected.bookmakerOdds))) reject('a_recommendation_unavailable');
  const raw = Array.isArray(snapshot.quoteSnapshots?.A) ? snapshot.quoteSnapshots.A : [];
  const quotes = [], seen = new Set();
  for (const q of raw) {
    if (!q || !CHALLENGER_TEAM_MARKETS.includes(q.market) || q.usedSyntheticOdds === true || q.used_synthetic_odds === true) continue;
    // These archived keys have no independently verified provider semantics in this input format.
    if (['shots', 'shots_on_target'].includes(q.market)) continue;
    if (recommendationQuoteReason(q, new Date(asOf), 'A') || recommendationQuoteReason(q, new Date(finalAt), 'A')
      || date(q.updatedAt) > date(q.capturedAt)) continue;
    const parsed = appRecommendationQuote(q.selection, q);
    if (!parsed || parsed.market !== q.market || parsed.side !== q.side || parsed.line !== q.line || parsed.team !== q.team) continue;
    const identity = JSON.stringify([sheetKey(q), q.side, q.selection, q.odds]);
    if (!seen.has(identity)) { seen.add(identity); quotes.push(q); }
  }
  const ranked = Array.isArray(packet?.ranked) ? packet.ranked : [];
  const selections = new Set(ranked.map(op => op?.selection));
  const unseenStat = Object.keys(packet?.probabilities?.decision ?? {}).filter(key => {
    const parsed = appRecommendationQuote(key, { odds: 2, bookmaker: 'evidence', source: 'odds_api', capturedAt: packet.asOf, updatedAt: packet.asOf });
    return parsed && isChallengerStatMarket(parsed.market) && !selections.has(key);
  });
  if (unseenStat.length) reject('specialist_opportunities_incomplete');
  const statOps = ranked.filter(op => quotes.some(q => q.selection === op.selection && isChallengerStatMarket(q.market)));
  if (statOps.some(op => !op.marketCategory || !op.marketTier || !Number.isFinite(op.ourProbability)
    || !Number.isFinite(op.expectedValue) || !Number.isFinite(op.edgeNoVig) || !Number.isFinite(op.suggestedStakePercent)
    || !op.confidence || op.isValueBet !== true || op.evReason !== 'computed'
    || typeof op.categoryCalibrationStatus !== 'string' || !Number.isFinite(op.calibrationSampleSize)
    || !Number.isFinite(op.sampleSize) || !Array.isArray(op.dataWarnings))) reject('specialist_qualification_incomplete');
  const a = packet?.selected;
  const aMatches = quotes.filter(q => q.selection === a?.selection && q.odds === Number(a?.bookmakerOdds)
    && packet?.odds?.bookmakerBySelection?.[q.selection] === q.bookmaker && packet.odds.capturedAt === q.capturedAt);
  const aq = aMatches.length === 1 ? aMatches[0] : undefined;
  if (!aq || !completeSheet(aq, quotes)) reject('a_quote_unavailable_or_incomplete');
  const ap = packet?.probabilities?.decision?.[a?.selection];
  if (!Number.isFinite(ap) || ap <= 0 || ap >= 1 || Math.abs(ap - Number(a?.ourProbability) / 100) > 1e-8
    || !(Number(a?.expectedValue) > 0)) reject('a_probability_or_value_invalid');
  let c;
  if (!technical && Number.isFinite(asOf)) {
    try { c = buildChallengerTeamRecommendation({ decision, quotes, observedAt: packet.asOf, competition: record.competition,
      expectedIdentity, allowedMarkets: [...CHALLENGER_TEAM_MARKETS], specialist: { packet, opportunities: ranked, matchId: record.matchId } }); }
    catch { reject('challenger_replay_error'); }
  }
  if (!technical && !c?.selected) reject('c_recommendation_unavailable');
  const cq = c?.selected?.quote;
  if (cq && (!completeSheet(cq, quotes) || recommendationQuoteReason(cq, new Date(finalAt), 'A'))) reject('c_quote_unavailable_or_incomplete');
  const match = { ...record.stats, home_goals: record.homeGoals, away_goals: record.awayGoals };
  const aResult = aq ? settleAppRecommendationQuote(aq, match) : null;
  const cResult = cq ? settleAppRecommendationQuote(cq, match) : null;
  if (aResult?.status === 'UNRESOLVED' || cResult?.status === 'UNRESOLVED') reject('settlement_data_unavailable');
  const pair = reasons.length ? null : { id: record.id, matchId: record.matchId, asOf: packet.asOf, competition: record.competition,
    aMarket: aq.market, cMarket: cq.market, aSelection: a.selection, cSelection: c.selected.selection,
    aOdds: aq.odds, cOdds: cq.odds, A: aResult, C: cResult };
  return { id: record.id, matchId: record.matchId, reasons, firstReason: reasons[0] ?? null,
    aMarket: aq?.market ?? null, cMarket: cq?.market ?? null, pair };
}
function runReplay(input, expected = {}) {
  if (!input || input.format !== 'c-team-archive-input-v1' || !Array.isArray(input.records)) throw new Error('invalid_archive_format');
  const inspected = input.records.map(record => inspectRecord(record, expected));
  const sorted = inspected.filter(item => item.pair).sort((a, b) => date(a.pair.asOf) - date(b.pair.asOf) || String(a.id).localeCompare(String(b.id)));
  const unique = new Map(); for (const item of sorted) if (!unique.has(item.matchId)) unique.set(item.matchId, item.pair);
  const pairs = [...unique.values()], firstReasons = {}, allReasons = {}, coverage = {};
  for (const item of inspected) {
    if (item.firstReason) firstReasons[item.firstReason] = (firstReasons[item.firstReason] ?? 0) + 1;
    for (const reason of item.reasons) allReasons[reason] = (allReasons[reason] ?? 0) + 1;
  }
  for (const market of CHALLENGER_TEAM_MARKETS) coverage[market] = {
    quotedRecords: input.records.filter(r => (r.snapshot?.quoteSnapshots?.A ?? []).some(q => q.market === market)).length,
    pairedA: pairs.filter(p => p.aMarket === market).length, pairedC: pairs.filter(p => p.cMarket === market).length };
  return { format: 'c-team-archive-report-v2', status: pairs.length ? 'ARCHIVE_CANDIDATE_PAIRS_ONLY' : 'INSUFFICIENT_ARCHIVE_DATA',
    economicComparison: { status: 'UNAVAILABLE', reason: 'selected_pairs_are_not_a_complete_backtest_cohort',
      profitUnitsA: null, profitUnitsC: null, roiA: null, roiC: null },
    limitations: { requiresBetForBothFamilies: true, selectsFirstEligibleSnapshot: true,
      archivedRankedTruncatedAndPerSheetOpportunitiesIncomplete: true, shotsAndShotsOnTargetQuarantined: true,
      archivedOldCIsNotCounterfactualCurrentC: true },
    records: input.records.length, excludedRecords: inspected.filter(item => item.reasons.length).length,
    firstReasons, allReasons, coverage, pairs, inspected };
}
if (require.main === module) {
  const args = process.argv.slice(2); const inputIndex = args.indexOf('--input'), outputIndex = args.indexOf('--out');
  if (args.length !== 4 || inputIndex < 0 || outputIndex < 0 || !args[inputIndex + 1] || !args[outputIndex + 1]) throw new Error('usage: node strict-archive-replay.js --input FILE --out NEW_DIR');
  const inputPath = path.resolve(args[inputIndex + 1]), outputPath = path.resolve(args[outputIndex + 1]);
  if (fs.existsSync(outputPath)) throw new Error('output_directory_already_exists');
  const bytes = fs.readFileSync(inputPath), input = JSON.parse(bytes.toString('utf8'));
  const report = runReplay(input), artifact = fs.readFileSync(path.resolve(__dirname, '../../current-models/challenger.json'));
  report.provenance = { inputSha256: hash(bytes), source: input.source ?? null, artifactSha256: hash(artifact),
    release: CURRENT_CHALLENGER_RELEASE, releaseSha256: jsonHash(CURRENT_CHALLENGER_RELEASE), operationalCodeHash: operationalPredictionCodeHash(), configHash: expectedConfigHash(),
    replayScriptSha256: hash(fs.readFileSync(__filename)),
    researchCodeSha256: Object.fromEntries(['ChallengerTeamRecommendation', 'ChallengerRecommendation', 'ChallengerSelection',
      'ResearchRecommendationPolicy', 'AppRecommendationQuotes', 'GoalSettlement', 'ChallengerMarketCoverage'].map(name =>
      [name, hash(fs.readFileSync(require.resolve(`../../dist/research/${name}`)))])) };
  fs.mkdirSync(outputPath, { recursive: false });
  fs.writeFileSync(path.join(outputPath, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  process.stdout.write(JSON.stringify({ status: report.status, pairs: report.pairs.length, output: outputPath }) + '\n');
}
module.exports = { inspectRecord, runReplay, expectedConfigHash, completeSheet, jsonHash };
