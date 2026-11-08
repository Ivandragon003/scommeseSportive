'use strict';

// Retrospective mathematics only: this adapter never admits a live recommendation.
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createHash } = require('node:crypto');
const backend = path.resolve(__dirname, '../..');
const ts = require(path.join(backend, 'node_modules/typescript'));
const sourcePath = name => path.join(backend, 'src/research', `${name}.ts`);
const distPath = name => path.join(backend, 'dist/research', `${name}.js`);
const hash = value => createHash('sha256').update(value).digest('hex');
const sources = Object.fromEntries(['ChallengerTeamRecommendation', 'CoherentProbabilityPipeline', 'ResearchRecommendationRuntime']
  .map(name => [name, fs.readFileSync(sourcePath(name), 'utf8').replace(/\r\n/g, '\n')]));

function between(source, start, end) {
  const left = source.indexOf(start), right = source.indexOf(end, left + start.length);
  if (left < 0 || right < 0 || source.indexOf(start, left + start.length) >= 0) {
    throw new Error(`Retrospective extraction anchor missing or ambiguous: ${start}`);
  }
  return source.slice(left, right);
}

function compile(source, name) {
  const compiled = ts.transpileModule(source, { compilerOptions: {
    target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
  }, fileName: sourcePath(name), reportDiagnostics: true });
  const errors = (compiled.diagnostics ?? []).filter(d => d.category === ts.DiagnosticCategory.Error);
  if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
    getCanonicalFileName: f => f, getCurrentDirectory: () => backend, getNewLine: () => '\n',
  }));
  const module = { exports: {} };
  const filename = distPath(name);
  const localRequire = createRequire(filename);
  vm.runInThisContext(`(function(require,module,exports,__filename,__dirname){\n${compiled.outputText}\n})`, {
    filename: `${filename}.retrospective-adapter`,
  })(localRequire, module, module.exports, filename, path.dirname(filename));
  return module.exports;
}

const selectorSource = sources.ChallengerTeamRecommendation;
const selectorPrelude = selectorSource.slice(0, selectorSource.indexOf('export function buildChallengerTeamRecommendation(input: Input) {'));
if (!selectorPrelude || selectorPrelude === selectorSource) throw new Error('Missing current selector function');
const resultBlock = between(selectorSource, '  const exclusions: Record<string, number> = {};', '  const failure = challengerTechnicalReason');
const goalBlock = between(selectorSource, '  const opportunities: TeamOpportunity[] = [];', '  const specialist = input.specialist;');
const extractedSelector = compile(`${selectorPrelude}\nexport function evaluateExtracted(input: Input, usable: RecommendationQuote[], rejected: Record<string, number>) {\n${resultBlock}\nObject.assign(exclusions, rejected);\n${goalBlock}\nreturn result(opportunities);\n}\n`, 'ChallengerTeamRecommendation');

const pipelineSource = sources.CoherentProbabilityPipeline;
const blendBlock = between(pipelineSource, '  let matrix = calibratedMatrix;', '  return { protocol: COHERENT_PROBABILITY_PROTOCOL, mode, matrix,');
const extractedPipeline = compile(`${pipelineSource}\nexport function blendExtracted(calibratedMatrix: number[][], input: CoherentPipelineInput, eligibleQuotes: MarketQuote[]) {\nconst quoteExclusions: Record<string, number> = {};\nconst exclude = (reason: string) => { quoteExclusions[reason] = (quoteExclusions[reason] ?? 0) + 1; };\nconst bookmaker = chooseBookmaker(eligibleQuotes, exclude);\n${blendBlock}\nreturn { matrix, decision: jointMarkets(matrix, eligibleQuotes), calibrated: jointMarkets(calibratedMatrix, eligibleQuotes), bookmaker, marketBlendingApplied, quoteExclusions };\n}\n`, 'CoherentProbabilityPipeline');

const actualPipeline = require(distPath('CoherentProbabilityPipeline'));
const { appRecommendationQuote } = require(distPath('AppRecommendationQuotes'));
const { settleGoalQuote, normalizeScoreMatrix } = require(distPath('GoalSettlement'));
const { CHALLENGER_TEAM_MARKETS, isChallengerStatMarket } = require(distPath('ChallengerMarketCoverage'));

// The current runtime's candidate conversion and dynamic-stake filter are copied
// mechanically; source drift changes the recorded extract identity.
const runtimeSource = sources.ResearchRecommendationRuntime;
const candidateBlock = between(runtimeSource, '          for (const opportunity of allOpportunities) {', '\n        }\n      }\n      for (const [family, candidates]');
const eligibilityBlock = between(runtimeSource, '        const eligible = this.fundedMode || this.dynamicMode', '        const selections = bestPaperSelections');
const dynamicBlock = between(runtimeSource, '        const selections = bestPaperSelections(this.dynamicMode ? eligible.filter((candidate) => {', '\n        if (selections.length)');
const qualificationSource = `
import { isVisibleCanonicalTeamBet } from '../services/CanonicalBetRecommendation';
import { bestPaperSelections, paperSelectionKey } from './PaperBetSelections';
import { researchHash } from './ResearchStore';
const finiteProbability = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0 && value < 1;
const object = (value: unknown): Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function qualifyExtracted(allOpportunities: any[], configuration: any) {
const challengerCandidates: any[] = [], group: any[] = [];
const decisionC = { probabilityConfigurationHash: null }, teamMarketsC = true;
${candidateBlock}
const candidates = challengerCandidates;
${eligibilityBlock}
${dynamicBlock}
return selections;
}`;
const qualification = compile(qualificationSource, 'ResearchRecommendationRuntime');
const qualificationThis = { deploymentC: { deployment: { selectorPolicy: 'canonical-binary-v1' } }, dynamicMode: true, fundedMode: true };

