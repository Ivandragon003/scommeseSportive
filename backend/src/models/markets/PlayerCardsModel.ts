import { clamp, poissonPMF } from '../utils/MathUtils';
import { predictionEngineConfig } from '../../config/PredictionEngineConfig';

export type PlayerCardRole =
  | 'forward'
  | 'winger'
  | 'attacking_midfielder'
  | 'midfielder'
  | 'fullback'
  | 'centreback'
  | 'goalkeeper'
  | 'unknown';

export interface PlayerYellowCardsInput {
  playerId: string;
  playerName: string;
  role: PlayerCardRole;
  playerYellowCards: number;
  playerMinutes: number;
  expectedMinutes: number;
  playerFoulsCommittedPer90?: number;
  teamExpectedYellows: number;
  leagueAvgTeamYellows: number;
  refereeYellowAvg: number;
  leagueAvgRefereeYellow: number;
  refereeCoverage?: number;
  teamYellowInfluenceWeight?: number;
  minMinutesForStableCards?: number;
}

export interface PlayerYellowCardsPrediction {
  playerId: string;
  playerName: string;
  role: PlayerCardRole;
  expectedPlayerYellows: number;
  probabilityYellowOver0_5: number;
  fullDistribution: Record<number, number>;
  confidence: number;
  sampleSize: number;
  modelUsed: 'ZIP';
}

const ROLE_PRIOR_YELLOW_PER90: Record<PlayerCardRole, number> = {
  forward: 0.12,
  winger: 0.14,
  attacking_midfielder: 0.16,
  midfielder: 0.20,
  fullback: 0.22,
  centreback: 0.24,
  goalkeeper: 0.05,
  unknown: 0.16,
};

export class PlayerCardsModel {
  predictPlayerYellowCards(input: PlayerYellowCardsInput): PlayerYellowCardsPrediction {
    const stableMinutes = Math.max(
      1,
      input.minMinutesForStableCards ?? predictionEngineConfig.playerCards.minMinutesForStableCards
    );
    const playerMinutes = Math.max(0, Number(input.playerMinutes ?? 0));
    const rolePrior = ROLE_PRIOR_YELLOW_PER90[input.role] ?? ROLE_PRIOR_YELLOW_PER90.unknown;
    const rawRate = playerMinutes > 0
      ? (Math.max(0, input.playerYellowCards) / playerMinutes) * 90
      : rolePrior;
    const weight = clamp(playerMinutes / stableMinutes, 0, 1);
    let rateFinal = weight * rawRate + (1 - weight) * rolePrior;

    if (Number.isFinite(input.playerFoulsCommittedPer90) && input.playerFoulsCommittedPer90! > 0) {
      const foulMultiplier = clamp(1 + (input.playerFoulsCommittedPer90! - 1.3) * 0.08, 0.85, 1.25);
      rateFinal *= foulMultiplier;
    }

    const refRaw = input.leagueAvgRefereeYellow > 0
      ? input.refereeYellowAvg / input.leagueAvgRefereeYellow
      : 1;
    const refCoverage = Math.max(0, Number(input.refereeCoverage ?? 0));
    const refDamping = refCoverage / (refCoverage + 15);
    const refereeMultiplier = clamp(1 + (refRaw - 1) * refDamping, 0.75, 1.45);

    const teamInfluenceWeight = input.teamYellowInfluenceWeight ?? predictionEngineConfig.playerCards.teamYellowInfluenceWeight;
    const teamDisciplineEnvironmentMultiplier = clamp(
      1 + teamInfluenceWeight * ((input.teamExpectedYellows / Math.max(0.1, input.leagueAvgTeamYellows)) - 1),
      0.80,
      1.25,
    );

    const minutesFactor = clamp(input.expectedMinutes / 90, 0, 1.1);
    const lambda = Math.max(
      0.001,
      rateFinal * minutesFactor * refereeMultiplier * teamDisciplineEnvironmentMultiplier
    );

    const zeroInflation = clamp(0.08 + (1 - minutesFactor) * 0.30, 0.02, 0.70);
    const p0 = zeroInflation + (1 - zeroInflation) * poissonPMF(0, lambda);
    const p1 = (1 - zeroInflation) * poissonPMF(1, lambda);
    const p2Plus = Math.max(0, 1 - p0 - p1);
    const total = p0 + p1 + p2Plus;
    const fullDistribution: Record<number, number> = {
      0: Number((p0 / total).toFixed(6)),
      1: Number((p1 / total).toFixed(6)),
      2: Number((p2Plus / total).toFixed(6)),
    };

    const confidence = clamp(0.20 + weight * 0.55 + Math.min(0.20, refCoverage / 100), 0.20, 0.95);
    return {
      playerId: input.playerId,
      playerName: input.playerName,
      role: input.role,
      expectedPlayerYellows: Number(lambda.toFixed(4)),
      probabilityYellowOver0_5: Number((1 - fullDistribution[0]).toFixed(6)),
      fullDistribution,
      confidence: Number(confidence.toFixed(4)),
      sampleSize: playerMinutes,
      modelUsed: 'ZIP',
    };
  }
}
