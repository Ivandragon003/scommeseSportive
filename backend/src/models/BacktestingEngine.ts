/**
 * Backtesting Engine
 * Validates the prediction model on historical data
 *
 * Methodology:
 * 1. Split data into training (70%) and test (30%) sets chronologically
 * 2. Fit model on training data
 * 3. Simulate bets on test data using historical odds
 * 4. Compute metrics: ROI, Brier Score, calibration, Sharpe ratio
 *
 * Key metrics:
 * - ROI: Return on Investment
 * - Brier Score: measures probabilistic accuracy (lower = better)
 * - Log Loss: cross-entropy loss on predictions
 * - Calibration: how well predicted probabilities match actual frequencies
 * - Sharpe Ratio: risk-adjusted return
 */

import { DixonColesModel, MatchData, FullMatchProbabilities } from './DixonColesModel';
import { ValueBettingEngine, BetOpportunity } from './ValueBettingEngine';

export interface BacktestResult {
  totalMatches: number;
  trainingMatches: number;
  testMatches: number;
  betsPlaced: number;
  betsWon: number;
  totalStaked: number;
  totalReturn: number;
  netProfit: number;
  roi: number;
  winRate: number;
  averageOdds: number;
  averageEV: number;
  brierScoreGoals: number;
  logLoss: number;
  calibration: CalibrationBucket[];
  equityCurve: EquityPoint[];
  monthlyStats: MonthlyStats[];
  sharpeRatio: number;
  maxDrawdown: number;
  recoveryFactor: number;
  profitFactor: number;
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

interface TestBet {
  matchDate: Date;
  market: string;
  selection: string;
  odds: number;
  stake: number;
  ourProb: number;
  ev: number;
  won: boolean;
  profit: number;
}

export class BacktestingEngine {
  private model: DixonColesModel;
  private engine: ValueBettingEngine;
  private readonly INITIAL_BANKROLL = 1000;

  constructor() {
    this.model = new DixonColesModel();
    this.engine = new ValueBettingEngine();
  }

  /**
   * Run full backtest
   * @param matches Historical match data with goals
   * @param historicalOdds Map of matchId -> market -> odds
   * @param trainRatio Fraction of data to use for training
   */
  runBacktest(
    matches: MatchData[],
    historicalOdds: Record<string, Record<string, number>>,
    trainRatio: number = 0.7
  ): BacktestResult {
    // Sort by date
    const sorted = [...matches].sort((a, b) => a.date.getTime() - b.date.getTime());
    const splitIdx = Math.floor(sorted.length * trainRatio);

    const trainMatches = sorted.slice(0, splitIdx);
    const testMatches = sorted.slice(splitIdx);

    // Get all teams
    const teams = [...new Set(sorted.flatMap(m => [m.homeTeamId, m.awayTeamId]))];

    // Fit model on training data
    console.log(`Fitting model on ${trainMatches.length} training matches...`);
    this.model.fitModel(trainMatches, teams);

    // Run simulation on test data
    const bets: TestBet[] = [];
    let bankroll = this.INITIAL_BANKROLL;
    const equityCurve: EquityPoint[] = [
      { date: testMatches[0]?.date ?? new Date(), matchNumber: 0, bankroll, profit: 0, cumulativeROI: 0 }
    ];

    for (let i = 0; i < testMatches.length; i++) {
      const match = testMatches[i];
      if (match.homeGoals === undefined || match.awayGoals === undefined) continue;

      // Compute our probabilities
      const probs = this.model.computeFullProbabilities(
        match.homeTeamId,
        match.awayTeamId,
        match.homeXG,
        match.awayXG
      );

      // Build flat probability map
      const probMap = this.flattenProbabilities(probs);
      const marketNames = this.buildMarketNames();
      const odds = historicalOdds[match.matchId] ?? this.generateSyntheticOdds(match.matchId, probMap);

      // Find value bets
      const opportunities = this.engine.analyzeMarkets(probMap, odds, marketNames);

      for (const opp of opportunities.slice(0, 3)) { // Max 3 bets per match
        const stakeAmount = (bankroll * opp.suggestedStakePercent) / 100;
        if (stakeAmount > bankroll || stakeAmount < 1) continue;

        const won = this.evaluateBet(opp.selection, match);
        const returnAmount = won ? stakeAmount * opp.bookmakerOdds : 0;
        const profit = returnAmount - stakeAmount;

        bankroll += profit;
        bets.push({
          matchDate: match.date,
          market: opp.marketName,
          selection: opp.selection,
          odds: opp.bookmakerOdds,
          stake: stakeAmount,
          ourProb: opp.ourProbability / 100,
          ev: opp.expectedValue / 100,
          won,
          profit
        });
      }

      equityCurve.push({
        date: match.date,
        matchNumber: i + 1,
        bankroll,
        profit: bankroll - this.INITIAL_BANKROLL,
        cumulativeROI: ((bankroll - this.INITIAL_BANKROLL) / this.INITIAL_BANKROLL) * 100
      });
    }

    return this.computeMetrics(bets, equityCurve, trainMatches.length, testMatches.length, testMatches);
  }

