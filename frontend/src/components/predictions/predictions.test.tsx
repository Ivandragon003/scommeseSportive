import React from 'react';
import { render, screen } from '@testing-library/react';
import BestValueCard from './BestValueCard';
import OddsSourceBadge from './OddsSourceBadge';
import PlayerPropsSection from './PlayerPropsSection';
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
        oddsBadge={{ label: 'Quote bookmaker', className: 'pr-badge-green' }}
      />
    );

    expect(screen.getByTestId('best-value-card')).toBeTruthy();
    expect(screen.getByText('Over 2.5 Goal')).toBeTruthy();
    expect(screen.getByText('Quota')).toBeTruthy();
    expect(screen.getByText('2.15')).toBeTruthy();
    expect(screen.getByText('xG combinati alti')).toBeTruthy();
  });

  test('non mostra 0 percentuali quando le metriche della giocata sono assenti', () => {
    render(
      <BestValueCard
        opportunity={{
          selection: 'cards_under_45',
          selectionLabel: 'Gialli Totali Under 4.5',
          marketName: 'Gialli Totali',
          bookmakerOdds: 1.6,
          confidence: 'HIGH',
          expectedValue: 21.3,
          edge: 13.3,
        }}
        oddsBadge={{ label: 'Quote provider secondario', className: 'pr-badge-gold' }}
      />
    );

    expect(screen.getByTestId('best-value-metric-probabilita-nostra').textContent).toBe('N/D');
    expect(screen.getByTestId('best-value-metric-probabilita-implicita').textContent).toBe('N/D');
    expect(screen.getByTestId('best-value-metric-stake-base').textContent).toBe('N/D');
    expect(screen.queryByText('0.0%')).toBeNull();
    expect(screen.queryByText('0.00%')).toBeNull();
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

  test('gestisce fallback provider e stato quote unavailable', () => {
    const noop = () => undefined;
    render(
      <ValueOpportunitiesTable
        opportunities={[]}
        bankroll={1000}
        budgetReady
        isReplayAnalysis={false}
        oddsSource="odds_unavailable"
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
    expect(screen.getByText(/Quote bookmaker non disponibili per questa partita/i)).toBeTruthy();
    expect(screen.getByText(/Finche il provider non espone il mercato/i)).toBeTruthy();
  });

  test('mostra warning sintetici per Under cartellini fragili', () => {
    const noop = () => undefined;
    render(
      <ValueOpportunitiesTable
        opportunities={[
          {
            selection: 'yellow_under_5.5',
            marketName: 'Gialli Totali Under 5.5',
            marketCategory: 'yellow_cards',
            bookmakerOdds: 1.72,
            confidence: 'LOW',
            marketTier: 'SECONDARY',
            expectedValue: 12.2,
            edge: 8.1,
            ourProbability: 67,
            impliedProbability: 58.1,
            kellyFraction: 1.1,
            suggestedStakePercent: 0.5,
            dataWarnings: [
              'under_cards_close_to_line',
              'high_intensity_match',
              'strict_referee_against_under_cards',
            ],
          },
        ]}
        bankroll={1000}
        budgetReady
        isReplayAnalysis={false}
        oddsSource="eurobet"
        placedBetKeySet={new Set()}
        replayOutcomeTone="info"
        stakes={{}}
        getStakeKey={() => 'cards-under'}
        getStakeValue={() => 0}
        onStakeChange={noop}
        onBet={noop}
      />
    );

    expect(screen.getByText(/Under cartellini fragile/i)).toBeTruthy();
    expect(screen.getByText(/Partita ad alta intensita/i)).toBeTruthy();
    expect(screen.getByText(/Arbitro severo/i)).toBeTruthy();
  });

  test('mostra la sezione Mercati giocatore con warning dati', () => {
    render(
      <PlayerPropsSection
        bankroll={1000}
        opportunities={[
          {
            selection: 'player_understat_player_123_shots_over_1_5',
            marketName: 'Lautaro Martinez Over 1.5 tiri',
            marketCategory: 'player_shots',
            playerName: 'Lautaro Martinez',
            teamName: 'Inter',
            bookmakerOdds: 2.1,
            ourProbability: 64,
            expectedValue: 34.4,
            edgeNoVig: 9.2,
            suggestedStakePercent: 1.2,
            confidence: 'MEDIUM',
            expectedMinutes: 78,
            sampleSize: 18,
            dataWarnings: ['missing_under_price'],
          },
        ]}
      />
    );

    expect(screen.getByText('Mercati giocatore')).toBeTruthy();
    expect(screen.getByText('Tiri')).toBeTruthy();
    expect(screen.getByText('Lautaro Martinez')).toBeTruthy();
    expect(screen.getByText(/Inter - Lautaro Martinez Over 1.5 tiri/)).toBeTruthy();
    expect(screen.getByText(/manca quota opposta/)).toBeTruthy();
    expect(screen.getByText(/EUR 12.00/)).toBeTruthy();
  });
});
