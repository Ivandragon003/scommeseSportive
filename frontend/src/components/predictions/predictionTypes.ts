export type ReplayTone = 'info' | 'success' | 'warning' | 'danger';

export interface OddsSourceBadgeInfo {
  label: string;
  className: string;
}

export interface BestValueOpportunity {
  selection: string;
  marketName: string;
  marketCategory?: string;
  selectionLabel?: string;
  bookmakerOdds?: number | string;
  confidence?: string;
  marketTier?: string;
  humanSummary?: string;
  humanReasons?: string[];
  expectedValue?: number | string;
  edge?: number | string;
  ourProbability?: number | string;
  modelProbability?: number | string;
  calibratedProbability?: number | string;
  blendedProbability?: number | string;
  impliedProbability?: number | string;
  marketProbabilityNoVig?: number | string;
  modelWeight?: number | string;
  marketWeight?: number | string;
  kellyFraction?: number | string;
  suggestedStakePercent?: number | string;
  edgeNoVig?: number | string;
  mainReason?: string;
  riskReasons?: string[];
  dataQuality?: number | string;
  rankingScore?: number | string;
  companionOddsAvailable?: boolean;
  categoryCalibrationStatus?: 'none' | 'applied' | 'global_fallback' | 'insufficient_sample' | string;
  calibrationSampleSize?: number | string;
  calibrationReliability?: number | string;
  playerId?: string;
  playerName?: string;
  teamName?: string;
  marketType?: 'player_shots' | 'player_shots_ot' | 'player_yellow_cards' | string;
  line?: number | string;
  expectedMinutes?: number | string;
  sampleSize?: number | string;
  playerConfidence?: string;
  dataWarnings?: string[];
  slateStatus?: 'recommended' | 'skipped' | 'not_evaluated' | string;
  slateSkipReason?: string;
  slateDiagnostics?: {
    reasonCode?: string;
    categoryCap?: number;
    categoryCount?: number;
    slateRank?: number;
    slatePosition?: number;
  };
  matchId?: string;
  homeTeam?: string;
  awayTeam?: string;
  match?: string;
  competition?: string;
  commenceTime?: string | null;
}

export interface DailySlateSkippedMatch {
  matchId?: string;
  homeTeam?: string;
  awayTeam?: string;
  match?: string;
  competition?: string;
  commenceTime?: string | null;
  reason?: string;
  message?: string;
}

export interface DailySlateResponse {
  competition: string;
  date: string;
  generatedAt: string;
  recommended: BestValueOpportunity[];
  skipped: BestValueOpportunity[];
  diagnostics: Record<string, any>;
  matchesAnalyzed: number;
  matchesSkipped: DailySlateSkippedMatch[];
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
