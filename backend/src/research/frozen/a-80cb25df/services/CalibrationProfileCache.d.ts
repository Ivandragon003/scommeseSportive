import type { FamilyCalibrationCurve } from '../models/value/EnhancedMarketAnalysis';
export type CalibrationProfile = {
    calibrationPoints: Array<{
        x: number;
        y: number;
    }>;
    nObservations: number;
    byFamily: Record<string, FamilyCalibrationCurve>;
    learnedBlendWeights: Record<string, {
        modelWeight: number;
        sampleSize: number;
    }>;
};
export declare const calibrationPayloadHash: (payload: string) => string;
/** Callers provide the entire eligible input cohort and the evaluated model configuration. */
export declare function calibrationProfileFingerprint(inputs: unknown, configuration: unknown): string;
/** Cache damage is a miss, never permission to use a partial/default calibration. */
export declare function decodeCalibrationProfile(payload: string, checksum: string): CalibrationProfile | null;
