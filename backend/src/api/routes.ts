import { Router, Request, Response } from 'express';
import { PredictionService } from '../services/PredictionService';
import { DatabaseService } from '../db/DatabaseService';

const router = Router();
const db = new DatabaseService();
const svc = new PredictionService(db);

// ====== TEAMS ======
router.get('/teams', async (req: Request, res: Response) => {
  try { res.json({ success: true, data: await db.getTeams(req.query.competition as string) }); }
  catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/teams', async (req: Request, res: Response) => {
  try { await db.upsertTeam(req.body); res.json({ success: true }); }
  catch (e: any) { res.status(400).json({ success: false, error: e.message }); }
});

// ====== PLAYERS ======
router.get('/players/:teamId', async (req: Request, res: Response) => {
  try { res.json({ success: true, data: await db.getPlayersByTeam(req.params.teamId) }); }
  catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/players', async (req: Request, res: Response) => {
  try { await db.upsertPlayer(req.body); res.json({ success: true }); }
  catch (e: any) { res.status(400).json({ success: false, error: e.message }); }
});

router.post('/players/bulk', async (req: Request, res: Response) => {
  try {
    const { players } = req.body;
    if (!Array.isArray(players)) return res.status(400).json({ success: false, error: 'Array richiesto' });
    let ok = 0;
    for (const p of players) { try { await db.upsertPlayer(p); ok++; } catch {} }
    return res.json({ success: true, imported: ok });
  } catch (e: any) { return res.status(500).json({ success: false, error: e.message }); }
});

