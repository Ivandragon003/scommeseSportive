import { ValueAnalysisContext } from '../models/value/ValueBettingEngine';
import { MarketQuote } from './GoalSettlement';
import { CalibrationObservation, ResearchCalibrationProfile } from './ResearchProbabilityPipeline';
export declare const COHERENT_PROBABILITY_PROTOCOL = "joint-goal-coherent-v2";
export declare const COHERENT_CALIBRATION_TARGET = "joint_1x2_normalized-v2";
export type CoherentCalibrationMode = 'identity' | 'isotonic_1x2' | 'temperature';
export type CoherentCalibrationProfile = ResearchCalibrationProfile & {
    targetProtocol: typeof COHERENT_CALIBRATION_TARGET;
};
type ResultKey = 'homeWin' | 'draw' | 'awayWin';
export interface CoherentPipelineInput {
    matrix: number[][];
    /** Preserved evidence only; the supplied joint distribution defines coherent marginals. */
    rawProbabilities?: Record<string, number>;
    profile?: ResearchCalibrationProfile;
    quotes: MarketQuote[];
    forecastAt: string;
    mode?: CoherentCalibrationMode;
    temperature?: number;
    context?: ValueAnalysisContext;
}
export interface CoherentBookmakerEvidence {
    bookmaker: string;
    source: string;
    capturedAt: string;
    updatedAt: string | null;
    timestampEvidence: 'provider_update' | 'observed_snapshot';
    odds: Record<ResultKey, number>;
    probabilities: Record<ResultKey, number>;
}
export interface CoherentPipelineResult {
    protocol: typeof COHERENT_PROBABILITY_PROTOCOL;
    mode: CoherentCalibrationMode;
    profileTarget: string | null;
    matrix: number[][];
    raw: Record<string, number>;
    calibrated: Record<string, number>;
    decision: Record<string, number>;
    bookmaker: CoherentBookmakerEvidence | null;
    marketBlendingApplied: boolean;
    quoteExclusions: Record<string, number>;
}
/** Fit only a normalized, mutually exclusive 1X2 partition, never DC/DNB pseudo-labels. */
export declare function fitCoherentCalibration(observations: CalibrationObservation[], asOf: string): CoherentCalibrationProfile;
/** Every decision marginal is derived from the returned joint distribution. */
export declare function applyCoherentProbabilityPipeline(input: CoherentPipelineInput): CoherentPipelineResult;
/** Stable across line endings; a changed implementation cannot reuse an approved profile silently. */
export declare function coherentProbabilityPipelineHash(): string;
export {};
