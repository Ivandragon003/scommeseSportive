import React from 'react';
import { render, screen } from '@testing-library/react';
import BestValueCard from './BestValueCard';
import OddsSourceBadge from './OddsSourceBadge';
import StakePlanner from './StakePlanner';
import ValueOpportunitiesTable from './ValueOpportunitiesTable';
import { BestValueOpportunity } from './predictionTypes';

const opportunity: BestValueOpportunity = {
  selection: 'over25',
  selectionLabel: 'Over 2.5 Goal',
  marketName: 'Totali Goal',
  bookmakerOdds: 2.15,
  confidence: 'HIGH',
  marketTier: 'CORE',
  humanSummary: 'Il match ha ritmo e profilo offensivo coerente con un over.',
  humanReasons: ['xG combinati alti', 'Difese concedono occasioni'],
  expectedValue: 7.3,
  edge: 4.1,
  ourProbability: 56.2,
  impliedProbability: 46.5,
  kellyFraction: 1.8,
  suggestedStakePercent: 2.5,
};

describe('predictions UI components', () => {
  test('renderizza bestValueOpportunity con motivi e quota', () => {
    render(
      <BestValueCard
        opportunity={opportunity}
        oddsBadge={{ label: 'Quote reali Eurobet', className: 'pr-badge-green' }}
      />
    );

    expect(screen.getByTestId('best-value-card')).toBeTruthy();
    expect(screen.getByText('Over 2.5 Goal')).toBeTruthy();
    expect(screen.getByText('Quota')).toBeTruthy();
    expect(screen.getByText('2.15')).toBeTruthy();
    expect(screen.getByText('xG combinati alti')).toBeTruthy();
  });

  test('renderizza badge sorgente quote', () => {
    render(<OddsSourceBadge badge={{ label: 'Quote provider secondario', className: 'pr-badge-gold' }} testId="badge" />);

    const badge = screen.getByTestId('badge');
    expect(badge).toBeTruthy();
    expect(badge.textContent).toBe('Quote provider secondario');
  });

  test('mostra stake suggerito sul bankroll', () => {
    render(
      <StakePlanner
        isReplayAnalysis={false}
        bankroll={1000}
        suggestedTotalStake={25}
        maxExposurePct={8}
        maxExposureAmount={80}
        exposureRatio={0.3125}
      />
    );

    expect(screen.getByTestId('stake-planner').textContent).toContain('EUR 1000.00');
    expect(screen.getByTestId('stake-planner').textContent).toContain('EUR 25.00');
    expect(screen.getByText(/Utilizzo cap rischio: 31.3%/i)).toBeTruthy();
  });

  test('gestisce fallback provider e stato eurobet unavailable', () => {
    const noop = () => undefined;
    render(
      <ValueOpportunitiesTable
        opportunities={[]}
        bankroll={1000}
        budgetReady
        isReplayAnalysis={false}
        oddsSource="eurobet_unavailable"
        providerWarning="Provider secondario disponibile solo per confronto interno."
        placedBetKeySet={new Set()}
        replayOutcomeTone="info"
        stakes={{}}
        getStakeKey={() => 'k'}
        getStakeValue={() => 0}
        onStakeChange={noop}
        onBet={noop}
      />
    );

    expect(screen.getByText(/Provider secondario disponibile/i)).toBeTruthy();
    expect(screen.getByText(/Quote Eurobet non disponibili per questa partita/i)).toBeTruthy();
    expect(screen.getByText(/Finche Eurobet non espone il mercato/i)).toBeTruthy();
  });
});
