import { poissonPMF, negBinPMF } from '../models/utils/MathUtils';

// Pure helpers for shaping the prediction API payload, extracted verbatim from
// api/routes.ts (no behavior change). poissonPMF/negBinPMF come from MathUtils
// (single source of truth). Regression coverage:
//   - test/prediction-payload-formatter.test.js (formatPrediction golden master)
//   - test/poisson-negbin-equivalence.test.js   (PMF equivalence)

export function roundN(v: number, n = 3): number {
  const x = Number(v);
  if (!isFinite(x)) return 0;
  return parseFloat(x.toFixed(n));
}

export function poissonOver(line: number, lambda: number): number {
  let cdf = 0;
  const maxK = Math.max(12, Math.ceil(lambda + 8 * Math.sqrt(Math.max(0.1, lambda))));
  for (let k = 0; k <= Math.floor(line) && k <= maxK; k++) cdf += poissonPMF(k, lambda);
  return Math.max(0, Math.min(1, 1 - cdf));
}

export function poissonDistribution(lambda: number, maxK: number): Record<number, number> {
  const out: Record<number, number> = {};
  let sum = 0;
  for (let k = 0; k <= maxK; k++) {
    const p = poissonPMF(k, lambda);
    out[k] = p;
    sum += p;
  }
  if (sum <= 0) return { 0: 1 };
  for (let k = 0; k <= maxK; k++) out[k] = out[k] / sum;
  return out;
}

export function negBinDistribution(mu: number, r: number, maxK: number): Record<number, number> {
  const out: Record<number, number> = {};
  let sum = 0;
  for (let k = 0; k <= maxK; k++) {
    const p = negBinPMF(k, mu, r);
    out[k] = p;
    sum += p;
  }
  if (sum <= 0) return { 0: 1 };
  for (let k = 0; k <= maxK; k++) out[k] = out[k] / sum;
  return out;
}

export function overFromDist(dist: Record<number, number>, line: number): number {
  let over = 0;
  for (const [k, v] of Object.entries(dist)) {
    if (Number(k) > line) over += Number(v);
  }
  return Math.max(0, Math.min(1, over));
}

export function lineToKey(prefix: string, line: string): string {
  return `${prefix}${line.replace('.', '')}`;
}

export function mapOverUnder(ou: Record<string, { over: number; under: number }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [line, v] of Object.entries(ou ?? {})) {
    out[lineToKey('over', line)] = roundN(v.over, 4);
    out[lineToKey('under', line)] = roundN(v.under, 4);
  }
  return out;
}

