/**
 * Backtesting Engine — v3
 *
 * MODIFICHE v3:
 *
 * 1. SELEZIONE BET: selectMediumAndAbove (HIGH + MEDIUM confidence)
 *    invece di solo HIGH. Questo porta il volume nel range target
 *    150-400 bet/stagione su una lega completa (38 giornate × N partite).
 *    L'utente può passare a selectHighConfidence per essere più conservativo.
 *
 * 2. RANGE ODDS SINTETICI: [1.40, 8.00] allineato con ValueBettingEngine v3.
 *    Il motore genererà quote anche per underdog (quota 4-8) quando
 *    la probabilità implicita è nel range corretto.
 *
 * 3. MARGINE SINTETICO: ridotto a 5% (era 6%). Bookmaker competitivi
 *    (Pinnacle, Betfair) hanno margini realistici del 3-5%.
 *
 * 4. JITTER RIDOTTO: ±6% (era ±8%). Meno rumore → simulazione più realistica
 *    del comportamento di un bookmaker efficiente.
 *
 * 5. marketBreakdown: aggiornato con MarketCategory di v3.
 *
 * 6. evaluateBet: gestisce tutti i mercati inclusi tiri, gialli, falli.
 *    Per i mercati statistici, se il dato reale non è disponibile in MatchData,
 *    la bet viene marcata come non valutabile (VOID) e separata dalle metriche
 *    di ROI/win-rate per evitare penalizzazioni silenziose nel backtest.
 */

import { DixonColesModel, MatchData } from './DixonColesModel';
import { ValueBettingEngine, BetOpportunity, ComboBetOpportunity, MarketCategory, AdaptiveEngineTuningProfile } from './ValueBettingEngine';
import { evaluateComboBet } from './CombinedBettingFixes';

export interface BacktestResult {
  totalMatches: number;
  trainingMatches: number;
  testMatches: number;
  betsPlaced: number;
  voidedBets: number;
  unevaluableRate: number;
  betsWon: number;
  totalStaked: number;
  totalReturn: number;
  netProfit: number;
  roi: number;
  winRate: number;
  averageOdds: number;
  averageEV: number;
  brierScore: number;
  logLoss: number;
  calibration: CalibrationBucket[];
  equityCurve: EquityPoint[];
  monthlyStats: MonthlyStats[];
  sharpeRatio: number;
  maxDrawdown: number;
  recoveryFactor: number;
  profitFactor: number;
  marketBreakdown: Record<string, MarketStats>;
  marketUnevaluableBreakdown: Record<string, {
    attempted: number;
    voided: number;
    unevaluableRate: number;
  }>;
  /**
   * edgeNoVig: edge medio del modello calcolato rimuovendo il vig dalle quote
   * usate nel backtest. È il proxy più vicino al Closing Line Value (CLV).
   * Formula: edgeNoVig_i = ourProb_i - (1 / odds_i)
   * Un valore > 0 in media indica che il modello batte il mercato ante-vig.
   * NOTA: con quote sintetiche questo valore è ottimisticamente distorto;
   * ha significato reale solo con quote storiche di chiusura (Pinnacle/Betfair).
   */
  edgeNoVig: number;
  /**
   * edgeDecayByMonth: edgeNoVig medio per mese, in ordine cronologico.
   * Permette di rilevare erosione dell'alpha nel tempo (edge decay).
   * Se i valori scendono sistematicamente → il modello perde valore.
   */
  edgeDecayByMonth: Array<{ year: number; month: number; edgeNoVig: number; bets: number }>;
  /**
   * rollingSharpePeriods: Sharpe ratio calcolato su finestre fisse di N bet.
   * Utile per rilevare se il Sharpe globale è trainato da un sottoperiodo.
   */
  rollingSharpePeriods: Array<{ periodStart: number; periodEnd: number; sharpe: number }>;
  /**
   * usedSyntheticOddsOnly: true se non è stata passata nessuna quota reale.
   * In questo caso edgeNoVig e Sharpe hanno valore puramente indicativo.
   */
  usedSyntheticOddsOnly: boolean;
}

export interface MarketStats {
  bets: number;
  voided: number;
  won: number;
  staked: number;
  returned: number;
  roi: number;
  winRate: number;
  avgOdds: number;
  avgEV: number;
  unevaluableRate: number;
}

export interface CalibrationBucket {
  predictedRange: string;
  predictedAvg: number;
  actualFrequency: number;
  count: number;
}

export interface EquityPoint {
  date: Date;
  matchNumber: number;
  bankroll: number;
  profit: number;
  cumulativeROI: number;
}

export interface MonthlyStats {
  year: number;
  month: number;
  bets: number;
  staked: number;
  returned: number;
  profit: number;
  roi: number;
}

export interface WalkForwardFoldSummary {
  foldNumber: number;
  trainMatches: number;
  testMatches: number;
  betsPlaced: number;
  betsWon: number;
  totalStaked: number;
  roi: number;
  winRate: number;
  netProfit: number;
  brierScore: number;
  logLoss: number;
  startDate: Date;
  endDate: Date;
}

export interface WalkForwardBacktestResult {
  totalMatches: number;
  totalFolds: number;
  expandingWindow: boolean;
  initialTrainMatches: number;
  testWindowMatches: number;
  stepMatches: number;
  folds: WalkForwardFoldSummary[];
  summary: {
    totalBetsPlaced: number;
    totalBetsWon: number;
    totalNetProfit: number;
    totalStaked: number;
    roi: number;
    winRate: number;
    averageFoldROI: number;
    medianFoldROI: number;
    roiStdDev: number;
    positiveFoldRate: number;
    averageBrierScore: number;
    averageLogLoss: number;
  };
}

interface TestBet {
  matchDate: Date;
  market: string;
  marketCategory: MarketCategory;
  selection: string;
  odds: number;
  stake: number;
  ourProb: number;
  ev: number;
  won: boolean;
  profit: number;
  /** true se la quota usata è sintetica (nessuna quota reale disponibile per la partita) */
  isSynthetic: boolean;
}

