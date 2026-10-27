import { researchHash } from './ResearchStore';
import { COHERENT_PROBABILITY_PROTOCOL, CoherentCalibrationMode } from './CoherentProbabilityPipeline';
import type { ResearchCalibrationProfile } from './ResearchProbabilityPipeline';

/** Discrete post-processing settings, excluding the permitted chronological A refit. */
export function buildProbabilityConfiguration(input: {
  family: 'A' | 'C'; baselineVersion: string; pipelineHashV2: string;
  mode: CoherentCalibrationMode; temperature?: number; profile?: ResearchCalibrationProfile;
}) {
  if (!['A', 'C'].includes(input.family) || !input.baselineVersion?.trim()
    || !/^[a-f0-9]{64}$/i.test(input.pipelineHashV2)
    || !['identity', 'isotonic_1x2', 'temperature'].includes(input.mode)) throw new Error('Invalid probability configuration');
  if (input.mode === 'isotonic_1x2' && !input.profile) throw new Error('Calibration profile required');
  const temperature = input.mode === 'temperature' ? input.temperature : 1;
  if (!Number.isFinite(temperature) || temperature! <= 0) throw new Error('Valid probability temperature required');
  const calibrator = input.mode === 'isotonic_1x2' ? input.profile
    : { learnedBlendWeights: input.profile?.learnedBlendWeights ?? {} };
  const descriptor = { version: 'probability-configuration-v1', family: input.family,
    baselineVersion: input.baselineVersion, probabilityProtocol: COHERENT_PROBABILITY_PROTOCOL,
    pipelineHashV2: input.pipelineHashV2, mode: input.mode, temperature,
    calibratorHash: researchHash(calibrator) };
  return { descriptor, hash: researchHash(descriptor) };
}