// ====== MATCHES ======
router.get('/matches', async (req: Request, res: Response) => {
  try {
    const matches = await db.getMatches({
      competition: req.query.competition as string,
      season: req.query.season as string,
      fromDate: req.query.fromDate as string,
      toDate: req.query.toDate as string,
    });
    res.json({ success: true, data: matches, count: matches.length });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

router.get('/matches/count', async (req: Request, res: Response) => {
  try {
    const count = await db.countMatches({
      competition: req.query.competition as string,
      season: req.query.season as string,
      fromDate: req.query.fromDate as string,
      toDate: req.query.toDate as string,
    });
    res.json({ success: true, count });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

router.get('/matches/matchdays', async (req: Request, res: Response) => {
  try {
    const competition = String(req.query.competition ?? 'Serie A');
    const season = req.query.season ? String(req.query.season) : undefined;
    const matchesPerMatchdayRaw = parseInt(String(req.query.matchesPerMatchday ?? 10), 10);
    const matchesPerMatchday = Number.isFinite(matchesPerMatchdayRaw)
      ? Math.max(1, Math.min(matchesPerMatchdayRaw, 30))
      : 10;

    const rows = await db.getMatchdayRows({ competition, season });
    const matchdayMap: Record<string, number> = {};

    rows.forEach((row: any, idx: number) => {
      const matchId = String(row?.match_id ?? '').trim();
      if (!matchId) return;
      matchdayMap[matchId] = Math.floor(idx / matchesPerMatchday) + 1;
    });

    res.json({ success: true, data: matchdayMap, count: Object.keys(matchdayMap).length });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

router.get('/matches/upcoming', async (req: Request, res: Response) => {
  try {
    const limit = req.query.limit ? parseInt(String(req.query.limit), 10) : undefined;
    const matches = await db.getUpcomingMatches({
      competition: req.query.competition as string | undefined,
      season: req.query.season as string | undefined,
      limit: Number.isFinite(limit) ? limit : undefined,
    });
    res.json({ success: true, data: matches, count: matches.length });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/matches', async (req: Request, res: Response) => {
  try { await db.upsertMatch({ ...req.body, date: new Date(req.body.date) }); res.json({ success: true }); }
  catch (e: any) { res.status(400).json({ success: false, error: e.message }); }
});

router.post('/matches/bulk', async (req: Request, res: Response) => {
  try {
    const { matches } = req.body;
    if (!Array.isArray(matches)) return res.status(400).json({ success: false, error: 'Array richiesto' });
    let imported = 0;
    let errors = 0;
    for (const m of matches) {
      try {
        const normalized = {
          matchId:          m.matchId ?? m.match_id ?? m.id ?? `auto_${Date.now()}_${Math.random()}`,
          homeTeamId:       m.homeTeamId ?? m.home_team_id ?? m.HomeTeam ?? m.home_team,
          awayTeamId:       m.awayTeamId ?? m.away_team_id ?? m.AwayTeam ?? m.away_team,
          homeTeamName:     m.homeTeamName ?? m.home_team_name ?? m.HomeTeam ?? undefined,
          awayTeamName:     m.awayTeamName ?? m.away_team_name ?? m.AwayTeam ?? undefined,
          date:             new Date(m.date ?? m.Date ?? m.datetime),
          homeGoals:        m.homeGoals ?? m.home_goals ?? m.FTHG ?? m.score?.home,
          awayGoals:        m.awayGoals ?? m.away_goals ?? m.FTAG ?? m.score?.away,
          homeXG:           m.homeXG ?? m.home_xg ?? m.xg_home ?? m.xG_home,
          awayXG:           m.awayXG ?? m.away_xg ?? m.xg_away ?? m.xG_away,
          homeTotalShots:   m.homeTotalShots ?? m.home_shots ?? m.home_total_shots ?? m.HS,
          awayTotalShots:   m.awayTotalShots ?? m.away_shots ?? m.away_total_shots ?? m.AS,
          homeShotsOnTarget:m.homeShotsOnTarget ?? m.home_shots_on_target ?? m.HST,
          awayShotsOnTarget:m.awayShotsOnTarget ?? m.away_shots_on_target ?? m.AST,
          homePossession:   m.homePossession ?? m.home_possession ?? m.Poss_home,
          awayPossession:   m.awayPossession ?? m.away_possession ?? m.Poss_away,
          homeFouls:        m.homeFouls ?? m.home_fouls ?? m.HF,
          awayFouls:        m.awayFouls ?? m.away_fouls ?? m.AF,
          homeYellowCards:  m.homeYellowCards ?? m.home_yellow_cards ?? m.HY,
          awayYellowCards:  m.awayYellowCards ?? m.away_yellow_cards ?? m.AY,
          homeRedCards:     m.homeRedCards ?? m.home_red_cards ?? m.HR,
          awayRedCards:     m.awayRedCards ?? m.away_red_cards ?? m.AR,
          referee:          m.referee ?? m.Referee,
          competition:      m.competition ?? m.league ?? m.Division,
          season:           m.season ?? m.Season,
        };
        await db.upsertMatch(normalized);
        imported++;
      } catch (err) {
        errors++;
      }
    }
    return res.json({ success: true, imported, errors, total: matches.length });
  } catch (e: any) { return res.status(500).json({ success: false, error: e.message }); }
});

// ====== REFEREES ======
router.post('/referees', async (req: Request, res: Response) => {
  try { await db.upsertReferee(req.body); res.json({ success: true }); }
  catch (e: any) { res.status(400).json({ success: false, error: e.message }); }
});

router.get('/referees/:name', async (req: Request, res: Response) => {
  try { res.json({ success: true, data: await db.getRefereeByName(decodeURIComponent(req.params.name)) }); }
  catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

// ====== MODEL ======
router.post('/model/fit', async (req: Request, res: Response) => {
  try {
    const result = await svc.fitModelForCompetition(req.body.competition, req.body.season, req.body.fromDate, req.body.toDate);
    res.json({ success: true, data: result });
  } catch (e: any) { res.status(400).json({ success: false, error: e.message }); }
});

router.post('/model/recompute-averages', async (req: Request, res: Response) => {
  try {
    const { competition } = req.body;
    const teams = await db.getTeams(competition);
    let updated = 0;
    for (const t of teams) {
      await db.recomputeTeamAverages(t.team_id);
      updated++;
    }
    res.json({ success: true, teamsUpdated: updated });
  } catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

// ====== PREDICT ======
router.post('/predict', async (req: Request, res: Response) => {
  try {
    const pred = await svc.predict(req.body);
    res.json({ success: true, data: formatPrediction(pred) });
  } catch (e: any) { res.status(400).json({ success: false, error: e.message }); }
});

function roundN(v: number, n = 3): number {
  const x = Number(v);
  if (!isFinite(x)) return 0;
  return parseFloat(x.toFixed(n));
}

function poissonPMF(k: number, lambda: number): number {
  if (!isFinite(lambda) || lambda <= 0) return k === 0 ? 1 : 0;
  let p = Math.exp(-lambda);
  for (let i = 1; i <= k; i++) p *= lambda / i;
  return isFinite(p) ? p : 0;
}

function poissonOver(line: number, lambda: number): number {
  let cdf = 0;
  const maxK = Math.max(12, Math.ceil(lambda + 8 * Math.sqrt(Math.max(0.1, lambda))));
  for (let k = 0; k <= Math.floor(line) && k <= maxK; k++) cdf += poissonPMF(k, lambda);
  return Math.max(0, Math.min(1, 1 - cdf));
}

function poissonDistribution(lambda: number, maxK: number): Record<number, number> {
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

function negBinPMF(k: number, mu: number, r: number): number {
  if (!isFinite(mu) || !isFinite(r) || mu <= 0 || r <= 0) return k === 0 ? 1 : 0;
  const p = r / (r + mu);
  let combLog = 0;
  for (let i = 0; i < k; i++) combLog += Math.log(r + i) - Math.log(i + 1);
  const logP = combLog + r * Math.log(p) + k * Math.log(1 - p);
  const val = Math.exp(logP);
  return isFinite(val) ? val : 0;
}

function negBinDistribution(mu: number, r: number, maxK: number): Record<number, number> {
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

function overFromDist(dist: Record<number, number>, line: number): number {
  let over = 0;
  for (const [k, v] of Object.entries(dist)) {
    if (Number(k) > line) over += Number(v);
  }
  return Math.max(0, Math.min(1, over));
}

function lineToKey(prefix: string, line: string): string {
  return `${prefix}${line.replace('.', '')}`;
}

function mapOverUnder(ou: Record<string, { over: number; under: number }>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [line, v] of Object.entries(ou ?? {})) {
    out[lineToKey('over', line)] = roundN(v.over, 4);
    out[lineToKey('under', line)] = roundN(v.under, 4);
  }
  return out;
}

function formatPrediction(pred: any): any {
  const probs: any = pred.probabilities ?? {};
  const cards = probs.cards ?? {};
  const fouls = probs.fouls ?? {};

  const lambdaHome = Number(probs.lambdaHome ?? 0);
  const lambdaAway = Number(probs.lambdaAway ?? 0);

  const homeShotsExp = Number(probs.shotsHome?.expected ?? 0);
  const awayShotsExp = Number(probs.shotsAway?.expected ?? 0);
  const homeSOTExp = Number(probs.shotsOnTargetHome?.expected ?? 0);
  const awaySOTExp = Number(probs.shotsOnTargetAway?.expected ?? 0);

  const cardsR = Math.max(1, Number(cards.negBinParams?.r ?? 12));
  const foulsR = Math.max(1, Number(fouls.negBinParams?.r ?? 13));

  const totalYellowExp = Number(cards.expectedTotalYellow ?? 0);
  const homeYellowExp = Number(cards.expectedHomeYellow ?? 0);
  const awayYellowExp = Number(cards.expectedAwayYellow ?? 0);
  const redExp = Number(cards.expectedHomeCornered ?? 0) + Number(cards.expectedAwayRed ?? 0);

  const totalFoulsExp = Number(fouls.expectedTotalFouls ?? 0);
  const homeFoulsExp = Number(fouls.expectedHomeFouls ?? 0);
  const awayFoulsExp = Number(fouls.expectedAwayFouls ?? 0);

  const yellowDist = negBinDistribution(totalYellowExp, cardsR, 14);
  const foulsDist = negBinDistribution(totalFoulsExp, foulsR, 50);
  const redDist = poissonDistribution(redExp, 4);

  const shotsHomeDist = poissonDistribution(homeShotsExp, 25);
  const shotsAwayDist = poissonDistribution(awayShotsExp, 25);
  const shotsHomeSOTDist = poissonDistribution(homeSOTExp, 15);
  const shotsAwaySOTDist = poissonDistribution(awaySOTExp, 15);

  const combinedShotsExp = homeShotsExp + awayShotsExp;
  const combinedSOTExp = homeSOTExp + awaySOTExp;

  const overUnderYellow = mapOverUnder(cards.overUnderYellow ?? {});
  const overUnderFouls = mapOverUnder(fouls.overUnder ?? {});
  const overUnderShots = mapOverUnder(probs.shotsTotal ?? {});

  const asPlayer = (p: any, side: string, idx: number) => {
    const expShots = Number(p.expectedShots ?? 0);
    const expSOT = Number(p.expectedShotsOnTarget ?? 0);
    return {
      playerId: p.playerId ?? `${side}_${idx}`,
      playerName: p.playerName ?? p.name ?? `Player ${idx + 1}`,
      teamId: side,
      position: 'UNK',
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
      sampleSize: 20,
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

  const bestValueOpportunity = pred.bestValueOpportunity
    ? {
        ...pred.bestValueOpportunity,
        expectedValue: roundN(Number(pred.bestValueOpportunity.expectedValue ?? 0), 2),
        edge: roundN(Number(pred.bestValueOpportunity.edge ?? 0), 2),
        score: roundN(Number(pred.bestValueOpportunity.score ?? 0), 3),
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
    homeTeam: pred.homeTeam,
    awayTeam: pred.awayTeam,
    lambdaHome: roundN(lambdaHome, 3),
    lambdaAway: roundN(lambdaAway, 3),
    modelConfidence: Number(pred.modelConfidence ?? 0),
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
        totalShots: { expected: roundN(homeShotsExp, 2), distribution: shotsHomeDist },
        shotsOnTarget: { expected: roundN(homeSOTExp, 2), distribution: shotsHomeSOTDist },
      },
      away: {
        totalShots: { expected: roundN(awayShotsExp, 2), distribution: shotsAwayDist },
        shotsOnTarget: { expected: roundN(awaySOTExp, 2), distribution: shotsAwaySOTDist },
      },
      combined: {
        totalShots: { expected: roundN(combinedShotsExp, 2) },
        overUnder: overUnderShots,
        totalOnTarget: { expected: roundN(combinedSOTExp, 2) },
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

    playerShotsPredictions,
    valueOpportunities,
    bestValueOpportunity,
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
// ====== BUDGET & BETS ======
router.get('/budget/:userId', async (req: Request, res: Response) => {
  try { res.json({ success: true, data: await svc.getBudget(req.params.userId) }); }
  catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

router.post('/budget/:userId/init', async (req: Request, res: Response) => {
  try {
    const amount = parseFloat(req.body.amount);
    if (isNaN(amount) || amount <= 0) return res.status(400).json({ success: false, error: 'Importo non valido' });
    return res.json({ success: true, data: await svc.initBudget(req.params.userId, amount) });
  } catch (e: any) { return res.status(400).json({ success: false, error: e.message }); }
});

router.post('/bets/place', async (req: Request, res: Response) => {
  try {
    const { userId, matchId, marketName, selection, odds, stake, ourProbability, expectedValue } = req.body;
    const result = await svc.placeBet(userId, matchId, marketName, selection, odds, stake, ourProbability, expectedValue);
    res.json({ success: true, data: result });
  } catch (e: any) { res.status(400).json({ success: false, error: e.message }); }
});

router.post('/bets/:betId/settle', async (req: Request, res: Response) => {
  try {
    const result = await svc.settleBet(req.params.betId, req.body.won, req.body.returnAmount);
    res.json({ success: true, data: result });
  } catch (e: any) { res.status(400).json({ success: false, error: e.message }); }
});

router.get('/bets/:userId', async (req: Request, res: Response) => {
  try { res.json({ success: true, data: await db.getBets(req.params.userId, req.query.status as string) }); }
  catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

// ====== BACKTEST ======
router.post('/backtest', async (req: Request, res: Response) => {
  try {
    const result = await svc.runBacktest(req.body.competition, req.body.season, req.body.historicalOdds);
    res.json({ success: true, data: result });
  } catch (e: any) { res.status(400).json({ success: false, error: e.message }); }
});

router.get('/backtest/results', async (req: Request, res: Response) => {
  try { res.json({ success: true, data: await db.getBacktestResults(req.query.competition as string) }); }
  catch (e: any) { res.status(500).json({ success: false, error: e.message }); }
});

router.get('/backtest/results/:id', async (req: Request, res: Response) => {
  try {
    const r = await db.getBacktestResult(parseInt(req.params.id));
    if (!r) return res.status(404).json({ success: false, error: 'Non trovato' });
    return res.json({ success: true, data: r });
  } catch (e: any) { return res.status(500).json({ success: false, error: e.message }); }
});

router.get('/stats/overview', async (_req: Request, res: Response) => {
  try {
    const top5 = ['Serie A', 'Premier League', 'La Liga', 'Bundesliga', 'Ligue 1'];
    const [coverage, leagues, playersByLeague] = await Promise.all([
      db.getMatchesCoverageStats(),
      db.getLeagueSummaries(top5),
      db.getPlayerCoverageByLeague(top5),
    ]);

    const leaguesWithPlayers = leagues.map((league) => ({
      ...league,
      players: playersByLeague[league.competition] ?? { players: 0, teamsWithPlayers: 0, avgGamesPlayed: 0 },
    }));

    return res.json({
      success: true,
      data: {
        generatedAt: new Date().toISOString(),
        checks: {
          allCoreStatsLoaded:
            coverage.fields.xg.pct >= 60 &&
            coverage.fields.shots.pct >= 70 &&
            coverage.fields.shotsOnTarget.pct >= 70 &&
            coverage.fields.fouls.pct >= 60 &&
            coverage.fields.yellowCards.pct >= 60,
          recommendedThresholds: {
            xgPct: 60,
            shotsPct: 70,
            shotsOnTargetPct: 70,
            foulsPct: 60,
            yellowCardsPct: 60,
          },
        },
        coverage,
        leagues: leaguesWithPlayers,
      }
    });
  } catch (e: any) {
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/health', (_req, res) => res.json({ success: true, status: 'ok', version: '2.0' }));

// ====== FOTMOB SCRAPER (IMPORT INCREMENTALE) ======
import { FotmobScraper } from '../services/FotmobScraper';
const fotmob = new FotmobScraper();

async function runFotmobImport(req: Request, res: Response) {
  try {
    req.setTimeout(15 * 60 * 1000);
    res.setTimeout(15 * 60 * 1000);

    const {
      mode = 'single',
      competition = 'Serie A',
      competitions,
      seasons,
      yearsBack = 2,
      importPlayers = true,
      includeMatchDetails = true,
      forceRefresh = false,
    } = req.body ?? {};

    const competitionsToRun: string[] = mode === 'top5'
      ? FotmobScraper.getTop5Competitions()
      : Array.isArray(competitions) && competitions.length > 0
        ? competitions
        : [competition];

    const seasonsToScrape: string[] = Array.isArray(seasons) && seasons.length > 0
      ? seasons
      : FotmobScraper.generateSeasons(yearsBack);

    const hasMissingAdvancedStats = (matchRow: any): boolean => {
      if (!matchRow) return true;
      const fields = [
        'home_xg', 'away_xg',
        'home_shots', 'away_shots',
        'home_shots_on_target', 'away_shots_on_target',
        'home_possession', 'away_possession',
        'home_fouls', 'away_fouls',
        'home_yellow_cards', 'away_yellow_cards',
        'home_red_cards', 'away_red_cards',
      ];

      const values = fields.map(k => matchRow[k]);
      const hasNullish = values.some(v => v === null || v === undefined || v === '');
      const numericValues = values
        .map(v => (v === null || v === undefined || v === '' ? null : Number(v)))
        .filter((v): v is number => v !== null && Number.isFinite(v));
      const allZeroLike = numericValues.length > 0 && numericValues.every(v => Math.abs(v) < 1e-9);

      return hasNullish || allZeroLike;
    };

    let totalImported = 0;
    let totalUpdatedExisting = 0;
    let totalSkipped = 0;
    let totalNew = 0;
    let totalUpcomingImported = 0;
    let teamsCreated = 0;
    let playersUpdated = 0;
    const seasonSummary: Record<string, any> = {};

    for (const competitionName of competitionsToRun) {
      for (const season of seasonsToScrape) {
        const lastDateInDb = await db.getLastMatchDate(competitionName, season);
        const allMatches = await fotmob.scrapeSeason(competitionName, season, {
          includeDetails: Boolean(importPlayers) || includeMatchDetails !== false,
        });

        const matchesToImport: typeof allMatches = [];
        for (const m of allMatches) {
          const isPlayed = m.homeGoals !== null && m.awayGoals !== null;
          const existing = await db.getMatchById(m.matchId);
          if (forceRefresh) {
            matchesToImport.push(m);
            continue;
          }
          if (!existing) {
            matchesToImport.push(m);
            continue;
          }
          // Mantieni sempre in DB anche le partite future/non concluse.
          if (!isPlayed) {
            matchesToImport.push(m);
            continue;
          }
          if (includeMatchDetails !== false && hasMissingAdvancedStats(existing)) {
            matchesToImport.push(m);
            continue;
          }
          if (lastDateInDb && m.date.substring(0, 10) <= lastDateInDb) continue;
          matchesToImport.push(m);
        }

        const playersAgg = new Map<string, {
          playerId: string;
          sourcePlayerId: number | null;
          name: string;
          teamId: string;
          games: Set<string>;
          shots: number;
          shotsOnTarget: number;
          goals: number;
          xg: number;
          xgot: number;
          rawSamples: Record<string, unknown>[];
        }>();

        let imported = 0;
        let updatedExisting = 0;
        let importedPlayed = 0;
        let importedUpcoming = 0;
        let skipped = 0;

        for (const m of matchesToImport) {
          const isPlayed = m.homeGoals !== null && m.awayGoals !== null;
          for (const team of [
            { teamId: m.homeTeamId, name: m.homeTeamName },
            { teamId: m.awayTeamId, name: m.awayTeamName },
          ]) {
            const existingTeam = await db.getTeam(team.teamId);
            if (!existingTeam) {
              await db.upsertTeam({
                teamId: team.teamId,
                name: team.name,
                competition: competitionName,
                sourceTeamId: null,
                teamStatsJson: JSON.stringify({ source: 'fotmob', competition: competitionName, season }),
              });
              teamsCreated++;
            }
          }

          try {
            const existedBefore = Boolean(await db.getMatchById(m.matchId));
            await db.upsertMatch(fotmob.toDbFormat(m));
            if (existedBefore) {
              updatedExisting++;
            } else {
              imported++;
              if (isPlayed) importedPlayed++;
              else importedUpcoming++;
            }

            if (importPlayers && isPlayed) {
              for (const p of m.playerStats) {
                const agg = playersAgg.get(p.playerId) ?? {
                  playerId: p.playerId,
                  sourcePlayerId: p.sourcePlayerId,
                  name: p.playerName,
                  teamId: p.teamId,
                  games: new Set<string>(),
                  shots: 0,
                  shotsOnTarget: 0,
                  goals: 0,
                  xg: 0,
                  xgot: 0,
                  rawSamples: [],
                };
                agg.games.add(m.matchId);
                agg.shots += p.shots;
                agg.shotsOnTarget += p.shotsOnTarget;
                agg.goals += p.goals;
                agg.xg += p.xg;
                agg.xgot += p.xgot;
                agg.rawSamples.push(p.raw);
                playersAgg.set(p.playerId, agg);
              }
            }
          } catch {
            skipped++;
          }
        }

        for (const [, p] of playersAgg) {
          const games = Math.max(1, p.games.size);
          await db.upsertPlayer({
            playerId: p.playerId,
            sourcePlayerId: p.sourcePlayerId,
            name: p.name,
            teamId: p.teamId,
            positionCode: 'MF',
            avgShotsPerGame: p.shots / games,
            avgShotsOnTargetPerGame: p.shotsOnTarget / games,
            avgXGPerGame: p.xg / games,
            avgXGOTPerGame: p.xgot / games,
            totalGoals: p.goals,
            totalShots: p.shots,
            totalShotsOnTarget: p.shotsOnTarget,
            shotShareOfTeam: 0,
            gamesPlayed: games,
            statsJson: JSON.stringify({
              source: 'fotmob',
              season,
              competition: competitionName,
              totalXG: p.xg,
              totalXGOT: p.xgot,
              rawSamples: p.rawSamples.slice(0, 8),
            }),
          });
          playersUpdated++;
        }

        totalImported += imported;
        totalUpdatedExisting += updatedExisting;
        totalSkipped += skipped;
        totalNew += imported;
        totalUpcomingImported += importedUpcoming;

        seasonSummary[`${competitionName} ${season}`] = {
          lastDateBefore: lastDateInDb ?? 'nessuna',
          totalOnSource: allMatches.length,
          newImported: imported,
          updatedExisting,
          newImportedPlayed: importedPlayed,
          newImportedUpcoming: importedUpcoming,
          touchedTotal: matchesToImport.length,
          skipped,
          playersUpserted: playersAgg.size,
        };
      }
    }

    let teamsRecomputed = 0;
    for (const comp of competitionsToRun) {
      const teams = await db.getTeams(comp);
      for (const t of teams) {
        await db.recomputeTeamAverages(t.team_id);
        teamsRecomputed++;
      }
    }

    const lastSeason = seasonsToScrape[seasonsToScrape.length - 1];
    const lastDatesAfter: Record<string, string> = {};
    for (const comp of competitionsToRun) {
      lastDatesAfter[comp] = (await db.getLastMatchDate(comp, lastSeason)) ?? 'nessuna';
    }

    res.json({
      success: true,
      data: {
        source: 'fotmob',
        mode,
        competitions: competitionsToRun,
        seasons: seasonsToScrape,
        newMatchesImported: totalImported,
        existingMatchesUpdated: totalUpdatedExisting,
        upcomingMatchesImported: totalUpcomingImported,
        skipped: totalSkipped,
        teamsCreated,
        playersUpdated,
        teamsRecomputed,
        dbLastDateAfter: lastDatesAfter,
        isUpToDate: totalNew === 0,
        forceRefresh,
        message: totalNew === 0
          ? 'DB giÃ  aggiornato, nessuna nuova partita trovata.'
          : `Importate ${totalImported} partite (${totalUpcomingImported} future), aggiornati ${playersUpdated} giocatori.`,
        seasonDetail: seasonSummary,
      }
    });
  } catch (e: any) {
    console.error('[fotmob] Errore:', e.message);
    res.status(500).json({ success: false, error: e.message });
  } finally {
    await fotmob.close().catch(() => undefined);
  }
}

router.post('/scraper/fotmob', runFotmobImport);

/**
 * Info sulle competizioni e stagioni disponibili + stato del DB.
 * Utile per il frontend per sapere quando Ã¨ stato fatto l'ultimo import.
 */
router.get('/scraper/fotmob/info', async (_req, res) => {
  const competitions = FotmobScraper.getSupportedCompetitions();
  const top5 = FotmobScraper.getTop5Competitions();
  const seasons = FotmobScraper.generateSeasons(4);

  // Mostra l'ultima data importata per ogni competizione
  const dbStatus: Record<string, string> = {};
  for (const comp of competitions) {
    const lastSeason = seasons[seasons.length - 1];
    const lastDate = await db.getLastMatchDate(comp, lastSeason);
    dbStatus[comp] = lastDate ?? 'nessun dato';
  }

  res.json({
    success: true,
    data: {
      competitions,
      top5Competitions: top5,
      suggestedSeasons: seasons,
      dbLastImport: dbStatus,
      note: 'Import FotMob via Playwright. Puoi lanciare import singolo o top-5 insieme.',
    }
  });
});

// ====== THE ODDS API ======
import { OddsApiService, OddsMatch } from '../services/OddsApiService';

type OddsCacheEntry = {
  cachedAt: number;
  matches: OddsMatch[];
  remainingRequests: number;
};

type OddsMatchSummary = {
  homeTeam: string;
  awayTeam: string;
  commenceTime: string;
};

type OddsRuntimeState = {
  competition: string;
  markets: string[];
  matchesFound: number;
  matches: OddsMatchSummary[];
  remainingRequests: number | null;
  lastUpdatedAt: string | null;
};

const oddsCache = new Map<string, OddsCacheEntry>();
const ODDS_CACHE_TTL_MS = 90 * 1000;
const getConfiguredOddsApiKey = () =>
  String(process.env.ODDS_API_KEY ?? process.env.THE_ODDS_API_KEY ?? '').trim();

let oddsRuntimeState: OddsRuntimeState = {
  competition: 'Serie A',
  markets: ['h2h', 'totals'],
  matchesFound: 0,
  matches: [],
  remainingRequests: null,
  lastUpdatedAt: null,
};

const toOddsSummary = (matches: OddsMatch[]): OddsMatchSummary[] =>
  matches.map((m) => ({
    homeTeam: m.homeTeam,
    awayTeam: m.awayTeam,
    commenceTime: m.commenceTime,
  }));

const normalizeTeamForOdds = (name: string): string => {
  const aliases: Record<string, string> = {
    'inter milan': 'inter',
    'ac milan': 'milan',
    'hellas verona': 'verona',
    'ssc napoli': 'napoli',
    'ss lazio': 'lazio',
  };

  const cleaned = String(name ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(fc|ac|as|ss|ssc|calcio|club)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return aliases[cleaned] ?? cleaned;
};

const teamSimilarity = (a: string, b: string): number => {
  const na = normalizeTeamForOdds(a);
  const nb = normalizeTeamForOdds(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  if (na.includes(nb) || nb.includes(na)) return 0.86;

  const at = new Set(na.split(' ').filter(Boolean));
  const bt = new Set(nb.split(' ').filter(Boolean));
  if (at.size === 0 || bt.size === 0) return 0;

  let inter = 0;
  for (const t of at) if (bt.has(t)) inter++;
  return inter / Math.max(at.size, bt.size);
};

const matchScore = (candidate: OddsMatch, homeTeam: string, awayTeam: string, commenceTime?: string): number => {
  const straight = teamSimilarity(homeTeam, candidate.homeTeam) + teamSimilarity(awayTeam, candidate.awayTeam);
  const swapped = teamSimilarity(homeTeam, candidate.awayTeam) + teamSimilarity(awayTeam, candidate.homeTeam);
  let score = Math.max(straight, swapped);

  if (commenceTime) {
    const targetTs = new Date(commenceTime).getTime();
    const candTs = new Date(candidate.commenceTime).getTime();
    if (!Number.isNaN(targetTs) && !Number.isNaN(candTs)) {
      const diffHours = Math.abs(targetTs - candTs) / (1000 * 60 * 60);
      if (diffHours <= 1.5) score += 0.5;
      else if (diffHours <= 4) score += 0.25;
      else if (diffHours <= 12) score += 0.1;
    }
  }

  return score;
};

const clamp = (n: number, min: number, max: number): number => Math.max(min, Math.min(max, n));

const probabilityToOdds = (probability: number, overround = 0.06): number => {
  const p = clamp(Number(probability) || 0, 0.02, 0.96);
  const implied = clamp(p * (1 + overround), 0.02, 0.985);
  return Number((1 / implied).toFixed(2));
};

const sanitizeOddsMap = (input: Record<string, number>): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    if (!Number.isFinite(v) || v <= 1.01 || v > 100) continue;
    out[k] = Number(v.toFixed(2));
  }
  return out;
};

const collectModelProbabilitiesForOdds = (prediction: any): Record<string, number> => {
  const probs: any = prediction?.probabilities ?? {};
  const out: Record<string, number> = {};

  const push = (key: string, value: unknown) => {
    const n = Number(value);
    if (Number.isFinite(n) && n > 0 && n < 1) out[key] = n;
  };

  // Goal mercati principali
  push('homeWin', probs.homeWin);
  push('draw', probs.draw);
  push('awayWin', probs.awayWin);
  push('btts', probs.btts);
  push('bttsNo', 1 - Number(probs.btts ?? 0));
  push('double_chance_1x', Number(probs.homeWin ?? 0) + Number(probs.draw ?? 0));
  push('double_chance_x2', Number(probs.draw ?? 0) + Number(probs.awayWin ?? 0));
  push('double_chance_12', Number(probs.homeWin ?? 0) + Number(probs.awayWin ?? 0));
  const dnbDen = Math.max(1e-6, Number(probs.homeWin ?? 0) + Number(probs.awayWin ?? 0));
  push('dnb_home', Number(probs.homeWin ?? 0) / dnbDen);
  push('dnb_away', Number(probs.awayWin ?? 0) / dnbDen);

  const goalLines = [0.5, 1.5, 2.5, 3.5, 4.5];
  for (const line of goalLines) {
    const k = String(line).replace('.', '');
    push(`over${k}`, (probs as any)[`over${k}`]);
    push(`under${k}`, (probs as any)[`under${k}`]);
  }
  const lambdaHomeGoals = Math.max(0.1, Number(probs.lambdaHome ?? 0));
  const lambdaAwayGoals = Math.max(0.1, Number(probs.lambdaAway ?? 0));
  for (const line of [0.5, 1.5, 2.5, 3.5, 4.5, 5.5]) {
    const k = line.toFixed(1).replace('.', '');
    const overHome = poissonOver(line, lambdaHomeGoals);
    const overAway = poissonOver(line, lambdaAwayGoals);
    push(`team_home_over_${k}`, overHome);
    push(`team_home_under_${k}`, 1 - overHome);
    push(`team_away_over_${k}`, overAway);
    push(`team_away_under_${k}`, 1 - overAway);
  }

  // Tiri totali/squadra
  for (const [line, pair] of Object.entries(probs.shotsTotal ?? {})) {
    push(`shots_total_over_${line}`, (pair as any)?.over);
    push(`shots_total_under_${line}`, (pair as any)?.under);
  }
  for (const [line, pair] of Object.entries(probs.shotsHome?.overUnder ?? {})) {
    push(`shots_home_over_${line}`, (pair as any)?.over);
    push(`shots_home_under_${line}`, (pair as any)?.under);
  }
  for (const [line, pair] of Object.entries(probs.shotsAway?.overUnder ?? {})) {
    push(`shots_away_over_${line}`, (pair as any)?.over);
    push(`shots_away_under_${line}`, (pair as any)?.under);
  }

  // Cartellini e falli
  for (const [line, pair] of Object.entries(probs.cards?.overUnderYellow ?? {})) {
    push(`yellow_over_${line}`, (pair as any)?.over);
    push(`yellow_under_${line}`, (pair as any)?.under);
  }
  for (const [line, pair] of Object.entries(probs.cards?.overUnderTotal ?? {})) {
    push(`cards_total_over_${line}`, (pair as any)?.over);
    push(`cards_total_under_${line}`, (pair as any)?.under);
  }
  for (const [line, pair] of Object.entries(probs.fouls?.overUnder ?? {})) {
    push(`fouls_over_${line}`, (pair as any)?.over);
    push(`fouls_under_${line}`, (pair as any)?.under);
  }

  // Tiri in porta combinati (Poisson sui lambda in porta)
  const combinedSOTExp = Number(probs.shotsOnTargetHome?.expected ?? 0) + Number(probs.shotsOnTargetAway?.expected ?? 0);
  for (const line of [5.5, 6.5, 7.5, 8.5, 9.5, 10.5, 11.5]) {
    const key = line.toFixed(1);
    const over = poissonOver(line, combinedSOTExp);
    push(`sot_total_over_${key}`, over);
    push(`sot_total_under_${key}`, 1 - over);
  }

  return out;
};

const marketOverround = (selectionKey: string): number => {
  if (selectionKey === 'homeWin' || selectionKey === 'draw' || selectionKey === 'awayWin') return 0.06;
  if (selectionKey.startsWith('exact_')) return 0.09;
  if (selectionKey.startsWith('hcp_') || selectionKey.startsWith('ahcp_') || selectionKey.startsWith('handicap')) return 0.055;
  return 0.045;
};

const resolveTeamForModel = async (teamName: string, competition?: string): Promise<{ teamId: string; score: number } | null> => {
  const byCompetition = competition ? await db.getTeams(competition) : [];
  const allTeams = await db.getTeams();
  const pool = byCompetition.length > 0 ? byCompetition : allTeams;

  let best: any = null;
  let bestScore = -1;
  for (const t of pool) {
    const candidateName = String(t.name ?? t.team_id ?? '');
    const score = teamSimilarity(teamName, candidateName);
    if (score > bestScore) {
      best = t;
      bestScore = score;
    }
  }

  if (!best || bestScore < 0.72) return null;
  return { teamId: String(best.team_id), score: Number(bestScore.toFixed(3)) };
};

const buildModelEstimatedOdds = async (
  competition: string,
  homeTeamName: string,
  awayTeamName: string
): Promise<{
  found: boolean;
  message: string;
  selectedOdds: Record<string, number>;
  usedFallbackBookmaker: boolean;
  usedSyntheticOdds: boolean;
  source: string;
  confidenceScore?: number;
  match?: { homeTeam: string; awayTeam: string };
}> => {
  const home = (await resolveTeamForModel(homeTeamName, competition)) ?? (await resolveTeamForModel(homeTeamName));
  const away = (await resolveTeamForModel(awayTeamName, competition)) ?? (await resolveTeamForModel(awayTeamName));

  if (!home || !away) {
    return {
      found: false,
      message: 'Impossibile associare le squadre ai dati interni: quote automatiche non disponibili per questo match.',
      selectedOdds: {},
      usedFallbackBookmaker: true,
      usedSyntheticOdds: true,
      source: 'model_estimated',
    };
  }
  if (home.teamId === away.teamId) {
    return {
      found: false,
      message: 'Associazione squadre ambigua: impossibile stimare quote affidabili.',
      selectedOdds: {},
      usedFallbackBookmaker: true,
      usedSyntheticOdds: true,
      source: 'model_estimated',
    };
  }

  const pred = await svc.predict({
    homeTeamId: home.teamId,
    awayTeamId: away.teamId,
    competition,
  });

  const modelProbs = collectModelProbabilitiesForOdds(pred);
  const estimatedOdds: Record<string, number> = {};
  for (const [selection, prob] of Object.entries(modelProbs)) {
    estimatedOdds[selection] = probabilityToOdds(prob, marketOverround(selection));
  }
  const baseOdds = sanitizeOddsMap(estimatedOdds);

  if (Object.keys(baseOdds).length === 0) {
    return {
      found: false,
      message: 'Il modello non ha prodotto quote valide per questa partita.',
      selectedOdds: {},
      usedFallbackBookmaker: true,
      usedSyntheticOdds: true,
      source: 'model_estimated',
      confidenceScore: Number(((home.score + away.score) / 2).toFixed(3)),
    };
  }

  return {
    found: true,
    message: 'Quote live non disponibili: caricate quote stimate dal modello interno (non quote live Eurobet).',
    selectedOdds: baseOdds,
    usedFallbackBookmaker: true,
    usedSyntheticOdds: true,
    source: 'model_estimated',
    confidenceScore: Number(((home.score + away.score) / 2).toFixed(3)),
    match: {
      homeTeam: homeTeamName,
      awayTeam: awayTeamName,
    },
  };
};

const getCompetitionOdds = async (
  apiKey: string,
  competition: string,
  markets: string[] = ['h2h', 'totals'],
  useCache = true
): Promise<{ oddsService: OddsApiService; matches: OddsMatch[]; fromCache: boolean }> => {
  const cacheKey = `${apiKey.trim()}::${competition}::${markets.join(',')}`;
  const cached = useCache ? oddsCache.get(cacheKey) : undefined;
  const now = Date.now();
  if (cached && now - cached.cachedAt < ODDS_CACHE_TTL_MS) {
    const svc = new OddsApiService(apiKey);
    svc.setRemainingRequests(cached.remainingRequests);
    return { oddsService: svc, matches: cached.matches, fromCache: true };
  }

  const oddsService = new OddsApiService(apiKey);
  const matches = await oddsService.getOdds(competition, markets);
  oddsCache.set(cacheKey, {
    cachedAt: now,
    matches,
    remainingRequests: oddsService.getRemainingRequests(),
  });
  return { oddsService, matches, fromCache: false };
};

const mergeOddsMatchMarkets = (base: OddsMatch, extra: OddsMatch): OddsMatch => {
  const byBookmaker = new Map<string, any>();

  for (const bm of base.bookmakers ?? []) {
    byBookmaker.set(String(bm.bookmakerKey), {
      ...bm,
      markets: [...(bm.markets ?? [])],
    });
  }

  for (const bm of extra.bookmakers ?? []) {
    const key = String(bm.bookmakerKey);
    const existing = byBookmaker.get(key);
    if (!existing) {
      byBookmaker.set(key, {
        ...bm,
        markets: [...(bm.markets ?? [])],
      });
      continue;
    }

    const marketMap = new Map<string, any>();
    for (const m of existing.markets ?? []) {
      marketMap.set(String(m.marketKey), {
        ...m,
        outcomes: [...(m.outcomes ?? [])],
      });
    }

    for (const m of bm.markets ?? []) {
      const mKey = String(m.marketKey);
      const prev = marketMap.get(mKey);
      if (!prev) {
        marketMap.set(mKey, {
          ...m,
          outcomes: [...(m.outcomes ?? [])],
        });
        continue;
      }

      const outcomeSet = new Set<string>();
      for (const o of prev.outcomes ?? []) {
        outcomeSet.add(`${String(o.name)}|${String(o.point ?? '')}|${String((o as any).description ?? '')}`);
      }
      for (const o of m.outcomes ?? []) {
        const signature = `${String(o.name)}|${String(o.point ?? '')}|${String((o as any).description ?? '')}`;
        if (!outcomeSet.has(signature)) {
          prev.outcomes.push(o);
          outcomeSet.add(signature);
        }
      }
      marketMap.set(mKey, prev);
    }

    existing.markets = Array.from(marketMap.values());
    byBookmaker.set(key, existing);
  }

  return {
    ...base,
    bookmakers: Array.from(byBookmaker.values()),
  };
};

router.post('/scraper/odds', async (req: Request, res: Response) => {
  try {
    const { competition = 'Serie A', markets = ['h2h', 'totals'] } = req.body;
    const normalizedMarkets = Array.isArray(markets) && markets.length > 0
      ? markets.map((m: unknown) => String(m)).filter(Boolean)
      : ['h2h', 'totals'];
    const apiKey = getConfiguredOddsApiKey();
    if (!apiKey) {
      return res.status(500).json({
        success: false,
        error: 'ODDS_API_KEY non configurata sul server.',
      });
    }

    const { oddsService, matches } = await getCompetitionOdds(apiKey, competition, normalizedMarkets, false);

    const enriched = matches.map(m => ({
      homeTeam: m.homeTeam,
      awayTeam: m.awayTeam,
      commenceTime: m.commenceTime,
      eurobetOdds: oddsService.extractBestOdds(m, 'eurobet'),
      bestOdds: oddsService.extractBestOdds(m),
      bookmakerComparison: oddsService.compareBookmakers(m),
      margins: m.bookmakers.reduce((acc, bm) => {
        const margin = oddsService.calculateMargin(m, bm.bookmakerKey);
        if (margin !== null) acc[bm.bookmakerName] = `${margin}%`;
        return acc;
      }, {} as Record<string, string>),
      remainingRequests: oddsService.getRemainingRequests(),
    }));

    const updatedAt = new Date().toISOString();
    oddsRuntimeState = {
      competition: String(competition),
      markets: normalizedMarkets,
      matchesFound: matches.length,
      matches: toOddsSummary(matches),
      remainingRequests: oddsService.getRemainingRequests(),
      lastUpdatedAt: updatedAt,
    };

    res.json({
      success: true,
      data: {
        competition,
        markets: normalizedMarkets,
        matchesFound: matches.length,
        matches: enriched,
        remainingRequests: oddsService.getRemainingRequests(),
        lastUpdatedAt: updatedAt,
      }
    });
  } catch (e: any) {
    console.error('[OddsApi] Errore:', e.message);
    res.status(500).json({ success: false, error: e.message });
  }
});

router.post('/scraper/odds/match', async (req: Request, res: Response) => {
  try {
    const {
      competition = 'Serie A',
      homeTeam,
      awayTeam,
      commenceTime,
    } = req.body ?? {};

    if (!homeTeam || !awayTeam) {
      return res.status(400).json({ success: false, error: 'homeTeam e awayTeam sono obbligatori.' });
    }

    const trimmedApiKey = getConfiguredOddsApiKey();
    const preferredMarkets = ['h2h', 'totals', 'spreads'];
    const fallbackMarkets = ['h2h', 'totals'];
    const eventAdditionalMarkets = [
      'btts',
      'draw_no_bet',
      'h2h_3_way',
      'double_chance',
      'team_totals',
      'alternate_totals',
      'alternate_spreads',
      'alternate_team_totals',
    ];
    if (!trimmedApiKey) {
      const estimated = await buildModelEstimatedOdds(String(competition), String(homeTeam), String(awayTeam));
      return res.json({
        success: true,
        data: {
          ...estimated,
          eurobetOdds: {},
          fallbackOdds: estimated.selectedOdds,
          allBookmakerOdds: [],
          marketsRequested: ['model_estimated'],
          remainingRequests: null,
        }
      });
    }

    let oddsService: OddsApiService;
    let matches: OddsMatch[];
    let marketsRequested = [...preferredMarkets];
    try {
      const result = await getCompetitionOdds(trimmedApiKey, competition, preferredMarkets);
      oddsService = result.oddsService;
      matches = result.matches;
    } catch (apiError: any) {
      try {
        const fallbackResult = await getCompetitionOdds(trimmedApiKey, competition, fallbackMarkets);
        oddsService = fallbackResult.oddsService;
        matches = fallbackResult.matches;
        marketsRequested = [...fallbackMarkets];
      } catch {
        const estimated = await buildModelEstimatedOdds(String(competition), String(homeTeam), String(awayTeam));
        if (estimated.found) {
          return res.json({
            success: true,
            data: {
              ...estimated,
              message: `The Odds API non disponibile (${apiError?.response?.status ?? apiError?.message ?? 'errore'}): caricate quote stimate dal modello.`,
              eurobetOdds: {},
              fallbackOdds: estimated.selectedOdds,
              allBookmakerOdds: [],
              marketsRequested: ['model_estimated'],
              remainingRequests: null,
            }
          });
        }
        throw apiError;
      }

      if (!matches || !oddsService) {
        const estimated = await buildModelEstimatedOdds(String(competition), String(homeTeam), String(awayTeam));
        if (estimated.found) {
          return res.json({
            success: true,
            data: {
              ...estimated,
              message: `The Odds API non disponibile (${apiError?.response?.status ?? apiError?.message ?? 'errore'}): caricate quote stimate dal modello.`,
              eurobetOdds: {},
              fallbackOdds: estimated.selectedOdds,
              allBookmakerOdds: [],
              marketsRequested: ['model_estimated'],
              remainingRequests: null,
            }
          });
        }
        throw apiError;
      }

      // continua con il fallback mercati base se quelli completi non sono disponibili
    }

    if (!matches || !oddsService) {
      const estimated = await buildModelEstimatedOdds(String(competition), String(homeTeam), String(awayTeam));
      if (estimated.found) {
        return res.json({
          success: true,
          data: {
            ...estimated,
            message: 'The Odds API non disponibile: caricate quote stimate dal modello.',
            eurobetOdds: {},
            fallbackOdds: estimated.selectedOdds,
            allBookmakerOdds: [],
            marketsRequested: ['model_estimated'],
            remainingRequests: null,
          }
        });
      }
      throw new Error('Nessuna fonte quote disponibile');
    }

    if (!matches || matches.length === 0) {
      return res.json({
        success: true,
        data: {
          found: false,
          message: 'Nessuna quota disponibile ora per questa competizione.',
          remainingRequests: oddsService.getRemainingRequests(),
        }
      });
    }

    let best: OddsMatch | null = null;
    let bestScore = -1;
    for (const m of matches) {
      const score = matchScore(m, String(homeTeam), String(awayTeam), commenceTime ? String(commenceTime) : undefined);
      if (score > bestScore) {
        best = m;
        bestScore = score;
      }
    }

    if (!best || bestScore < 1.25) {
      return res.json({
        success: true,
        data: {
          found: false,
          message: 'Match non trovato nelle quote live al momento.',
          bestScore: Number(bestScore.toFixed(3)),
          remainingRequests: oddsService.getRemainingRequests(),
        }
      });
    }

    const eventId = String(best.matchId ?? '').startsWith('odds_')
      ? String(best.matchId).replace(/^odds_/, '')
      : '';
    let mergedBest = best;
    let additionalMarketsLoaded: string[] = [];
    if (eventId) {
      try {
        const extraEvent = await oddsService.getEventOdds(String(competition), eventId, eventAdditionalMarkets);
        if (extraEvent) {
          mergedBest = mergeOddsMatchMarkets(best, extraEvent);
          additionalMarketsLoaded = Array.from(
            new Set(
              (extraEvent.bookmakers ?? [])
                .flatMap((bm) => (bm.markets ?? []).map((m) => String(m.marketKey)))
                .filter(Boolean)
            )
          );
        }
      } catch (extraErr: any) {
        console.warn('[OddsApi/match] Mercati evento extra non disponibili:', extraErr?.message ?? extraErr);
      }
    }
    const finalMarketsRequested = Array.from(new Set([...marketsRequested, ...additionalMarketsLoaded]));

    const eurobetAvailable = mergedBest.bookmakers.some((b) => b.bookmakerKey === 'eurobet');
    const eurobetOnlyMatch: OddsMatch = {
      ...mergedBest,
      bookmakers: mergedBest.bookmakers.filter((b) => b.bookmakerKey === 'eurobet'),
    };

    // selectedOdds: prova Eurobet, ma completa automaticamente i mercati mancanti con altri bookmaker.
    const eurobetOdds = oddsService.extractBestOdds(eurobetOnlyMatch, 'eurobet');
    const selectedOdds = oddsService.extractBestOdds(mergedBest, 'eurobet');
    const fallbackOdds = selectedOdds;
    const usedFallbackBookmaker = !eurobetAvailable
      || Object.keys(selectedOdds).some((k) => eurobetOdds[k] === undefined);

    return res.json({
      success: true,
      data: {
        found: Object.keys(selectedOdds).length > 0,
        usedFallbackBookmaker,
        usedSyntheticOdds: false,
        source: usedFallbackBookmaker ? 'the_odds_api_fallback_bookmaker' : 'the_odds_api_eurobet',
        selectedOdds,
        eurobetOdds,
        fallbackOdds,
        allBookmakerOdds: [],
        marketsRequested: finalMarketsRequested.length > 0 ? finalMarketsRequested : marketsRequested,
        match: {
          homeTeam: mergedBest.homeTeam,
          awayTeam: mergedBest.awayTeam,
          commenceTime: mergedBest.commenceTime,
        },
        confidenceScore: Number(bestScore.toFixed(3)),
        remainingRequests: oddsService.getRemainingRequests(),
      }
    });
  } catch (e: any) {
    console.error('[OddsApi/match] Errore:', e.message);
    return res.status(500).json({ success: false, error: e.message });
  }
});

router.get('/scraper/odds/status', (_req, res) => {
  res.json({
    success: true,
    data: oddsRuntimeState,
  });
});

router.get('/scraper/odds/info', (_req, res) => {
  res.json({
    success: true,
    data: {
      competitions: OddsApiService.getSupportedCompetitions(),
      bookmakers: OddsApiService.getSupportedBookmakers(),
      freePlanLimit: 500,
      registrationUrl: 'https://the-odds-api.com',
      note: 'Piano gratuito: 500 richieste/mese. Per la Serie A bastano ~4 richieste/settimana.',
    }
  });
});

export default router;