export class BacktestingEngine {
  private model:  DixonColesModel;
  private engine: ValueBettingEngine;
  private readonly INITIAL_BANKROLL = 1000;
  private readonly SYNTHETIC_MARGIN = 1.05;   // 5% margine bookmaker simulato
  private readonly SYNTHETIC_JITTER = 0.06;   // ±6% rumore deterministico
  // Quote sintetiche generate solo nel range dove il modello è affidabile
  private readonly SYN_MIN_ODDS = 1.40;
  private readonly SYN_MAX_ODDS = 8.00;

  constructor() {
    this.model  = new DixonColesModel();
    this.engine = new ValueBettingEngine();
  }

  setAdaptiveTuning(profile: AdaptiveEngineTuningProfile | null | undefined): void {
    this.engine.setAdaptiveTuning(profile ?? null);
  }

  private simulateBacktestScenario(
    trainMatches: MatchData[],
    testMatches: MatchData[],
    historicalOdds: Record<string, Record<string, number>>,
    confidenceLevel: 'high_only' | 'medium_and_above'
  ): BacktestResult {
    const teams = [...new Set([...trainMatches, ...testMatches].flatMap(m => [m.homeTeamId, m.awayTeamId]))];

    this.model.fitModel(trainMatches, teams);

    const bets: TestBet[] = [];
    const attemptedByCategory: Record<string, number> = {};
    const voidedByCategory: Record<string, number> = {};
    let bankroll = this.INITIAL_BANKROLL;
    let syntheticOddsMatchCount = 0;
    let realOddsMatchCount = 0;
    const equityCurve: EquityPoint[] = [
      { date: testMatches[0]?.date ?? new Date(), matchNumber: 0, bankroll, profit: 0, cumulativeROI: 0 }
    ];

    for (let i = 0; i < testMatches.length; i++) {
      const match = testMatches[i];
      if (match.homeGoals === undefined || match.awayGoals === undefined) continue;

      const probs = this.model.computeFullProbabilities(
        match.homeTeamId, match.awayTeamId, match.homeXG, match.awayXG
      );
      const probMap     = probs.flatProbabilities;
      const marketNames = this.buildMarketNames(probMap);
      const hasRealOdds = Boolean(historicalOdds[match.matchId]);
      const odds        = historicalOdds[match.matchId]
        ?? this.generateSyntheticOdds(match.matchId, probMap);

      if (hasRealOdds) realOddsMatchCount++; else syntheticOddsMatchCount++;

      const allOpportunities = this.engine.analyzeMarkets(probMap, odds, marketNames);
      const selected = confidenceLevel === 'high_only'
        ? this.engine.selectHighConfidence(allOpportunities)
        : this.engine.selectMediumAndAbove(allOpportunities);

      for (const opp of selected) {
        const stakeAmount = (bankroll * opp.suggestedStakePercent) / 100;
        if (stakeAmount > bankroll * 0.04 || stakeAmount < 0.50) continue;
        const categoryKey = String(opp.marketCategory);
        attemptedByCategory[categoryKey] = (attemptedByCategory[categoryKey] ?? 0) + 1;

        const outcome = this.evaluateBetNullable(opp.selection, match);
        if (outcome === null) {
          voidedByCategory[categoryKey] = (voidedByCategory[categoryKey] ?? 0) + 1;
          continue;
        }

        const won = outcome;
        const returnAmount = won ? stakeAmount * opp.bookmakerOdds : 0;
        const profit       = returnAmount - stakeAmount;

        bankroll += profit;
        bets.push({
          matchDate:       match.date,
          market:          opp.marketName,
          marketCategory:  opp.marketCategory,
          selection:       opp.selection,
          odds:            opp.bookmakerOdds,
          stake:           stakeAmount,
          ourProb:         opp.ourProbability / 100,
          ev:              opp.expectedValue  / 100,
          won,
          profit,
          isSynthetic:     !hasRealOdds,
        });
      }

      equityCurve.push({
        date:          match.date,
        matchNumber:   i + 1,
        bankroll,
        profit:        bankroll - this.INITIAL_BANKROLL,
        cumulativeROI: ((bankroll - this.INITIAL_BANKROLL) / this.INITIAL_BANKROLL) * 100,
      });
    }

    const totalVoided = Object.values(voidedByCategory).reduce((sum, value) => sum + value, 0);
    if (totalVoided > 0) {
      const details = Object.entries(voidedByCategory)
        .sort((a, b) => b[1] - a[1])
        .map(([category, count]) => `${category}:${count}`)
        .join(', ');
      console.warn(`[Backtest] Bet non valutabili (VOID): ${totalVoided} | breakdown: ${details}`);
    }
    if (realOddsMatchCount === 0 && syntheticOddsMatchCount > 0) {
      console.warn(
        `[Backtest] Nessuna quota reale fornita (${syntheticOddsMatchCount} partite con quote sintetiche). ` +
        'I risultati non sono validabili contro il mercato reale.'
      );
    } else if (syntheticOddsMatchCount > 0) {
      console.info(
        `[Backtest] Quote reali: ${realOddsMatchCount} partite | Quote sintetiche: ${syntheticOddsMatchCount} partite.`
      );
    }

    return this.computeMetrics(
      bets,
      equityCurve,
      trainMatches.length,
      testMatches.length,
      attemptedByCategory,
      voidedByCategory
    );
  }

