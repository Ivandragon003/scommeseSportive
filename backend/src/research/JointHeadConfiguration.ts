import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildProbabilityConfiguration } from './ProbabilityConfiguration';
import { researchHash } from './ResearchStore';

/** C-only identity, separate from the shared A probability configuration. */
export function jointHeadImplementationHash(): string {
  const hash = createHash('sha256').update('c-joint-head-probability-v1');
  for (const name of ['./JointHeadProbability', './CatBoostModel', './JointHeadConfiguration']) {
    hash.update(name).update(readFileSync(require.resolve(name), 'utf8').replace(/\r\n/g, '\n'));
  }
  return hash.digest('hex');
}

export function buildJointHeadProbabilityConfiguration(input: Parameters<typeof buildProbabilityConfiguration>[0], classifierHash: string) {
  if (input.family !== 'C' || !/^[a-f0-9]{64}$/i.test(classifierHash)) throw new Error('invalid_joint_head_configuration');
  const base = buildProbabilityConfiguration(input);
  const descriptor = { ...base.descriptor, version: 'c-joint-head-probability-configuration-v1',
    classifierHash, implementationHash: jointHeadImplementationHash(), weight: .75, temperature: .8,
    finalConditionalSpread: .8 };
  return { descriptor, hash: researchHash(descriptor) };
}
