import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

export const CANONICAL_RECOMMENDATION_POLICY = 'match-page-recommendation-v1';

export interface CanonicalOpportunity {
  selection: string;
  marketName?: string;
  marketCategory?: string;
  marketType?: string;
  confidence?: string;
  bestBetStatus?: string;
  marketTier?: string;
  bookmakerOdds?: number | string;
  expectedValue?: number | string;
  edge?: number | string;
  edgeNoVig?: number | string;
  ourProbability?: number | string;
  kellyFraction?: number | string;
  suggestedStakePercent?: number | string;
  isValueBet?: boolean;
  evReason?: string;
  usedSyntheticOdds?: boolean;
}

export interface CanonicalRecommendation<T extends CanonicalOpportunity = CanonicalOpportunity> {
  policyVersion: typeof CANONICAL_RECOMMENDATION_POLICY;
  selected: T | null;
  ranked: T[];
  decisionStatus: 'RECOMMENDED' | 'NO_BET';
}

export interface OperationalModelIdentity {
  source: 'PredictionService';
  version: string;
  codeHash: string;
  configHash: string;
  stateHash: string;
}

export interface SharedPredictionOdds {
  odds: Record<string, number>;
  bookmakerBySelection: Record<string, string>;
  source: 'odds_api';
  capturedAt: string;
}

export interface CanonicalRecommendationPacket<T extends CanonicalOpportunity = CanonicalOpportunity>
  extends CanonicalRecommendation<T> {
  asOf: string;
  model: OperationalModelIdentity;
  odds: {
    source: string;
    capturedAt: string | null;
    bookmakerBySelection: Record<string, string>;
  };
  probabilities: {
    /** App DC/Poisson ensemble, before the app's existing value calibration. */
    raw: Record<string, number>;
    /** Final opportunity probabilities, in 0..1 units. */
    decision: Record<string, number>;
  };
}

const confidenceRank = (value?: string): number => value === 'HIGH' ? 3 : value === 'MEDIUM' ? 2 : 1;

/** The existing match-page score; this is deliberately not the engine's separate best-bet score. */
export function rankCanonicalOpportunity(opportunity: CanonicalOpportunity): number {
  const expectedValue = Number(opportunity.expectedValue ?? 0);
  const edge = Number(opportunity.edge ?? 0);
  const probability = Number(opportunity.ourProbability ?? 0);
  const normalizedProbability = probability > 1 ? probability / 100 : probability;
  return expectedValue * 0.55 + edge * 0.30 + normalizedProbability * 8 + confidenceRank(opportunity.confidence) * 4;
}

export function isWorthwhileLowCanonicalOpportunity(opportunity: CanonicalOpportunity): boolean {
  if (String(opportunity.confidence ?? '').toUpperCase() !== 'LOW') return false;
  const status = String(opportunity.bestBetStatus ?? '').toUpperCase();
  const tier = String(opportunity.marketTier ?? '').toUpperCase();
  const positive = (value: unknown) => Number.isFinite(Number(value)) && Number(value) > 0;
  return status !== 'SPECULATIVE' && tier !== 'SPECULATIVE'
    && opportunity.isValueBet !== false
    && Number.isFinite(Number(opportunity.bookmakerOdds)) && Number(opportunity.bookmakerOdds) > 1
    && positive(opportunity.expectedValue) && positive(opportunity.edgeNoVig)
    && positive(opportunity.kellyFraction) && positive(opportunity.suggestedStakePercent);
}

export function isVisibleCanonicalTeamBet(opportunity: CanonicalOpportunity): boolean {
  const category = String(opportunity.marketCategory ?? opportunity.marketType ?? '').toLowerCase();
  const selection = String(opportunity.selection ?? '').toLowerCase();
  const confidence = String(opportunity.confidence ?? '').toUpperCase();
  return !category.startsWith('player_') && !/^player_.+_(shots|sot|yellow)_(over|under)_/.test(selection)
    && String(opportunity.bestBetStatus ?? '').toUpperCase() !== 'SPECULATIVE'
    && String(opportunity.marketTier ?? '').toUpperCase() !== 'SPECULATIVE'
    && opportunity.usedSyntheticOdds !== true && opportunity.evReason !== 'synthetic_odds'
    && (confidence === 'HIGH' || confidence === 'MEDIUM' || isWorthwhileLowCanonicalOpportunity(opportunity))
    && Number.isFinite(Number(opportunity.bookmakerOdds)) && Number(opportunity.bookmakerOdds) > 1;
}

/** Preserve insertion order for exact score ties, including the backend's explained pick first. */
export function pickCanonicalBetRecommendation<T extends CanonicalOpportunity>(input: {
  bestValueOpportunity?: T | null;
  valueOpportunities?: readonly T[];
}): CanonicalRecommendation<T> {
  const candidates = new Map<string, T>();
  for (const opportunity of [input.bestValueOpportunity, ...(input.valueOpportunities ?? [])]) {
    if (!opportunity || !isVisibleCanonicalTeamBet(opportunity)) continue;
    const key = `${String(opportunity.selection ?? '')}::${String(opportunity.marketName ?? '')}`;
    if (!candidates.has(key)) candidates.set(key, opportunity);
  }
  const confidenceBand = (opportunity: T) =>
    ['HIGH', 'MEDIUM'].includes(String(opportunity.confidence ?? '').toUpperCase()) ? 1 : 0;
  const ranked = [...candidates.values()].sort((left, right) => confidenceBand(right) - confidenceBand(left)
    || rankCanonicalOpportunity(right) - rankCanonicalOpportunity(left)).slice(0, 3);
  return { policyVersion: CANONICAL_RECOMMENDATION_POLICY, selected: ranked[0] ?? null, ranked,
    decisionStatus: ranked.length ? 'RECOMMENDED' : 'NO_BET' };
}

function ordered(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(ordered);
  if (value instanceof Date) return value.toISOString();
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, ordered(child)]));
  return value;
}

export function recommendationStateHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(ordered(value)) ?? 'null').digest('hex');
}

let operationalCodeHash: string | undefined;
export function operationalPredictionCodeHash(): string {
  if (operationalCodeHash) return operationalCodeHash;
  const root = join(__dirname, '..');
  const extension = __filename.endsWith('.ts') ? '.ts' : '.js';
  const files: string[] = [];
  const collect = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) collect(path);
      else if (entry.name.endsWith(extension) && !entry.name.endsWith('.d.ts')) files.push(path);
    }
  };
  // Hash the operational implementation, not an unrelated Research A label or an ML artifact.
  for (const directory of ['services', 'models', 'config', 'utils']) collect(join(root, directory));
  operationalCodeHash = recommendationStateHash(files.sort().map((file) => [relative(root, file).replace(/\\/g, '/'),
    createHash('sha256').update(readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).digest('hex')]));
  return operationalCodeHash;
}

/** Shared prices are supplied by the caller; this helper performs no database or network work. */
export function validateSharedPredictionOdds(shared: SharedPredictionOdds, asOf: string): void {
  const captured = Date.parse(shared.capturedAt);
  const observed = Date.parse(asOf);
  if (shared.source !== 'odds_api' || !Number.isFinite(captured) || !Number.isFinite(observed) || captured > observed) {
    throw new Error('invalid_shared_prediction_odds_provenance');
  }
  for (const [selection, price] of Object.entries(shared.odds)) {
    if (!Number.isFinite(price) || price <= 1 || !String(shared.bookmakerBySelection[selection] ?? '').trim()) {
      throw new Error('invalid_shared_prediction_odds');
    }
  }
}