  /**
   * runBacktest — split temporale con holdout duro opzionale.
   *
   * SPLIT PER RATIO (default, trainRatio=0.7):
   *   Le ultime (1-trainRatio)×N partite diventano il test set.
   *   Equivalente al comportamento precedente.
   *
   * HOLDOUT TEMPORALE DURO (temporalHoldoutMonths > 0):
   *   Gli ultimi N mesi del dataset vengono riservati come test set
   *   e NON vengono mai usati nel training, indipendentemente dalla ratio.
   *   Questo è il metodo corretto per rilevare overfitting temporale:
   *   il modello non ha mai "visto" il futuro durante il fitting.
   *
   *   Esempio: dataset gen 2022 - dic 2024, holdout = 6 mesi
   *     → Training: gen 2022 - giu 2024
   *     → Test (holdout): lug 2024 - dic 2024
   *
   *   Se il dataset copre meno di holdout+3 mesi viene usato il fallback
   *   ratio per evitare training set vuoti.
   *
   *   METRICA CHIAVE: confrontare edgeNoVig del holdout vs edgeNoVig del
   *   training. Se holdout << training → overfitting temporale confermato.
   *
   * @param temporalHoldoutMonths  Mesi finali da bloccare come test (0 = disabilitato)
   */
  runBacktest(
    matches: MatchData[],
    historicalOdds: Record<string, Record<string, number>>,
    trainRatio = 0.7,
    confidenceLevel: 'high_only' | 'medium_and_above' = 'medium_and_above',
    temporalHoldoutMonths = 0
  ): BacktestResult {
    const sorted = [...matches].sort((a, b) => a.date.getTime() - b.date.getTime());

    let trainMatches: MatchData[];
    let testMatches: MatchData[];

    if (temporalHoldoutMonths > 0 && sorted.length > 0) {
      // Calcola la data di cutoff: ultima data del dataset meno N mesi
      const lastDate = sorted[sorted.length - 1].date;
      const cutoff   = new Date(lastDate);
      cutoff.setMonth(cutoff.getMonth() - temporalHoldoutMonths);

      const candidateTrain = sorted.filter(m => m.date < cutoff);
      const candidateTest  = sorted.filter(m => m.date >= cutoff);

      // Fallback a ratio se il training sarebbe troppo piccolo (< 30 partite)
      if (candidateTrain.length >= 30 && candidateTest.length >= 5) {
        trainMatches = candidateTrain;
        testMatches  = candidateTest;
        console.log(
          `[Backtest] Holdout temporale duro: cutoff ${cutoff.toISOString().slice(0,10)} | ` +
          `Training: ${trainMatches.length} partite | Test: ${testMatches.length} partite ` +
          `(ultimi ${temporalHoldoutMonths} mesi)`
        );
      } else {
        console.warn(
          `[Backtest] Holdout temporale di ${temporalHoldoutMonths} mesi produce training < 30 partite — ` +
          `fallback a trainRatio=${trainRatio}.`
        );
        const splitIdx = Math.floor(sorted.length * trainRatio);
        trainMatches = sorted.slice(0, splitIdx);
        testMatches  = sorted.slice(splitIdx);
      }
    } else {
      const splitIdx = Math.floor(sorted.length * trainRatio);
      trainMatches = sorted.slice(0, splitIdx);
      testMatches  = sorted.slice(splitIdx);
    }

    console.log(`[Backtest] Training: ${trainMatches.length} partite | Test: ${testMatches.length}`);
    const result = this.simulateBacktestScenario(trainMatches, testMatches, historicalOdds, confidenceLevel);
    console.log(`[Backtest] Bet piazzate: ${result.betsPlaced} | ROI: ${result.roi.toFixed(2)}% | edgeNoVig: ${result.edgeNoVig.toFixed(4)}${result.usedSyntheticOddsOnly ? ' ⚠️ solo quote sintetiche' : ''}`);
    return result;
  }

  runWalkForwardBacktest(
    matches: MatchData[],
    historicalOdds: Record<string, Record<string, number>>,
    options?: {
      initialTrainMatches?: number;
      testWindowMatches?: number;
      stepMatches?: number;
      confidenceLevel?: 'high_only' | 'medium_and_above';
      expandingWindow?: boolean;
      maxFolds?: number;
    }
  ): WalkForwardBacktestResult {
    const sorted = [...matches].sort((a, b) => a.date.getTime() - b.date.getTime());
    const totalMatches = sorted.length;
    const initialTrainMatches = Math.max(30, Math.min(Number(options?.initialTrainMatches ?? Math.floor(totalMatches * 0.55)), totalMatches - 10));
    const testWindowMatches = Math.max(10, Math.min(Number(options?.testWindowMatches ?? Math.max(10, Math.floor(totalMatches * 0.12))), totalMatches - initialTrainMatches));
    const stepMatches = Math.max(5, Math.min(Number(options?.stepMatches ?? testWindowMatches), testWindowMatches));
    const confidenceLevel = options?.confidenceLevel ?? 'medium_and_above';
    const expandingWindow = options?.expandingWindow !== false;
    const maxFolds = Math.max(1, Number(options?.maxFolds ?? 12));

    const folds: WalkForwardFoldSummary[] = [];

    for (let testStart = initialTrainMatches; testStart < sorted.length && folds.length < maxFolds; testStart += stepMatches) {
      const testEnd = Math.min(sorted.length, testStart + testWindowMatches);
      const trainStart = expandingWindow ? 0 : Math.max(0, testStart - initialTrainMatches);
      const trainMatches = sorted.slice(trainStart, testStart);
      const testMatches = sorted.slice(testStart, testEnd);
      if (trainMatches.length < 30 || testMatches.length < 5) continue;

      const foldResult = this.simulateBacktestScenario(trainMatches, testMatches, historicalOdds, confidenceLevel);
      folds.push({
        foldNumber: folds.length + 1,
        trainMatches: trainMatches.length,
        testMatches: testMatches.length,
        betsPlaced: foldResult.betsPlaced,
        betsWon: foldResult.betsWon,
        totalStaked: Number(foldResult.totalStaked.toFixed(2)),
        roi: Number(foldResult.roi.toFixed(2)),
        winRate: Number(foldResult.winRate.toFixed(2)),
        netProfit: Number(foldResult.netProfit.toFixed(2)),
        brierScore: Number(foldResult.brierScore.toFixed(4)),
        logLoss: Number(foldResult.logLoss.toFixed(4)),
        startDate: testMatches[0].date,
        endDate: testMatches[testMatches.length - 1].date,
      });
    }

    const totalBetsPlaced = folds.reduce((sum, fold) => sum + fold.betsPlaced, 0);
    const totalBetsWon = folds.reduce((sum, fold) => sum + fold.betsWon, 0);
    const totalNetProfit = folds.reduce((sum, fold) => sum + fold.netProfit, 0);
    const foldRois = folds.map((fold) => fold.roi);
    const averageFoldROI = foldRois.length > 0 ? foldRois.reduce((sum, value) => sum + value, 0) / foldRois.length : 0;
    const sortedRois = [...foldRois].sort((a, b) => a - b);
    const medianFoldROI = sortedRois.length > 0
      ? (sortedRois.length % 2 === 1
        ? sortedRois[Math.floor(sortedRois.length / 2)]
        : (sortedRois[sortedRois.length / 2 - 1] + sortedRois[sortedRois.length / 2]) / 2)
      : 0;
    const roiStdDev = foldRois.length > 0
      ? Math.sqrt(foldRois.reduce((sum, value) => sum + ((value - averageFoldROI) ** 2), 0) / foldRois.length)
      : 0;
    const totalStaked = folds.reduce((sum, fold) => sum + fold.totalStaked, 0);
    const totalRoi = totalStaked > 0 ? (totalNetProfit / totalStaked) * 100 : averageFoldROI;

    return {
      totalMatches,
      totalFolds: folds.length,
      expandingWindow,
      initialTrainMatches,
      testWindowMatches,
      stepMatches,
      folds,
      summary: {
        totalBetsPlaced,
        totalBetsWon,
        totalNetProfit: Number(totalNetProfit.toFixed(2)),
        totalStaked: Number(totalStaked.toFixed(2)),
        roi: Number(totalRoi.toFixed(2)),
        winRate: totalBetsPlaced > 0 ? Number(((totalBetsWon / totalBetsPlaced) * 100).toFixed(2)) : 0,
        averageFoldROI: Number(averageFoldROI.toFixed(2)),
        medianFoldROI: Number(medianFoldROI.toFixed(2)),
        roiStdDev: Number(roiStdDev.toFixed(2)),
        positiveFoldRate: folds.length > 0 ? Number(((folds.filter((fold) => fold.roi > 0).length / folds.length) * 100).toFixed(2)) : 0,
        averageBrierScore: folds.length > 0 ? Number((folds.reduce((sum, fold) => sum + fold.brierScore, 0) / folds.length).toFixed(4)) : 0,
        averageLogLoss: folds.length > 0 ? Number((folds.reduce((sum, fold) => sum + fold.logLoss, 0) / folds.length).toFixed(4)) : 0,
      },
    };
  }

