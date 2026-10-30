type Row = Record<string, any>;
type ViewOptions = { matchId?: string; family?: 'A' | 'C'; limit?: number;
  includeForecasts?: boolean; includeProbabilityStages?: boolean };
type LegacyReader = { listDecisions: (options?: any) => Promise<Row[]>;
  listLegacyDecisionViews?: (options?: ViewOptions) => Promise<Row[]> };
export type RecommendationReader = { listDecisionViews: (options?: ViewOptions) => Promise<Row[]>;
  getComparisonDecisionPairs?: (options: { from: string; to: string; limit?: number }) => Promise<{
    pairs: Array<{ A: Row; C: Row }>; comparedCount: number; differentCount: number; incompleteCount: number; truncated: boolean;
    earliestCreatedAt?: string | null;
  }> };
export type TechnicalAbstentionProjection = {
  projectionKind: 'technical_abstention'; selected: null; ranked: [];
  decisionStatus: 'NO_BET'; status: 'ABSTAIN'; actualStakeAmount: 0;
  reason: string | null; asOf: string | null; placedAt: null;
  source: null; model: null; probabilities: null; odds: null;
  decisionId: string; originDecisionId: string | null; policyHash: string | null; policyVersion: string | null;
  recordedAction: 'ABSTAIN'; recordedModelVersion: string | null; recordedAt: string | null;
  quoteArchived: false; quoteStatus: 'UNAVAILABLE'; quoteCapturedAt: null;
};

const snapshot = (row: Row): Row => row.snapshot ?? {};
const at = (row: Row): number => Date.parse(row.createdAt ?? '') || 0;
const identity = (row: Row): string => JSON.stringify([
  row.matchId ?? snapshot(row).match?.matchId ?? row.jobId,
  row.family, row.portfolioId ?? `shadow_${row.family}`,
]);

/** An already debited bet remains authoritative even if a later policy abstained. */
function authorizesExistingBet(row: Row): boolean {
  if (row.betId) return true;
  if (typeof row.id !== 'string' || !row.id) return false;
  return row.authority === 'execution'
    ? row.existingBetExecutionDecisionId === row.id
    : !row.existingBetExecutionDecisionId && row.existingBetOriginDecisionId === row.id;
}

export function researchDecisionView(row: Row, authority: 'legacy' | 'execution' = row.authority === 'execution' ? 'execution' : 'legacy'): Row {
  const saved = snapshot(row);
  return { ...row, authority, effective: true,
    quote: row.quote ?? saved.quote ?? null,
    probability: row.probability ?? saved.probability ?? null,
    ev: row.ev ?? saved.ev ?? null,
    confidence: row.confidence ?? saved.confidence ?? null,
    suggestedStakePercent: row.suggestedStakePercent ?? saved.suggestedStakePercent ?? saved.stakePercent ?? null,
    stakeCents: row.betStakeCents ?? row.stakeCents ?? saved.stakeCents ?? null,
    policyHash: row.policyHash ?? saved.policyHash ?? null,
    policyVersion: row.policyVersion ?? saved.policyVersion ?? null,
    modelSource: row.family === 'A' && authority === 'execution' ? 'PredictionService'
      : row.family === 'C' ? 'CatBoost hybrid research pipeline' : 'Historical research baseline',
    probabilitySource: row.probabilitySource ?? saved.probabilitySource
      ?? (row.family === 'A' && authority === 'execution' ? 'canonical_match_page_decision' : 'recorded_research_decision'),
    probabilityStages: row.probabilityStages ?? saved.probabilityStages,
  };
}

