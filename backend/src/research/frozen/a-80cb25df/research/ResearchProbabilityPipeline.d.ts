import { ValueAnalysisContext } from '../models/value/ValueBettingEngine';
import { CalibrationProfile } from '../services/CalibrationProfileCache';
import { MarketQuote } from './GoalSettlement';
export interface CalibrationObservation {
    matchId: string;
    availableAt: string;
    probabilities: Record<string, number>;
    outcomes: Record<string, 0 | 1 | null>;
}
export interface ResearchCalibrationProfile extends CalibrationProfile {
    protocol: 'existing-isotonic-v1';
    fittedThrough: string | null;
    matches: number;
}
/** Known binary labels only. Pushes remain null rather than invented losses. */
export declare function goalCalibrationObservation(matchId: string, availableAt: string, probabilities: Record<string, number>, homeGoals: number, awayGoals: number): CalibrationObservation;
/** The same isotonic implementation and family thresholds used by PredictionService. */
export declare function fitResearchCalibration(observations: CalibrationObservation[], asOf: string): ResearchCalibrationProfile;
/** Preserve the existing A raw probabilities separately from calibrated decision probabilities. */
export declare function applyResearchProbabilityPipeline(raw: Record<string, number>, profile: ResearchCalibrationProfile, quotes: MarketQuote[], forecastAt: string, context?: ValueAnalysisContext): {
    raw: Record<string, number>;
    calibrated: Record<string, number>;
    decision: Record<string, number>;
};