  // ==================== QUOTE SINTETICHE ====================

  private deterministicNoise(seed: string): number {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619); }
    return ((h >>> 0) / 4294967295 - 0.5) * 2;
  }

  /**
   * Genera quote sintetiche per tutti i mercati con probabilità plausibile.
   * Applica margine 5% + jitter deterministico ±6%.
   * Genera solo se la quota fair è nel range [SYN_MIN_ODDS, SYN_MAX_ODDS].
   */
  private generateSyntheticOdds(
    matchId: string,
    probMap: Record<string, number>
  ): Record<string, number> {
    const odds: Record<string, number> = {};
    for (const [market, prob] of Object.entries(probMap)) {
      if (!prob || prob <= 0.02 || prob >= 0.98) continue;
      const fairOdds = 1 / prob;
      if (fairOdds < this.SYN_MIN_ODDS || fairOdds > this.SYN_MAX_ODDS) continue;
      const withMargin = fairOdds * this.SYNTHETIC_MARGIN;
      const noise      = this.deterministicNoise(`${matchId}:${market}`);
      const noisy      = withMargin * (1 + noise * this.SYNTHETIC_JITTER);
      odds[market]     = parseFloat(Math.max(1.05, Math.min(20, noisy)).toFixed(3));
    }
    return odds;
  }

  // ==================== NOMI MERCATI ====================

  private buildMarketNames(probMap: Record<string, number>): Record<string, string> {
    const names: Record<string, string> = {
      homeWin: 'Esito - 1', draw: 'Esito - X', awayWin: 'Esito - 2',
      btts: 'Goal Goal', bttsNo: 'No Goal',
      over05:'Over 0.5', under05:'Under 0.5', over15:'Over 1.5', under15:'Under 1.5',
      over25:'Over 2.5', under25:'Under 2.5', over35:'Over 3.5', under35:'Under 3.5',
      over45:'Over 4.5', under45:'Under 4.5',
    };

    for (const key of Object.keys(probMap)) {
      if (names[key]) continue;
      if      (key.startsWith('shotsOver')    && !key.includes('Home') && !key.includes('Away'))
        names[key] = `Tiri Tot Over ${this.lineFromKey(key, 'shotsOver')}`;
      else if (key.startsWith('shotsUnder')   && !key.includes('Home') && !key.includes('Away'))
        names[key] = `Tiri Tot Under ${this.lineFromKey(key, 'shotsUnder')}`;
      else if (key.startsWith('shotsHomeOver'))
        names[key] = `Tiri Casa Over ${this.lineFromKey(key, 'shotsHomeOver')}`;
      else if (key.startsWith('shotsHomeUnder'))
        names[key] = `Tiri Casa Under ${this.lineFromKey(key, 'shotsHomeUnder')}`;
      else if (key.startsWith('shotsAwayOver'))
        names[key] = `Tiri Osp Over ${this.lineFromKey(key, 'shotsAwayOver')}`;
      else if (key.startsWith('shotsAwayUnder'))
        names[key] = `Tiri Osp Under ${this.lineFromKey(key, 'shotsAwayUnder')}`;
      else if (key.startsWith('shotsOTOver'))
        names[key] = `SOT Over ${this.lineFromKey(key, 'shotsOTOver')}`;
      else if (key.startsWith('shotsOTUnder'))
        names[key] = `SOT Under ${this.lineFromKey(key, 'shotsOTUnder')}`;
      else if (key.startsWith('yellowOver'))
        names[key] = `Gialli Over ${this.lineFromKey(key, 'yellowOver')}`;
      else if (key.startsWith('yellowUnder'))
        names[key] = `Gialli Under ${this.lineFromKey(key, 'yellowUnder')}`;
      else if (key.startsWith('foulsOver'))
        names[key] = `Falli Over ${this.lineFromKey(key, 'foulsOver')}`;
      else if (key.startsWith('foulsUnder'))
        names[key] = `Falli Under ${this.lineFromKey(key, 'foulsUnder')}`;
      else if (key.startsWith('exact_'))
        names[key] = `Risultato Esatto ${key.replace('exact_', '')}`;
      else if (key.startsWith('hcp_'))
        names[key] = `Handicap ${key.replace('hcp_', '')}`;
      else
        names[key] = key;
    }
    return names;
  }

  /** "shotsOver155" → "15.5" */
  private lineFromKey(key: string, prefix: string): string {
    const raw = key.slice(prefix.length);
    if (raw.length <= 1) return raw;
    return raw.slice(0, -1) + '.' + raw.slice(-1);
  }

  private parseStatLine(raw: string): number | null {
    const cleaned = String(raw ?? '').trim().replace(',', '.');
    if (!cleaned) return null;
    if (/^\d+\.\d+$/.test(cleaned)) return Number(cleaned);
    if (/^\d+$/.test(cleaned) && cleaned.length >= 2) {
      const n = Number(`${cleaned.slice(0, -1)}.${cleaned.slice(-1)}`);
      return Number.isFinite(n) ? n : null;
    }
    return null;
  }

  // ==================== VALUTAZIONE BET ====================

  private evaluateBet(selection: string, match: MatchData): boolean {
    const h = match.homeGoals!;
    const a = match.awayGoals!;
    const total = h + a;

    // --- Goal ---
    const goalMap: Record<string, boolean> = {
      homeWin: h > a, draw: h === a, awayWin: a > h,
      btts: h > 0 && a > 0, bttsNo: h === 0 || a === 0,
      over05: total > 0.5, under05: total <= 0.5,
      over15: total > 1.5, under15: total <= 1.5,
      over25: total > 2.5, under25: total <= 2.5,
      over35: total > 3.5, under35: total <= 3.5,
      over45: total > 4.5, under45: total <= 4.5,
    };
    if (selection in goalMap) return goalMap[selection];

    // --- Exact score ---
    if (selection.startsWith('exact_')) {
      const [gh, ga] = selection.replace('exact_', '').split('-').map(Number);
      return h === gh && a === ga;
    }

    // --- Handicap europeo ---
    if (selection.startsWith('hcp_')) {
      const raw = selection.replace('hcp_', '');
      const isHome = raw.startsWith('home');
      const lineStr = raw.replace(/^(home|away)/, '').replace('+', '');
      const line = parseFloat(lineStr);
      if (!isFinite(line)) return false;
      const diff = isHome ? (h - a + line) : (a - h + line);
      return diff > 0;
    }

    // Metodo riutilizzabile per Over/Under su valore numerico
    const evalOU = (val: number | undefined, key: string, overPrefix: string, underPrefix: string): boolean | null => {
      if (val === undefined) return null;
      if (selection.startsWith(overPrefix)) {
        const line = parseFloat(this.lineFromKey(selection, overPrefix));
        return val > line;
      }
      if (selection.startsWith(underPrefix)) {
        const line = parseFloat(this.lineFromKey(selection, underPrefix));
        return val <= line;
      }
      return null;
    };

    // --- Tiri totali ---
    const totalShots = match.homeTotalShots !== undefined && match.awayTotalShots !== undefined
      ? match.homeTotalShots + match.awayTotalShots : undefined;
    let res = evalOU(totalShots, selection, 'shotsOver', 'shotsUnder');
    if (res !== null && !selection.includes('Home') && !selection.includes('Away') && !selection.includes('OT')) return res;

    // --- Tiri casa ---
    res = evalOU(match.homeTotalShots, selection, 'shotsHomeOver', 'shotsHomeUnder');
    if (res !== null) return res;

    // --- Tiri ospite ---
    res = evalOU(match.awayTotalShots, selection, 'shotsAwayOver', 'shotsAwayUnder');
    if (res !== null) return res;

    // --- Tiri in porta totali ---
    const totalSOT = match.homeShotsOnTarget !== undefined && match.awayShotsOnTarget !== undefined
      ? match.homeShotsOnTarget + match.awayShotsOnTarget : undefined;
    res = evalOU(totalSOT, selection, 'shotsOTOver', 'shotsOTUnder');
    if (res !== null) return res;

    // --- Cartellini gialli totali ---
    const totalYellow = match.homeYellowCards !== undefined && match.awayYellowCards !== undefined
      ? match.homeYellowCards + match.awayYellowCards : undefined;
    res = evalOU(totalYellow, selection, 'yellowOver', 'yellowUnder');
    if (res !== null) return res;

    // --- Falli totali ---
    const totalFouls = match.homeFouls !== undefined && match.awayFouls !== undefined
      ? match.homeFouls + match.awayFouls : undefined;
    res = evalOU(totalFouls, selection, 'foulsOver', 'foulsUnder');
    if (res !== null) return res;
    // --- Formati snake_case bookmaker (shots_total_over_235, ecc.) ---
    const prefixed = selection.match(
      /^(shots_total|shots_home|shots_away|sot_total|yellow|fouls|cards_total)_(over|under)_([0-9]+(?:[.,][0-9]+)?)$/i
    );
    if (prefixed) {
      const domain = prefixed[1].toLowerCase();
      const side = prefixed[2].toLowerCase() as 'over' | 'under';
      const line = this.parseStatLine(prefixed[3]);
      if (line === null) return false;

      let actual: number | undefined;
      if (domain === 'shots_total') {
        actual = totalShots;
      } else if (domain === 'shots_home') {
        actual = match.homeTotalShots;
      } else if (domain === 'shots_away') {
        actual = match.awayTotalShots;
      } else if (domain === 'sot_total') {
        actual = totalSOT;
      } else if (domain === 'yellow' || domain === 'cards_total') {
        actual = totalYellow;
      } else if (domain === 'fouls') {
        actual = totalFouls;
      }

      if (actual === undefined) return false;
      return side === 'over' ? actual > line : actual <= line;
    }
    // Selezione non riconosciuta o dato non interpretabile dal parser corrente.
    return false;
  }

  private evaluateBetNullable(selection: string, match: MatchData): boolean | null {
    const s = String(selection ?? '').toLowerCase();
    const requiresShots =
      /^shots(over|under)\d+$/i.test(s) ||
      /^shotshome(over|under)\d+$/i.test(s) ||
      /^shotsaway(over|under)\d+$/i.test(s) ||
      /^shots_total_(over|under)_/i.test(s) ||
      /^shots_home_(over|under)_/i.test(s) ||
      /^shots_away_(over|under)_/i.test(s);
    const requiresSot =
      /^shotsot(over|under)\d+$/i.test(s) ||
      /^sot_total_(over|under)_/i.test(s);
    const requiresYellow =
      /^yellow(over|under)\d+$/i.test(s) ||
      /^cards_total_(over|under)_/i.test(s) ||
      /^yellow_(over|under)_/i.test(s);
    const requiresFouls =
      /^fouls(over|under)\d+$/i.test(s) ||
      /^fouls_(over|under)_/i.test(s);

    if (requiresShots && (match.homeTotalShots === undefined || match.awayTotalShots === undefined)) return null;
    if (requiresSot && (match.homeShotsOnTarget === undefined || match.awayShotsOnTarget === undefined)) return null;
    if (requiresYellow && (match.homeYellowCards === undefined || match.awayYellowCards === undefined)) return null;
    if (requiresFouls && (match.homeFouls === undefined || match.awayFouls === undefined)) return null;

    return this.evaluateBet(selection, match);
  }

  evaluateComboBetOpportunity(
    combo: ComboBetOpportunity,
    matchResults: Record<string, MatchData>
  ): {
    won: boolean;
    allLegsEvaluable: boolean;
    legsResults: Array<{ selection: string; won: boolean | null }>;
  } {
    return evaluateComboBet(
      combo,
      matchResults,
      (selection, matchData) => this.evaluateBetNullable(selection, matchData as MatchData)
    );
  }

  // ==================== METRICHE ====================

  private computeMetrics(
    bets: TestBet[], equity: EquityPoint[],
    trainCount: number, testCount: number,
    attemptedByCategory: Record<string, number> = {},
    voidedByCategory: Record<string, number> = {},
  ): BacktestResult {
    const won         = bets.filter(b => b.won);
    const totalStaked = bets.reduce((s,b) => s+b.stake, 0);
    const totalReturn = bets.reduce((s,b) => s+(b.won?b.stake*b.odds:0), 0);
    const netProfit   = totalReturn - totalStaked;
    const totalVoided = Object.values(voidedByCategory).reduce((sum, value) => sum + value, 0);
    const totalAttempts = bets.length + totalVoided;
    const unevaluableRate = totalAttempts > 0 ? (totalVoided / totalAttempts) * 100 : 0;

    // Market breakdown per categoria
    const breakdown: Record<string, { bets:number; won:number; staked:number; returned:number; oddsSum:number; evSum:number }> = {};
    for (const bet of bets) {
      const cat = bet.marketCategory;
      if (!breakdown[cat]) breakdown[cat] = { bets:0, won:0, staked:0, returned:0, oddsSum:0, evSum:0 };
      breakdown[cat].bets++;
      if (bet.won) breakdown[cat].won++;
      breakdown[cat].staked   += bet.stake;
      breakdown[cat].returned += bet.won ? bet.stake * bet.odds : 0;
      breakdown[cat].oddsSum  += bet.odds;
      breakdown[cat].evSum    += bet.ev;
    }

    const categories = new Set<string>([
      ...Object.keys(breakdown),
      ...Object.keys(attemptedByCategory),
      ...Object.keys(voidedByCategory),
    ]);

    const marketUnevaluableBreakdown: BacktestResult['marketUnevaluableBreakdown'] = {};
    const marketBreakdown: Record<string, MarketStats> = {};
    for (const cat of categories) {
      const d = breakdown[cat] ?? { bets: 0, won: 0, staked: 0, returned: 0, oddsSum: 0, evSum: 0 };
      const voided = Number(voidedByCategory[cat] ?? 0);
      const attempted = Math.max(Number(attemptedByCategory[cat] ?? 0), d.bets + voided);
      const categoryUnevaluableRate = attempted > 0 ? (voided / attempted) * 100 : 0;

      marketBreakdown[cat] = {
        bets:     d.bets,
        voided,
        won:      d.won,
        staked:   d.staked,
        returned: d.returned,
        roi:      d.staked > 0 ? ((d.returned - d.staked) / d.staked) * 100 : 0,
        winRate:  d.bets   > 0 ? (d.won / d.bets) * 100 : 0,
        avgOdds:  d.bets   > 0 ? d.oddsSum / d.bets : 0,
        avgEV:    d.bets   > 0 ? (d.evSum   / d.bets) * 100 : 0,
        unevaluableRate: categoryUnevaluableRate,
      };
      marketUnevaluableBreakdown[cat] = {
        attempted,
        voided,
        unevaluableRate: categoryUnevaluableRate,
      };
    }

    // Sharpe ratio (daily P&L)
    const dailyR: number[] = [];
    for (let i = 1; i < equity.length; i++) {
      if (equity[i-1].bankroll > 0)
        dailyR.push((equity[i].bankroll - equity[i-1].bankroll) / equity[i-1].bankroll);
    }
    const avgR  = dailyR.reduce((s,r)=>s+r,0)/(dailyR.length||1);
    const stdR  = Math.sqrt(dailyR.reduce((s,r)=>s+(r-avgR)**2,0)/(dailyR.length||1));
    const sharpe = stdR > 0 ? (avgR/stdR)*Math.sqrt(252) : 0;

    // Max drawdown
    let peak = this.INITIAL_BANKROLL, maxDD = 0;
    for (const pt of equity) {
      if (pt.bankroll > peak) peak = pt.bankroll;
      const dd = (peak - pt.bankroll) / peak;
      if (dd > maxDD) maxDD = dd;
    }

    const logLoss = bets.length > 0
      ? -bets.reduce((s,b) => {
        const p = b.ourProb, y = b.won ? 1 : 0;
        return s + y*Math.log(Math.max(1e-10,p)) + (1-y)*Math.log(Math.max(1e-10,1-p));
      }, 0) / bets.length
      : 0;

    const brierScore = bets.length > 0
      ? bets.reduce((s,b) => s+(b.ourProb-(b.won?1:0))**2, 0) / bets.length
      : 0;
    const grossWin     = bets.filter(b=>b.profit>0) .reduce((s,b)=>s+b.profit, 0);
    const grossLoss    = Math.abs(bets.filter(b=>b.profit<=0).reduce((s,b)=>s+b.profit, 0));
    const profitFactor = grossLoss>0 ? grossWin/grossLoss : grossWin>0 ? Infinity : 0;

    // ---- edgeNoVig: edge medio modelo vs quote ante-vig (proxy CLV) ----
    // edge_i = ourProb_i - impliedProb_ante_vig_i = ourProb_i - (1 / bookmakerOdds_i)
    // Con quote sintetiche questo è ottimisticamente distorto (il margine
    // è già noto e modellato). Ha significato reale solo con quote di chiusura.
    const edgeNoVig = bets.length > 0
      ? bets.reduce((s, b) => s + (b.ourProb - 1 / b.odds), 0) / bets.length
      : 0;

    // ---- edgeDecayByMonth: edgeNoVig medio per mese in ordine cronologico ----
    const edgeByMonthMap: Record<string, { sum: number; count: number }> = {};
    for (const bet of bets) {
      const key = `${bet.matchDate.getFullYear()}-${String(bet.matchDate.getMonth() + 1).padStart(2, '0')}`;
      if (!edgeByMonthMap[key]) edgeByMonthMap[key] = { sum: 0, count: 0 };
      edgeByMonthMap[key].sum   += bet.ourProb - 1 / bet.odds;
      edgeByMonthMap[key].count += 1;
    }
    const edgeDecayByMonth = Object.entries(edgeByMonthMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, { sum, count }]) => {
        const [yr, mo] = key.split('-').map(Number);
        return { year: yr, month: mo, edgeNoVig: Number((sum / count).toFixed(4)), bets: count };
      });

    // ---- rollingSharpePeriods: Sharpe su finestre fisse di 50 bet ----
    const ROLLING_WINDOW = 50;
    const rollingSharpePeriods: BacktestResult['rollingSharpePeriods'] = [];
    if (bets.length >= ROLLING_WINDOW) {
      for (let start = 0; start + ROLLING_WINDOW <= bets.length; start += ROLLING_WINDOW) {
        const window = bets.slice(start, start + ROLLING_WINDOW);
        const returns = window.map(b => b.profit / b.stake);
        const avgRet  = returns.reduce((s, r) => s + r, 0) / returns.length;
        const stdRet  = Math.sqrt(returns.reduce((s, r) => s + (r - avgRet) ** 2, 0) / returns.length);
        const periodSharpe = stdRet > 0 ? (avgRet / stdRet) * Math.sqrt(ROLLING_WINDOW) : 0;
        rollingSharpePeriods.push({
          periodStart: start + 1,
          periodEnd:   start + ROLLING_WINDOW,
          sharpe:      Number(periodSharpe.toFixed(3)),
        });
      }
    }

    // ---- usedSyntheticOddsOnly: warning se nessuna quota reale disponibile ----
    const usedSyntheticOddsOnly = bets.length > 0 && bets.every(b => b.isSynthetic);
    if (usedSyntheticOddsOnly) {
      console.warn(
        '[Backtest] ATTENZIONE: tutte le quote sono sintetiche. ' +
        'edgeNoVig e Sharpe non riflettono condizioni reali di mercato. ' +
        'Fornire quote storiche di chiusura (Pinnacle/Betfair) per risultati affidabili.'
      );
    }

    return {
      totalMatches:    trainCount + testCount,
      trainingMatches: trainCount,
      testMatches:     testCount,
      betsPlaced:      bets.length,
      voidedBets:      totalVoided,
      unevaluableRate,
      betsWon:         won.length,
      totalStaked, totalReturn, netProfit,
      roi:          totalStaked>0 ? (netProfit/totalStaked)*100 : 0,
      winRate:      bets.length>0  ? (won.length/bets.length)*100 : 0,
      averageOdds:  bets.length > 0 ? bets.reduce((s,b)=>s+b.odds,0)/bets.length : 0,
      averageEV:    bets.length > 0 ? bets.reduce((s,b)=>s+b.ev,  0)/bets.length*100 : 0,
      brierScore, logLoss,
      calibration:  this.computeCalibration(bets),
      equityCurve:  equity,
      monthlyStats: this.computeMonthlyStats(bets),
      sharpeRatio:  sharpe,
      maxDrawdown:  maxDD*100,
      recoveryFactor: maxDD>0 ? netProfit/(maxDD*this.INITIAL_BANKROLL) : 0,
      profitFactor,
      marketBreakdown,
      marketUnevaluableBreakdown,
      edgeNoVig:              Number(edgeNoVig.toFixed(4)),
      edgeDecayByMonth,
      rollingSharpePeriods,
      usedSyntheticOddsOnly,
    };
  }

  /**
   * Calibrazione con isotonic regression e bucket adattivi.
   *
   * PROBLEMI DEI BUCKET FISSI (vecchia implementazione):
   * - Bucket [0.6-0.7] può avere 300 bet, [0.8-1.0] solo 8.
   *   Le frequenze osservate su 8 campioni sono statisticamente inutili.
   * - Non c'è garanzia di monotonia: un modello ben calibrato dovrebbe
   *   avere actualFrequency crescente con predictedAvg. I bucket fissi
   *   non lo impongono e producono inversioni spurie da rumore campionario.
   *
   * SOLUZIONE — due passi:
   *
   * PASSO 1: Bucket adattivi a densità uniforme.
   *   Le bet vengono ordinate per ourProb e divise in N_BUCKETS gruppi
   *   di dimensione uguale (~MIN_BUCKET_SIZE bet ciascuno). Questo
   *   garantisce che ogni bucket abbia abbastanza campioni per una
   *   stima stabile della frequenza osservata.
   *   Se le bet sono poche (< 2×MIN_BUCKET_SIZE) si usa un unico bucket.
   *
   * PASSO 2: Isotonic regression (Pool Adjacent Violators — PAV).
   *   Imposta la monotonia: se bucket[i].actualFreq > bucket[i+1].actualFreq
   *   (inversione), i due bucket vengono fusi e la loro frequenza viene
   *   rimpiazzata dalla media ponderata per count.
   *   Il PAV garantisce che la sequenza finale sia non-decrescente.
   *   Questo è il metodo standard per la calibrazione in ML
   *   (Platt scaling, temperature scaling usano isotonica come base).
   *
   * OUTPUT: array di CalibrationBucket con predictedRange nel formato
   *   "[min%-max%]" basato sui quantili effettivi dei dati, non su
   *   intervalli fissi — più informativo per capire dove il modello
   *   è davvero esposto.
   */
  private computeCalibration(bets: TestBet[]): CalibrationBucket[] {
    if (bets.length === 0) return [];

    const MIN_BUCKET_SIZE = 20;
    const sorted = [...bets].sort((a, b) => a.ourProb - b.ourProb);

    // --- Passo 1: bucket adattivi a densità uniforme ---
    const nBuckets = Math.max(1, Math.floor(sorted.length / MIN_BUCKET_SIZE));
    const bucketSize = Math.ceil(sorted.length / nBuckets);

    interface RawBucket {
      bets: TestBet[];
      predictedAvg: number;
      actualFreq: number;
      count: number;
      minProb: number;
      maxProb: number;
    }

    const rawBuckets: RawBucket[] = [];
    for (let i = 0; i < sorted.length; i += bucketSize) {
      const group = sorted.slice(i, i + bucketSize);
      const count = group.length;
      const predictedAvg = group.reduce((s, b) => s + b.ourProb, 0) / count;
      const actualFreq   = group.filter(b => b.won).length / count;
      rawBuckets.push({
        bets:    group,
        predictedAvg,
        actualFreq,
        count,
        minProb: group[0].ourProb,
        maxProb: group[group.length - 1].ourProb,
      });
    }

    // --- Passo 2: isotonic regression (Pool Adjacent Violators) ---
    // Fondi bucket adiacenti che violano la monotonia fino a convergenza.
    let stable = false;
    while (!stable) {
      stable = true;
      for (let i = 0; i < rawBuckets.length - 1; i++) {
        if (rawBuckets[i].actualFreq > rawBuckets[i + 1].actualFreq) {
          // Inversione: fondi i due bucket
          const merged = [...rawBuckets[i].bets, ...rawBuckets[i + 1].bets];
          const count  = merged.length;
          const predictedAvg = merged.reduce((s, b) => s + b.ourProb, 0) / count;
          const actualFreq   = merged.filter(b => b.won).length / count;
          rawBuckets.splice(i, 2, {
            bets:    merged,
            predictedAvg,
            actualFreq,
            count,
            minProb: rawBuckets[i].minProb,
            maxProb: rawBuckets[i + 1].maxProb,
          });
          stable = false;
          break; // riparti dal check dall'inizio
        }
      }
    }

    return rawBuckets.map(b => ({
      predictedRange:  `${(b.minProb * 100).toFixed(0)}%-${(b.maxProb * 100).toFixed(0)}%`,
      predictedAvg:    Number(b.predictedAvg.toFixed(4)),
      actualFrequency: Number(b.actualFreq.toFixed(4)),
      count:           b.count,
    }));
  }

  private computeMonthlyStats(bets: TestBet[]): MonthlyStats[] {
    const byMonth: Record<string, TestBet[]> = {};
    for (const bet of bets) {
      const key = `${bet.matchDate.getFullYear()}-${bet.matchDate.getMonth()}`;
      (byMonth[key] ??= []).push(bet);
    }
    return Object.entries(byMonth).map(([key, mb]) => {
      const [year, month] = key.split('-').map(Number);
      const staked   = mb.reduce((s,b)=>s+b.stake, 0);
      const returned = mb.reduce((s,b)=>s+(b.won?b.stake*b.odds:0), 0);
      return { year, month:month+1, bets:mb.length, staked, returned,
               profit:returned-staked, roi:staked>0?((returned-staked)/staked)*100:0 };
    }).sort((a,b)=>a.year!==b.year?a.year-b.year:a.month-b.month);
  }

  private emptyResult(trainCount: number, testCount: number): BacktestResult {
    return {
      totalMatches:trainCount+testCount, trainingMatches:trainCount, testMatches:testCount,
      betsPlaced:0, voidedBets:0, unevaluableRate:0, betsWon:0, totalStaked:0, totalReturn:0, netProfit:0,
      roi:0, winRate:0, averageOdds:0, averageEV:0, brierScore:0, logLoss:0,
      calibration:[], equityCurve:[], monthlyStats:[], marketBreakdown:{}, marketUnevaluableBreakdown:{},
      sharpeRatio:0, maxDrawdown:0, recoveryFactor:0, profitFactor:0,
      edgeNoVig:0, edgeDecayByMonth:[], rollingSharpePeriods:[], usedSyntheticOddsOnly:true,
    };
  }
}