function mathematicalQuoteReason(quote) {
  if (!quote || !['football_data_csv', 'odds_api'].includes(quote.source)
    || quote.usedSyntheticOdds === true || settleGoalQuote(quote, 0, 0).status === 'UNRESOLVED') return 'non_real_or_invalid_quote';
  if (quote.source === 'football_data_csv' && (quote.priceType !== 'closing'
    || quote.timestampEvidence !== 'observed_snapshot' || quote.updatedAt !== undefined)) return 'invalid_closing_csv_evidence';
  const parsed = appRecommendationQuote(quote.selection, quote);
  if (!parsed || parsed.market !== quote.market || parsed.side !== quote.side || parsed.line !== quote.line || parsed.team !== quote.team) return 'quote_selection_mismatch';
  if (Date.parse(quote.updatedAt) > Date.parse(quote.capturedAt)) return 'invalid_quote_provenance';
  return null;
}

function usableQuotes(quotes, allowedMarkets) {
  const rejected = {}, usable = [];
  for (const quote of quotes ?? []) {
    const reason = mathematicalQuoteReason(quote)
      || (!CHALLENGER_TEAM_MARKETS.includes(quote.market) || isChallengerStatMarket(quote.market) ? 'goal_market_not_supported' : null)
      || (allowedMarkets && !allowedMarkets.includes(quote.market) ? 'market_not_allowed' : null);
    if (reason) rejected[reason] = (rejected[reason] ?? 0) + 1;
    else usable.push(quote);
  }
  return { usable, rejected };
}

function calibrateAndBlend(input) {
  const calibrated = actualPipeline.applyCoherentProbabilityPipeline({ ...input, quotes: [] });
  const { usable, rejected } = usableQuotes(input.quotes);
  const blended = extractedPipeline.blendExtracted(calibrated.matrix, input, usable);
  return { ...calibrated, ...blended, quoteExclusions: { ...rejected, ...blended.quoteExclusions },
    retrospectiveOnly: true, quoteTiming: 'closing_download_observation_not_forecast_capture' };
}

function evaluateGoalRecommendations(input) {
  // Never supply `validated`, fake capture times, or an operational admission token.
  normalizeScoreMatrix(input.decision?.prospectiveMatrix);
  if (!input.decision?.modelVersion || !input.decision?.probabilityConfiguration || !input.decision?.probabilityConfigurationHash) {
    throw new Error('Retrospective decision requires actual model/configuration metadata');
  }
  const { usable, rejected } = usableQuotes(input.quotes, input.allowedMarkets);
  return { ...extractedSelector.evaluateExtracted(input, usable, rejected), retrospectiveOnly: true,
    admissionChecksApplied: false, quoteTiming: 'closing_download_observation_not_forecast_capture' };
}

function qualifyAll(opportunities, configuration = null) {
  return qualification.qualifyExtracted.call(qualificationThis, opportunities, configuration);
}

function identities() {
  const sourceHashes = Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, hash(source)]));
  const distHashes = Object.fromEntries(Object.keys(sources).map(name => [name, hash(fs.readFileSync(distPath(name)))]));
  const extracts = { selectorPrelude: hash(selectorPrelude), resultBlock: hash(resultBlock), goalBlock: hash(goalBlock),
    blendBlock: hash(blendBlock), candidateBlock: hash(candidateBlock), eligibilityBlock: hash(eligibilityBlock), dynamicBlock: hash(dynamicBlock) };
  // Compile the complete source and compare code to the built module. This fails
  // closed when a stale dist would silently execute different dependencies.
  const buildParity = Object.fromEntries(Object.keys(sources).map(name => {
    const expected = ts.transpileModule(sources[name], { compilerOptions: {
      target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
    } }).outputText.replace(/\r\n/g, '\n').trim();
    const actual = fs.readFileSync(distPath(name), 'utf8').replace(/\r\n/g, '\n').trim();
    return [name, expected === actual];
  }));
  return { version: 'current-c-retrospective-math-v1', sourceHashes, distHashes, extracts, buildParity,
    adapterHash: hash(fs.readFileSync(__filename)), probabilityPipelineHash: actualPipeline.coherentProbabilityPipelineHash() };
}

module.exports = { calibrateAndBlend, evaluateGoalRecommendations, qualifyAll, identities };
