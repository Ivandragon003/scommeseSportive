/**
 * Value Betting Engine
 * Calculates Expected Value (EV) and Kelly Criterion stake sizing
 *
 * EV = (P_estimated * decimal_odd) - 1
 * A bet is +EV if EV > 0 (i.e., our probability > implied probability of bookmaker)
 *
 * Kelly Criterion:
 * f* = (bp - q) / b
 * where: b = decimal_odds - 1, p = our probability, q = 1-p
 *
 * We use Fractional Kelly (typically 1/4 to 1/2 Kelly) to reduce variance
 */

export interface BetOpportunity {
  marketName: string;
  selection: string;
  ourProbability: number;
  bookmakerOdds: number;
  impliedProbability: number;
  expectedValue: number;
  kellyFraction: number;
  suggestedStakePercent: number;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  isValueBet: boolean;
  edge: number; // percentage edge over bookmaker
}

export interface BudgetState {
  userId: string;
  totalBudget: number;
  availableBudget: number;
  totalBets: number;
  totalStaked: number;
  totalWon: number;
  totalLost: number;
  roi: number;
  winRate: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface BetRecord {
  betId: string;
  userId: string;
  matchId: string;
  marketName: string;
  selection: string;
  odds: number;
  stake: number;
  ourProbability: number;
  expectedValue: number;
  status: 'PENDING' | 'WON' | 'LOST' | 'VOID' | 'CASHOUT';
  returnAmount?: number;
  profit?: number;
  placedAt: Date;
  settledAt?: Date;
  notes?: string;
}

export class ValueBettingEngine {
  private readonly MIN_EV_THRESHOLD = 0.02;      // 2% minimum edge
  private readonly MIN_ODDS = 1.30;               // Avoid very short odds
  private readonly MAX_ODDS = 15.0;               // Avoid very long shots
  private readonly KELLY_FRACTION = 0.25;         // Quarter Kelly (conservative)
  private readonly MAX_STAKE_PERCENT = 5.0;       // Max 5% of bankroll per bet
  private readonly MIN_STAKE_PERCENT = 0.5;       // Min 0.5% of bankroll
  private readonly VIGORISH_ESTIMATE = 0.05;      // Estimated bookmaker margin to subtract

  /**
   * Compute Expected Value for a single bet
   * EV = P(win) * (odds - 1) - P(lose) * 1
   * Normalized: EV_rate = P * odds - 1
   */
  computeExpectedValue(probability: number, decimalOdds: number): number {
    if (probability <= 0 || probability >= 1) return -1;
    if (decimalOdds <= 1) return -1;
    return probability * decimalOdds - 1;
  }

  /**
   * Convert decimal odds to implied probability (removes vigorish)
   */
  impliedProbabilityFromOdds(decimalOdds: number): number {
    return 1 / decimalOdds;
  }

  /**
   * Kelly Criterion optimal fraction
   * f* = (b*p - q) / b
   * Applied with fractional Kelly for risk management
   */
  kellyFraction(probability: number, decimalOdds: number): number {
    const b = decimalOdds - 1;  // net odds
    const p = probability;
    const q = 1 - p;

    const fullKelly = (b * p - q) / b;

    // Apply fractional kelly and bounds
    const fractionalKelly = fullKelly * this.KELLY_FRACTION;
    return Math.max(0, Math.min(fractionalKelly, this.MAX_STAKE_PERCENT / 100));
  }

  /**
   * Determine stake percentage based on Kelly + confidence
   */
  computeSuggestedStake(
    probability: number,
    decimalOdds: number,
    ev: number
  ): { stakePercent: number; confidence: 'HIGH' | 'MEDIUM' | 'LOW' } {
    const kelly = this.kellyFraction(probability, decimalOdds) * 100; // as percentage

    let confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    let stakePercent: number;

    if (ev >= 0.08 && probability >= 0.55) {
      confidence = 'HIGH';
      stakePercent = Math.min(this.MAX_STAKE_PERCENT, Math.max(2.5, kelly));
    } else if (ev >= 0.05 && probability >= 0.45) {
      confidence = 'MEDIUM';
      stakePercent = Math.min(3.0, Math.max(1.5, kelly));
    } else {
      confidence = 'LOW';
      stakePercent = Math.min(2.0, Math.max(this.MIN_STAKE_PERCENT, kelly));
    }

    return { stakePercent: parseFloat(stakePercent.toFixed(2)), confidence };
  }

