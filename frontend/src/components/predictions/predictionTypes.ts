export type ReplayTone = 'info' | 'success' | 'warning' | 'danger';

export interface OddsSourceBadgeInfo {
  label: string;
  className: string;
}

export interface BestValueOpportunity {
  selection: string;
  marketName: string;
  selectionLabel?: string;
  bookmakerOdds?: number | string;
  confidence?: string;
  marketTier?: string;
  humanSummary?: string;
  humanReasons?: string[];
  expectedValue?: number | string;
  edge?: number | string;
  ourProbability?: number | string;
  impliedProbability?: number | string;
  kellyFraction?: number | string;
  suggestedStakePercent?: number | string;
}

export interface RecommendedBetResult {
  selection?: string;
  selectionLabel?: string;
  status?: string;
  reason?: string;
}

export interface GoalProbabilitiesSummary {
  homeWin: number;
  draw: number;
  awayWin: number;
}

export interface AnalysisFactors {
  homeAdvantageIndex?: number | string;
  formDelta?: number | string;
  motivationDelta?: number | string;
  suspensionsDelta?: number | string;
  disciplinaryDelta?: number | string;
  atRiskPlayersDelta?: number | string;
  notes?: string[];
}

export interface ModelDistribution {
  expected: number;
  distribution: Record<string, number>;
}

export interface ShotsPredictionSide {
  totalShots: ModelDistribution;
  shotsOnTarget: ModelDistribution;
}

export interface ShotsPredictionCombined {
  totalShots: ModelDistribution;
  totalOnTarget: ModelDistribution;
  overUnder: Record<string, number>;
  onTargetOverUnder: Record<string, number>;
}

export interface ShotsPrediction {
  home: ShotsPredictionSide;
  away: ShotsPredictionSide;
  combined: ShotsPredictionCombined;
}

export interface MethodologyRuntimeSnapshot {
  lambdaHome?: number | string;
  lambdaAway?: number | string;
  totalShotsExpected?: number | string;
  totalYellowExpected?: number | string;
  totalFoulsExpected?: number | string;
}

export interface MethodologySnapshot {
  runtime?: MethodologyRuntimeSnapshot;
  contextualFactors?: AnalysisFactors;
}
