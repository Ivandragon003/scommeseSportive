export type GoalMarket = '1x2' | 'double_chance' | 'dnb' | 'totals' | 'team_totals' | 'btts' | 'european_handicap' | 'asian_handicap';
export type MarketQuote = {
    selection: string;
    market: GoalMarket;
    side: 'home' | 'away' | 'draw' | 'over' | 'under' | 'yes' | 'no' | '1x' | 'x2' | '12';
    line?: number;
    team?: 'home' | 'away';
    odds: number;
    bookmaker: string;
    source: string;
    capturedAt: string;
    updatedAt?: string;
    /** Observation time is not evidence of the provider's last price update. */
    timestampEvidence?: 'provider_update' | 'observed_snapshot';
};
export type GoalSettlement = {
    status: 'WON' | 'LOST' | 'VOID' | 'HALF_WON' | 'HALF_LOST' | 'UNRESOLVED';
    returnMultiplier: number | null;
};
export type GoalQuoteEvaluation = {
    probability: number;
    win: number;
    loss: number;
    push: number;
    halfWin: number;
    halfLoss: number;
    expectedValue: number;
};
/** Normalize a square joint distribution without mutating the caller's data. */
export declare function normalizeScoreMatrix(matrix: number[][]): number[][];
export declare function settleGoalQuote(quote: MarketQuote, homeGoals: number | null | undefined, awayGoals: number | null | undefined): GoalSettlement;
/** Probability is conditional on the stake shares that win or lose; all-push distributions use 0.5. */
export declare function evaluateGoalQuote(matrix: number[][], quote: MarketQuote): GoalQuoteEvaluation;
/** Flat probability keys match the goal catalog; neither quote selection nor post-match data are consulted. */
export declare function scoreMatrixMarkets(matrix: number[][]): Record<string, number>;