/** Overlay is only a read model: no original decision, stake or ledger is rewritten. */
export function effectiveRecommendationDecisions(legacy: Row[], execution: Row[]): { effective: Row[]; historical: Row[] } {
  const all = [...legacy.map((row) => researchDecisionView(row, 'legacy')), ...execution.map((row) => researchDecisionView(row, 'execution'))];
  const chosen = new Map<string, Row>();
  for (const row of all.sort((a, b) => at(a) - at(b) || String(a.id).localeCompare(String(b.id)))) {
    const key = identity(row), prior = chosen.get(key);
    if (!prior || (!authorizesExistingBet(prior) && (authorizesExistingBet(row)
      || row.authority === 'execution' || prior.authority !== 'execution'))) chosen.set(key, row);
  }
  const historical = all.map<Row>((row) => {
    const effective = chosen.get(identity(row));
    return { ...row, effective: effective === row, supersededBy: effective === row ? null : effective?.id ?? null };
  });
  return { effective: historical.filter((row) => row.effective).sort((a, b) => at(a) - at(b) || String(a.id).localeCompare(String(b.id))),
    historical: historical.sort((a, b) => at(a) - at(b) || String(a.id).localeCompare(String(b.id))) };
}

export async function readEffectiveResearchDecisions(research: LegacyReader, recommendations?: RecommendationReader,
  options: ViewOptions = {}): Promise<{ effective: Row[]; historical: Row[] }> {
  const limit = Math.max(1, Math.min(1000, Math.floor(options.limit ?? 500)));
  const query = { ...options, limit };
  const [legacy, execution] = await Promise.all([
    research.listLegacyDecisionViews ? research.listLegacyDecisionViews(query) : research.listDecisions(),
    recommendations?.listDecisionViews(query) ?? Promise.resolve([]),
  ]);
  // The fallback serves older injected stores; production uses bounded SQL projections.
  return effectiveRecommendationDecisions(legacy.slice(-limit), execution.slice(-limit));
}

/** Project the exact frozen advice, including a recorded abstention, onto the match page. */
export function projectAutomaticRecommendationA(prediction: Row, decision?: Row | null): Row {
  if (!decision || decision.family !== 'A' || decision.authority !== 'execution') return prediction;
  const packet = decision.recommendationPacket;
  if (!packet || typeof packet !== 'object' || !Object.prototype.hasOwnProperty.call(packet, 'selected')) {
    if (decision.action === 'ABSTAIN' && !decision.betId && !authorizesExistingBet(decision)) {
      const abstention: TechnicalAbstentionProjection = {
        projectionKind: 'technical_abstention', selected: null, ranked: [], decisionStatus: 'NO_BET',
        actualStakeAmount: 0, status: 'ABSTAIN', reason: decision.reason ?? null,
        asOf: decision.forecastAt ?? snapshot(decision).forecastAt ?? decision.createdAt ?? null, placedAt: null,
        source: null, model: null, probabilities: null, odds: null,
        decisionId: decision.id, originDecisionId: decision.originDecisionId ?? null,
        policyHash: decision.policyHash ?? null, policyVersion: decision.policyVersion ?? null,
        recordedAction: 'ABSTAIN', recordedModelVersion: decision.modelVersion ?? null, recordedAt: decision.createdAt ?? null,
        quoteArchived: false, quoteStatus: 'UNAVAILABLE', quoteCapturedAt: null,
      };
      return { ...prediction, canonicalRecommendation: abstention, automaticRecommendation: abstention };
    }
    throw new Error('Recorded recommendation packet unavailable');
  }
  const stakeCents = decision.betStakeCents ?? decision.stakeCents ?? snapshot(decision).stakeCents;
  const actualStakeAmount = decision.action === 'BET' && Number.isInteger(stakeCents) && stakeCents >= 0 ? stakeCents / 100 : 0;
  const automatic = { ...packet, actualStakeAmount,
    status: decision.betStatus ?? decision.status ?? decision.action,
    placedAt: decision.betPlacedAt ?? decision.placedAt ?? null, reason: decision.reason ?? null,
    decisionId: decision.id, originDecisionId: decision.originDecisionId ?? null,
    policyHash: decision.policyHash ?? null, policyVersion: decision.policyVersion ?? null,
    quoteArchived: true, quoteStatus: 'ARCHIVED', quoteCapturedAt: decision.quote?.capturedAt ?? packet.odds?.capturedAt ?? null };
  return { ...prediction, canonicalRecommendation: automatic, automaticRecommendation: automatic };
}