  /**
   * Analyze all betting markets for a match and return value bets
   */
  analyzeMarkets(
    probabilities: Record<string, number>,
    bookmakerOdds: Record<string, number>,
    marketNames: Record<string, string>
  ): BetOpportunity[] {
    const opportunities: BetOpportunity[] = [];

    for (const [key, ourProb] of Object.entries(probabilities)) {
      const odds = bookmakerOdds[key];
      if (!odds || odds < this.MIN_ODDS || odds > this.MAX_ODDS) continue;
      if (!ourProb || ourProb <= 0 || ourProb >= 1) continue;

      const implied = this.impliedProbabilityFromOdds(odds);
      const ev = this.computeExpectedValue(ourProb, odds);
      const edge = ourProb - implied; // raw edge

      // A bet is value if EV > threshold AND our prob > implied prob
      const isValueBet = ev > this.MIN_EV_THRESHOLD && edge > 0;

      if (!isValueBet) continue; // Skip non-value bets

      const { stakePercent, confidence } = this.computeSuggestedStake(ourProb, odds, ev);

      opportunities.push({
        marketName: marketNames[key] ?? key,
        selection: key,
        ourProbability: parseFloat((ourProb * 100).toFixed(2)),
        bookmakerOdds: odds,
        impliedProbability: parseFloat((implied * 100).toFixed(2)),
        expectedValue: parseFloat((ev * 100).toFixed(2)),
        kellyFraction: parseFloat((this.kellyFraction(ourProb, odds) * 100).toFixed(2)),
        suggestedStakePercent: stakePercent,
        confidence,
        isValueBet,
        edge: parseFloat((edge * 100).toFixed(2))
      });
    }

    // Sort by Expected Value descending
    return opportunities.sort((a, b) => b.expectedValue - a.expectedValue);
  }

  /**
   * Validate budget state consistency
   */
  validateBudget(budget: BudgetState): boolean {
    const expectedAvailable = budget.totalBudget + budget.totalWon - budget.totalLost - budget.totalStaked;
    return Math.abs(expectedAvailable - budget.availableBudget) < 0.01;
  }

  /**
   * Update budget after bet settlement
   */
  settleBet(
    budget: BudgetState,
    bet: BetRecord,
    won: boolean,
    returnAmount?: number
  ): { updatedBudget: BudgetState; updatedBet: BetRecord } {
    const updatedBet = { ...bet };
    const updatedBudget = { ...budget };

    if (won) {
      const winAmount = returnAmount ?? bet.stake * bet.odds;
      updatedBet.status = 'WON';
      updatedBet.returnAmount = winAmount;
      updatedBet.profit = winAmount - bet.stake;
      updatedBudget.availableBudget += winAmount;
      updatedBudget.totalWon += winAmount;
    } else {
      updatedBet.status = 'LOST';
      updatedBet.returnAmount = 0;
      updatedBet.profit = -bet.stake;
      updatedBudget.totalLost += bet.stake;
    }

    updatedBet.settledAt = new Date();
    updatedBudget.updatedAt = new Date();

    // Recalculate ROI
    if (updatedBudget.totalStaked > 0) {
      updatedBudget.roi = ((updatedBudget.totalWon - updatedBudget.totalLost - updatedBudget.totalStaked + updatedBudget.totalBudget) / updatedBudget.totalBudget - 1) * 100;
    }

    return { updatedBudget, updatedBet };
  }

  /**
   * Place a new bet - deduct from budget
   */
  placeBet(
    budget: BudgetState,
    stakeAmount: number
  ): BudgetState {
    if (stakeAmount > budget.availableBudget) {
      throw new Error(`Insufficient budget: need €${stakeAmount.toFixed(2)}, have €${budget.availableBudget.toFixed(2)}`);
    }

    return {
      ...budget,
      availableBudget: budget.availableBudget - stakeAmount,
      totalStaked: budget.totalStaked + stakeAmount,
      totalBets: budget.totalBets + 1,
      updatedAt: new Date()
    };
  }
}