export function formatPrediction(pred: any): any {
  const probs: any = pred.probabilities ?? {};
  const cards = probs.cards ?? {};
  const fouls = probs.fouls ?? {};
  const corners = probs.corners ?? {};
  const homeShotsModel = probs.shotsHome ?? {};
  const awayShotsModel = probs.shotsAway ?? {};
  const homeShotTotals = homeShotsModel.totalShots ?? {};
  const awayShotTotals = awayShotsModel.totalShots ?? {};
  const homeShotTarget = homeShotsModel.shotsOnTarget ?? probs.shotsOnTargetHome ?? {};
  const awayShotTarget = awayShotsModel.shotsOnTarget ?? probs.shotsOnTargetAway ?? {};

  const lambdaHome = Number(probs.lambdaHome ?? 0);
  const lambdaAway = Number(probs.lambdaAway ?? 0);

  const homeShotsExp = Number(homeShotsModel.expected ?? homeShotTotals.expected ?? 0);
  const awayShotsExp = Number(awayShotsModel.expected ?? awayShotTotals.expected ?? 0);
  const homeSOTExp = Number(homeShotTarget.expected ?? 0);
  const awaySOTExp = Number(awayShotTarget.expected ?? 0);

  const cardsR = Math.max(1, Number(cards.negBinParams?.r ?? 12));
  const foulsR = Math.max(1, Number(fouls.negBinParams?.r ?? 13));

  const totalYellowExp = Number(cards.expectedTotalYellow ?? 0);
  const homeYellowExp = Number(cards.expectedHomeYellow ?? 0);
  const awayYellowExp = Number(cards.expectedAwayYellow ?? 0);
  const redExp = Number(cards.expectedHomeRed ?? 0) + Number(cards.expectedAwayRed ?? 0);

  const totalFoulsExp = Number(fouls.expectedTotalFouls ?? 0);
  const homeFoulsExp = Number(fouls.expectedHomeFouls ?? 0);
  const awayFoulsExp = Number(fouls.expectedAwayFouls ?? 0);

  const yellowDist = negBinDistribution(totalYellowExp, cardsR, 14);
  const foulsDist = negBinDistribution(totalFoulsExp, foulsR, 50);
  const redDist = poissonDistribution(redExp, 4);

  const shotsHomeDist = Object.keys(homeShotTotals.distribution ?? {}).length > 0
    ? homeShotTotals.distribution
    : poissonDistribution(homeShotsExp, 25);
  const shotsAwayDist = Object.keys(awayShotTotals.distribution ?? {}).length > 0
    ? awayShotTotals.distribution
    : poissonDistribution(awayShotsExp, 25);
  const shotsHomeSOTDist = Object.keys(homeShotTarget.distribution ?? {}).length > 0
    ? homeShotTarget.distribution
    : poissonDistribution(homeSOTExp, 15);
  const shotsAwaySOTDist = Object.keys(awayShotTarget.distribution ?? {}).length > 0
    ? awayShotTarget.distribution
    : poissonDistribution(awaySOTExp, 15);

  const combinedShotsExp = homeShotsExp + awayShotsExp;
  const combinedSOTExp = homeSOTExp + awaySOTExp;
  const totalCornersExp = Number(corners.expectedTotalCorners ?? 0);

  const overUnderYellow = mapOverUnder(cards.overUnderYellow ?? {});
  const overUnderFouls = mapOverUnder(fouls.overUnder ?? {});
  const overUnderShots = mapOverUnder(probs.shotsTotal ?? {});
  const overUnderCorners = mapOverUnder(corners.overUnder ?? {});

  const asPlayer = (p: any, side: string, idx: number) => {
    const expShots = Number(p.expectedShots ?? 0);
    const expSOT = Number(p.expectedShotsOnTarget ?? 0);
    return {
      playerId: p.playerId ?? `${side}_${idx}`,
      playerName: p.playerName ?? p.name ?? `Player ${idx + 1}`,
      teamId: p.teamId ?? side,
      position: p.positionCode ?? p.position ?? 'UNK',
      expectedShots: roundN(expShots, 3),
      expectedOnTarget: roundN(expSOT, 3),
      shotDistribution: poissonDistribution(expShots, 8),
      onTargetDistribution: poissonDistribution(expSOT, 6),
      markets: {
        over05shots: roundN(Number(p.prob1PlusShots ?? 0), 4),
        over15shots: roundN(Number(p.prob2PlusShots ?? 0), 4),
        over25shots: roundN(Number(p.prob3PlusShots ?? 0), 4),
        over35shots: roundN(poissonOver(3.5, expShots), 4),
        over05onTarget: roundN(Number(p.prob1PlusShotsOT ?? 0), 4),
        over15onTarget: roundN(poissonOver(1.5, expSOT), 4),
        over25onTarget: roundN(poissonOver(2.5, expSOT), 4),
        zeroShots: roundN(Math.max(0, 1 - Number(p.prob1PlusShots ?? 0)), 4),
      },
      confidenceLevel: roundN(Number(pred.modelConfidence ?? 0.75), 3),
      sampleSize: Number(p.sampleSize ?? 0),
    };
  };

  const playerShotsPredictions = [
    ...(probs.playerShots?.home ?? []).map((p: any, i: number) => asPlayer(p, 'home', i)),
    ...(probs.playerShots?.away ?? []).map((p: any, i: number) => asPlayer(p, 'away', i)),
  ];

  const valueOpportunities = (pred.valueOpportunities ?? [])
    .filter((o: any) => isFinite(Number(o.bookmakerOdds)) && isFinite(Number(o.ourProbability)))
    .map((o: any) => ({
      ...o,
      ourProbability: roundN(Number(o.ourProbability), 2),
      impliedProbability: roundN(Number(o.impliedProbability), 2),
      expectedValue: roundN(Number(o.expectedValue), 2),
      edge: roundN(Number(o.edge), 2),
      kellyFraction: roundN(Number(o.kellyFraction), 2),
      suggestedStakePercent: roundN(Number(o.suggestedStakePercent), 2),
    }));

  const speculativeOpportunities = (pred.speculativeOpportunities ?? [])
    .filter((o: any) => isFinite(Number(o.bookmakerOdds)) && isFinite(Number(o.ourProbability)))
    .map((o: any) => ({
      ...o,
      ourProbability: roundN(Number(o.ourProbability), 2),
      impliedProbability: roundN(Number(o.impliedProbability), 2),
      expectedValue: roundN(Number(o.expectedValue), 2),
      edge: roundN(Number(o.edge), 2),
      kellyFraction: roundN(Number(o.kellyFraction), 2),
      suggestedStakePercent: roundN(Number(o.suggestedStakePercent), 2),
    }));

  const comboBets = (pred.comboBets ?? [])
    .filter((c: any) => Array.isArray(c?.legs) && c.legs.length >= 2)
    .map((c: any) => ({
      ...c,
      combinedOdds: roundN(Number(c.combinedOdds), 2),
      combinedProbability: roundN(Number(c.combinedProbability), 3),
      combinedEV: roundN(Number(c.combinedEV), 2),
      kellyFraction: roundN(Number(c.kellyFraction), 3),
      suggestedStakePercent: roundN(Number(c.suggestedStakePercent), 2),
      legs: (c.legs ?? []).map((leg: any) => ({
        ...leg,
        ourProbability: roundN(Number(leg.ourProbability), 2),
        impliedProbability: roundN(Number(leg.impliedProbability), 2),
        expectedValue: roundN(Number(leg.expectedValue), 2),
        kellyFraction: roundN(Number(leg.kellyFraction), 2),
        suggestedStakePercent: roundN(Number(leg.suggestedStakePercent), 2),
      })),
    }));

  const bestValueOpportunity = pred.bestValueOpportunity
    ? {
      ...pred.bestValueOpportunity,
      expectedValue: roundN(Number(pred.bestValueOpportunity.expectedValue ?? 0), 2),
      edge: roundN(Number(pred.bestValueOpportunity.edge ?? 0), 2),
      edgeNoVig: roundN(Number(pred.bestValueOpportunity.edgeNoVig ?? pred.bestValueOpportunity.edge ?? 0), 2),
      score: roundN(Number(pred.bestValueOpportunity.score ?? 0), 3),
      riskAdjustedBestScore: roundN(Number(pred.bestValueOpportunity.riskAdjustedBestScore ?? pred.riskAdjustedBestScore ?? 0), 3),
      bestBetStatus: pred.bestBetStatus ?? pred.bestValueOpportunity.bestBetStatus ?? null,
      bestBetReason: pred.bestBetReason ?? pred.bestValueOpportunity.bestBetReason ?? null,
      bestBetDecision: pred.bestBetDecision ?? pred.bestValueOpportunity.bestBetDecision ?? null,
      bestBetAlternatives: pred.bestBetAlternatives ?? pred.bestValueOpportunity.bestBetAlternatives ?? [],
      factorBreakdown: {
        baseModelScore: roundN(Number(pred.bestValueOpportunity.factorBreakdown?.baseModelScore ?? 0), 3),
        contextualScore: roundN(Number(pred.bestValueOpportunity.factorBreakdown?.contextualScore ?? 0), 3),
        totalScore: roundN(Number(pred.bestValueOpportunity.factorBreakdown?.totalScore ?? 0), 3),
      },
      reasons: Array.isArray(pred.bestValueOpportunity.reasons) ? pred.bestValueOpportunity.reasons : [],
    }
    : null;

  return {
    matchId: pred.matchId,
    competition: pred.competition ?? null,
    homeTeam: pred.homeTeam,
    awayTeam: pred.awayTeam,
    lambdaHome: roundN(lambdaHome, 3),
    lambdaAway: roundN(lambdaAway, 3),
    modelConfidence: Number(pred.modelConfidence ?? 0),
    richnessScore: Number(pred.richnessScore ?? pred.modelConfidence ?? 0),
    computedAt: pred.computedAt,

    goalProbabilities: {
      homeWin: Number(probs.homeWin ?? 0),
      draw: Number(probs.draw ?? 0),
      awayWin: Number(probs.awayWin ?? 0),
      btts: Number(probs.btts ?? 0),
      over05: Number(probs.over05 ?? 0),
      over15: Number(probs.over15 ?? 0),
      over25: Number(probs.over25 ?? 0),
      over35: Number(probs.over35 ?? 0),
      over45: Number(probs.over45 ?? 0),
      under15: Number(probs.under15 ?? 0),
      under25: Number(probs.under25 ?? 0),
      under35: Number(probs.under35 ?? 0),
      under45: Number(probs.under45 ?? 0),
      exactScore: probs.exactScore ?? {},
      handicap: probs.handicap ?? {},
      asianHandicap: probs.asianHandicap ?? {},
    },

    cardsPrediction: {
      totalYellow: {
        expected: roundN(totalYellowExp, 3),
        variance: roundN(totalYellowExp + (totalYellowExp * totalYellowExp) / cardsR, 3),
        distribution: yellowDist,
      },
      totalRed: {
        expected: roundN(redExp, 3),
        probAtLeastOne: roundN(1 - Math.exp(-redExp), 4),
        distribution: redDist,
      },
      overUnder: overUnderYellow,
      homeYellow: {
        expected: roundN(homeYellowExp, 3),
        over15: roundN(overFromDist(negBinDistribution(homeYellowExp, cardsR, 10), 1.5), 4),
        over25: roundN(overFromDist(negBinDistribution(homeYellowExp, cardsR, 10), 2.5), 4),
        over35: roundN(overFromDist(negBinDistribution(homeYellowExp, cardsR, 10), 3.5), 4),
      },
      awayYellow: {
        expected: roundN(awayYellowExp, 3),
        over15: roundN(overFromDist(negBinDistribution(awayYellowExp, cardsR, 10), 1.5), 4),
        over25: roundN(overFromDist(negBinDistribution(awayYellowExp, cardsR, 10), 2.5), 4),
        over35: roundN(overFromDist(negBinDistribution(awayYellowExp, cardsR, 10), 3.5), 4),
      },
      totalCardsWeighted: {
        expected: roundN(Number(cards.expectedTotalCards ?? 0), 3),
        over35: roundN(cards.overUnderTotal?.['3.5']?.over ?? 0, 4),
        over45: roundN(cards.overUnderTotal?.['4.5']?.over ?? 0, 4),
        over55: roundN(cards.overUnderTotal?.['5.5']?.over ?? 0, 4),
        over65: roundN(cards.overUnderTotal?.['6.5']?.over ?? 0, 4),
      },
      confidenceLevel: roundN(Number(pred.modelConfidence ?? 0.75), 3),
    },

    foulsPrediction: {
      totalFouls: {
        expected: roundN(totalFoulsExp, 3),
        variance: roundN(totalFoulsExp + (totalFoulsExp * totalFoulsExp) / foulsR, 3),
        distribution: foulsDist,
      },
      overUnder: overUnderFouls,
      homeFouls: { expected: roundN(homeFoulsExp, 3) },
      awayFouls: { expected: roundN(awayFoulsExp, 3) },
    },

    shotsPrediction: {
      home: {
        totalShots: {
          expected: roundN(homeShotsExp, 2),
          variance: roundN(Number(homeShotTotals.variance ?? 0), 2),
          distribution: shotsHomeDist,
        },
        shotsOnTarget: {
          expected: roundN(homeSOTExp, 2),
          variance: roundN(Number(homeShotTarget.variance ?? 0), 2),
          distribution: shotsHomeSOTDist,
        },
      },
      away: {
        totalShots: {
          expected: roundN(awayShotsExp, 2),
          variance: roundN(Number(awayShotTotals.variance ?? 0), 2),
          distribution: shotsAwayDist,
        },
        shotsOnTarget: {
          expected: roundN(awaySOTExp, 2),
          variance: roundN(Number(awayShotTarget.variance ?? 0), 2),
          distribution: shotsAwaySOTDist,
        },
      },
      combined: {
        totalShots: {
          expected: roundN(combinedShotsExp, 2),
          variance: roundN(Number(probs.shotsHome?.totalShots?.variance ?? 0) + Number(probs.shotsAway?.totalShots?.variance ?? 0), 2),
        },
        overUnder: overUnderShots,
        totalOnTarget: {
          expected: roundN(combinedSOTExp, 2),
          variance: roundN(Number(homeShotTarget.variance ?? 0) + Number(awayShotTarget.variance ?? 0), 2),
        },
        onTargetOverUnder: {
          over75: roundN(poissonOver(7.5, combinedSOTExp), 4),
          over95: roundN(poissonOver(9.5, combinedSOTExp), 4),
          over115: roundN(poissonOver(11.5, combinedSOTExp), 4),
          under75: roundN(1 - poissonOver(7.5, combinedSOTExp), 4),
          under95: roundN(1 - poissonOver(9.5, combinedSOTExp), 4),
          under115: roundN(1 - poissonOver(11.5, combinedSOTExp), 4),
        },
      },
    },

    cornersPrediction: {
      totalCorners: {
        expected: roundN(totalCornersExp, 3),
      },
      homeCorners: { expected: roundN(Number(corners.expectedHomeCorners ?? 0), 3) },
      awayCorners: { expected: roundN(Number(corners.expectedAwayCorners ?? 0), 3) },
      overUnder: overUnderCorners,
    },

    playerShotsPredictions,
    valueOpportunities,
    comboBets,
    speculativeOpportunities,
    bestValueOpportunity,
    bestBetDecision: pred.bestBetDecision ?? bestValueOpportunity?.bestBetDecision ?? null,
    bestBetAlternatives: pred.bestBetAlternatives ?? bestValueOpportunity?.bestBetAlternatives ?? [],
    bestBetStatus: pred.bestBetStatus ?? bestValueOpportunity?.bestBetStatus ?? (bestValueOpportunity ? 'PLAYABLE' : 'NO_MARKET'),
    bestBetReason: pred.bestBetReason ?? bestValueOpportunity?.bestBetReason ?? null,
    riskAdjustedBestScore: roundN(Number(pred.riskAdjustedBestScore ?? bestValueOpportunity?.riskAdjustedBestScore ?? 0), 3),
    playerPropWarnings: pred.playerPropWarnings ?? [],
    analysisFactors: pred.analysisFactors ?? null,

    probabilities: probs,
    methodology: {
      models: {
        goals: 'Dixon-Coles (Poisson bivariata con correzione rho)',
        shots: 'Binomiale Negativa',
        cards: 'Binomiale Negativa + fattore arbitro',
        fouls: 'Binomiale Negativa + correzione possesso',
        players: 'Gerarchico (quota giocatore su tiri squadra)',
        valueBetting: 'Expected Value + Kelly frazionale',
      },
      formulas: {
        impliedProbability: 'p_imp = 1 / quota_decimale',
        expectedValue: 'EV = p_nostra * quota_decimale - 1',
        edge: 'edge = p_nostra - p_imp',
        kelly: 'f* = (b*p - q)/b, stake = 0.25 * f* (limiti min/max)',
      },
      thresholds: {
        minEvPercent: 2,
        minOdds: 1.3,
        maxOdds: 15,
        maxStakePercent: 5,
      },
      runtime: {
        lambdaHome: roundN(lambdaHome, 3),
        lambdaAway: roundN(lambdaAway, 3),
        totalShotsExpected: roundN(combinedShotsExp, 2),
        totalOnTargetExpected: roundN(combinedSOTExp, 2),
        totalYellowExpected: roundN(totalYellowExp, 2),
        totalFoulsExpected: roundN(totalFoulsExp, 2),
        cardsDispersionR: roundN(cardsR, 2),
        foulsDispersionR: roundN(foulsR, 2),
      },
      contextualFactors: pred.analysisFactors ?? null,
    },
  };
}