  private deterministicNoise(seed: string): number {
    let h = 2166136261;
    for (let i = 0; i < seed.length; i++) {
      h ^= seed.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    const normalized = (h >>> 0) / 4294967295; // [0, 1]
    return (normalized - 0.5) * 2; // [-1, 1]
  }

  private generateSyntheticOdds(matchId: string, probs: Record<string, number>): Record<string, number> {
    const markets = ['homeWin', 'draw', 'awayWin', 'btts', 'bttsNo', 'over25', 'under25', 'over15', 'over35', 'over45'];
    const odds: Record<string, number> = {};

    for (const market of markets) {
      const p = probs[market];
      if (!p || p <= 0.01 || p >= 0.99) continue;

      const fairOdds = 1 / p;
      const margin = 1.06; // bookmaker margin proxy
      const noise = this.deterministicNoise(`${matchId}:${market}`); // deterministic jitter
      const noisy = fairOdds * margin * (1 + noise * 0.12);
      const bounded = Math.max(1.25, Math.min(14, noisy));
      odds[market] = parseFloat(bounded.toFixed(3));
    }

    return odds;
  }

  private flattenProbabilities(probs: FullMatchProbabilities): Record<string, number> {
    const flat: Record<string, number> = {
      homeWin: probs.homeWin,
      draw: probs.draw,
      awayWin: probs.awayWin,
      btts: probs.btts,
      bttsNo: 1 - probs.btts,
      over25: probs.over25,
      under25: probs.under25,
      over15: probs.over15,
      under15: probs.under15,
      over35: probs.over35,
      under35: probs.under35,
      over45: probs.over45,
      under45: probs.under45,
    };

    for (const [k, v] of Object.entries(probs.exactScore)) {
      flat[`exact_${k}`] = v as number;
    }
    for (const [k, v] of Object.entries(probs.handicap)) {
      flat[`hcp_${k}`] = v as number;
    }

    return flat;
  }

  private buildMarketNames(): Record<string, string> {
    return {
      homeWin: 'Esito - 1',
      draw: 'Esito - X',
      awayWin: 'Esito - 2',
      btts: 'Goal Goal',
      bttsNo: 'No Goal Goal',
      over25: 'Over 2.5 Goal',
      under25: 'Under 2.5 Goal',
      over15: 'Over 1.5 Goal',
      over35: 'Over 3.5 Goal',
      over45: 'Over 4.5 Goal',
    };
  }

  private evaluateBet(selection: string, match: MatchData): boolean {
    const h = match.homeGoals!;
    const a = match.awayGoals!;
    const total = h + a;

    switch (selection) {
      case 'homeWin': return h > a;
      case 'draw': return h === a;
      case 'awayWin': return a > h;
      case 'btts': return h > 0 && a > 0;
      case 'bttsNo': return h === 0 || a === 0;
      case 'over05': return total > 0.5;
      case 'over15': return total > 1.5;
      case 'over25': return total > 2.5;
      case 'over35': return total > 3.5;
      case 'over45': return total > 4.5;
      case 'under05': return total < 0.5;
      case 'under15': return total < 1.5;
      case 'under25': return total < 2.5;
      case 'under35': return total < 3.5;
      case 'under45': return total < 4.5;
      default:
        if (selection.startsWith('exact_')) {
          const parts = selection.replace('exact_', '').split('-');
          return h === parseInt(parts[0]) && a === parseInt(parts[1]);
        }
        return false;
    }
  }

  private computeMetrics(
    bets: TestBet[],
    equity: EquityPoint[],
    trainCount: number,
    testCount: number,
    testMatches: MatchData[]
  ): BacktestResult {
    if (bets.length === 0) {
      return this.emptyResult(trainCount, testCount);
    }

    const won = bets.filter(b => b.won);
    const totalStaked = bets.reduce((s, b) => s + b.stake, 0);
    const totalReturn = bets.reduce((s, b) => s + (b.won ? b.stake * b.odds : 0), 0);
    const netProfit = totalReturn - totalStaked;

    // Calibration buckets
    const calibration = this.computeCalibration(bets);

    // Monthly stats
    const monthlyStats = this.computeMonthlyStats(bets);

    // Sharpe Ratio (daily returns)
    const dailyReturns: number[] = [];
    for (let i = 1; i < equity.length; i++) {
      if (equity[i-1].bankroll > 0) {
        dailyReturns.push((equity[i].bankroll - equity[i-1].bankroll) / equity[i-1].bankroll);
      }
    }

    const avgReturn = dailyReturns.reduce((s, r) => s + r, 0) / (dailyReturns.length || 1);
    const stdReturn = Math.sqrt(
      dailyReturns.reduce((s, r) => s + Math.pow(r - avgReturn, 2), 0) / (dailyReturns.length || 1)
    );
    const sharpeRatio = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(252) : 0;

    // Max drawdown
    let peak = this.INITIAL_BANKROLL;
    let maxDrawdown = 0;
    for (const point of equity) {
      if (point.bankroll > peak) peak = point.bankroll;
      const drawdown = (peak - point.bankroll) / peak;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }

    // Log loss
    const logLoss = -bets.reduce((s, b) => {
      const p = b.ourProb;
      const y = b.won ? 1 : 0;
      return s + (y * Math.log(Math.max(1e-10, p)) + (1-y) * Math.log(Math.max(1e-10, 1-p)));
    }, 0) / bets.length;

    // Brier score
    const brierScore = bets.reduce((s, b) => {
      return s + Math.pow(b.ourProb - (b.won ? 1 : 0), 2);
    }, 0) / bets.length;

    // Profit factor
    const grossWin = bets.filter(b => b.profit > 0).reduce((s, b) => s + b.profit, 0);
    const grossLoss = Math.abs(bets.filter(b => b.profit <= 0).reduce((s, b) => s + b.profit, 0));
    const profitFactor = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0;

    return {
      totalMatches: trainCount + testCount,
      trainingMatches: trainCount,
      testMatches: testCount,
      betsPlaced: bets.length,
      betsWon: won.length,
      totalStaked,
      totalReturn,
      netProfit,
      roi: totalStaked > 0 ? (netProfit / totalStaked) * 100 : 0,
      winRate: bets.length > 0 ? (won.length / bets.length) * 100 : 0,
      averageOdds: bets.reduce((s, b) => s + b.odds, 0) / bets.length,
      averageEV: bets.reduce((s, b) => s + b.ev, 0) / bets.length * 100,
      brierScoreGoals: brierScore,
      logLoss,
      calibration,
      equityCurve: equity,
      monthlyStats,
      sharpeRatio,
      maxDrawdown: maxDrawdown * 100,
      recoveryFactor: maxDrawdown > 0 ? netProfit / (maxDrawdown * this.INITIAL_BANKROLL) : 0,
      profitFactor
    };
  }

  private computeCalibration(bets: TestBet[]): CalibrationBucket[] {
    const buckets = [
      { min: 0, max: 0.1, label: '0-10%' },
      { min: 0.1, max: 0.2, label: '10-20%' },
      { min: 0.2, max: 0.3, label: '20-30%' },
      { min: 0.3, max: 0.4, label: '30-40%' },
      { min: 0.4, max: 0.5, label: '40-50%' },
      { min: 0.5, max: 0.6, label: '50-60%' },
      { min: 0.6, max: 0.7, label: '60-70%' },
      { min: 0.7, max: 0.8, label: '70-80%' },
      { min: 0.8, max: 1.0, label: '80-100%' },
    ];

    return buckets.map(b => {
      const inBucket = bets.filter(bet => bet.ourProb >= b.min && bet.ourProb < b.max);
      const won = inBucket.filter(bet => bet.won).length;
      return {
        predictedRange: b.label,
        predictedAvg: inBucket.length > 0 ?
          inBucket.reduce((s, bet) => s + bet.ourProb, 0) / inBucket.length : (b.min + b.max) / 2,
        actualFrequency: inBucket.length > 0 ? won / inBucket.length : 0,
        count: inBucket.length
      };
    });
  }

  private computeMonthlyStats(bets: TestBet[]): MonthlyStats[] {
    const byMonth: Record<string, TestBet[]> = {};

    for (const bet of bets) {
      const key = `${bet.matchDate.getFullYear()}-${bet.matchDate.getMonth()}`;
      if (!byMonth[key]) byMonth[key] = [];
      byMonth[key].push(bet);
    }

    return Object.entries(byMonth).map(([key, monthBets]) => {
      const [year, month] = key.split('-').map(Number);
      const staked = monthBets.reduce((s, b) => s + b.stake, 0);
      const returned = monthBets.reduce((s, b) => s + (b.won ? b.stake * b.odds : 0), 0);
      return {
        year, month: month + 1,
        bets: monthBets.length,
        staked,
        returned,
        profit: returned - staked,
        roi: staked > 0 ? ((returned - staked) / staked) * 100 : 0
      };
    }).sort((a, b) => a.year !== b.year ? a.year - b.year : a.month - b.month);
  }

  private emptyResult(trainCount: number, testCount: number): BacktestResult {
    return {
      totalMatches: trainCount + testCount,
      trainingMatches: trainCount,
      testMatches: testCount,
      betsPlaced: 0, betsWon: 0,
      totalStaked: 0, totalReturn: 0, netProfit: 0,
      roi: 0, winRate: 0, averageOdds: 0, averageEV: 0,
      brierScoreGoals: 0, logLoss: 0,
      calibration: [], equityCurve: [], monthlyStats: [],
      sharpeRatio: 0, maxDrawdown: 0, recoveryFactor: 0, profitFactor: 0
    };
  }
}
