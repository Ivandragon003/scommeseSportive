import { ModelFamily, ResearchBet } from './researchTypes';

export type ComparisonPeriod = '7d' | '30d' | '60d' | '90d' | 'all' | 'custom';

export interface ResearchComparisonQuery {
  period: ComparisonPeriod;
  from?: string;
  to?: string;
}

export interface PortfolioPeriodMetrics {
  initialCents?: number | null;
  startEquityCents?: number | null;
  endEquityCents?: number | null;
  profitCents?: number | null;
  roi?: number | null;
  stakeCents?: number | null;
  settledStakeCents?: number | null;
  betCount?: number;
  settledCount?: number;
  openCount?: number;
  wonCount?: number;
  lostCount?: number;
  voidCount?: number;
  halfWonCount?: number;
  halfLostCount?: number;
  maxDrawdown?: number | null;
}

export interface ComparisonPortfolio extends PortfolioPeriodMetrics {
  family: ModelFamily;
  portfolioId: string;
  initialized?: boolean;
  currentEquityCents?: number | null;
  currentAvailableCents?: number | null;
  currentCommittedCents?: number | null;
  equity: Array<{ at: string; equityCents: number }>;
}

export interface PeriodBreakdown {
  label: string;
  A?: PortfolioPeriodMetrics;
  C?: PortfolioPeriodMetrics;
}

export interface ComparisonDecision {
  action: 'BET' | 'ABSTAIN';
  selection?: string;
  market?: string;
  quote?: number | (NonNullable<ResearchBet['quote']> & { odds?: number }) | null;
  bookmaker?: string;
  reason?: string;
}

export interface DecisionComparisonRow {
  matchId: string;
  matchLabel?: string;
  league?: string;
  kickoffAt?: string;
  at: string;
  A?: ComparisonDecision | null;
  C?: ComparisonDecision | null;
}

export interface ComparisonBet extends Omit<ResearchBet, 'quote' | 'matchId' | 'profitCents' | 'settledAt'> {
  matchId: string | null;
  quote?: ResearchBet['quote'] | null;
  profitCents?: number | null;
  settledAt?: string | null;
  family?: ModelFamily;
  bookmaker?: string;
  matchLabel?: string;
  league?: string;
  market?: string;
  kickoffAt?: string;
}

export interface ResearchComparison {
  period: { key: ComparisonPeriod; from: string | null; to: string; timezone: string; label: string };
  portfolios: ComparisonPortfolio[];
  leader: ModelFamily | 'TIE' | null;
  byLeague: PeriodBreakdown[];
  byMarket: PeriodBreakdown[];
  decisionDifferences: {
    comparedCount: number;
    differentCount: number;
    sameCount?: number;
    incompleteCount?: number;
    total: number;
    truncated: boolean;
    rows: DecisionComparisonRow[];
  };
  bets: { total: number; truncated: boolean; rows: ComparisonBet[] };
  semantics?: Record<string, unknown>;
}
