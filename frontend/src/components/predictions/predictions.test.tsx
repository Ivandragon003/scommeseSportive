import React from 'react';
import { render, screen } from '@testing-library/react';
import BestValueCard from './BestValueCard';
import DailySlatePanel from './DailySlatePanel';
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
        oddsSource="odds_api"
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

  test('mostra warning sintetici per Over cartellini, Under goal e No Goal fragili', () => {
    const noop = () => undefined;
    render(
      <ValueOpportunitiesTable
        opportunities={[
          {
            selection: 'yellow_over_3.5',
            marketName: 'Gialli Totali Over 3.5',
            marketCategory: 'yellow_cards',
            bookmakerOdds: 1.9,
            confidence: 'LOW',
            marketTier: 'SECONDARY',
            expectedValue: 12.2,
            edge: 8.1,
            ourProbability: 67,
            impliedProbability: 58.1,
            kellyFraction: 1.1,
            suggestedStakePercent: 0.5,
            dataWarnings: ['over_cards_close_to_line', 'low_disciplinary_risk_for_over_cards'],
          },
          {
            selection: 'under25',
            marketName: 'Under 2.5 Goal',
            marketCategory: 'goal_under',
            bookmakerOdds: 1.85,
            confidence: 'LOW',
            marketTier: 'CORE',
            expectedValue: 8,
            edge: 5,
            ourProbability: 61,
            impliedProbability: 54,
            kellyFraction: 0.8,
            suggestedStakePercent: 0.4,
            dataWarnings: ['under_goals_close_to_line'],
          },
          {
            selection: 'bttsNo',
            marketName: 'Goal/Goal - No',
            marketCategory: 'btts_no',
            bookmakerOdds: 2.05,
            confidence: 'LOW',
            marketTier: 'SECONDARY',
            expectedValue: 9,
            edge: 6,
            ourProbability: 60,
            impliedProbability: 49,
            kellyFraction: 0.9,
            suggestedStakePercent: 0.45,
            dataWarnings: ['btts_no_fragile', 'both_teams_goal_risk'],
          },
        ]}
        bankroll={1000}
        budgetReady
        isReplayAnalysis={false}
        oddsSource="odds_api"
        placedBetKeySet={new Set()}
        replayOutcomeTone="info"
        stakes={{}}
        getStakeKey={(opportunity) => String(opportunity.selection)}
        getStakeValue={() => 0}
        onStakeChange={noop}
        onBet={noop}
      />
    );

    expect(screen.getByText(/Over cartellini fragile/i)).toBeTruthy();
    expect(screen.getByText(/Partita poco disciplinare/i)).toBeTruthy();
    expect(screen.getByText(/Under goal fragile/i)).toBeTruthy();
    expect(screen.getByText(/No Goal fragile/i)).toBeTruthy();
    expect(screen.getByText(/Rischio goal per entrambe/i)).toBeTruthy();
  });

  test('mostra diagnostica sintetica per blending, edge no-vig e dati deboli', () => {
    const noop = () => undefined;
    render(
      <ValueOpportunitiesTable
        opportunities={[
          {
            selection: 'player_p1_sot_over_0_5',
            marketName: 'Player Over 0.5 tiri in porta',
            marketCategory: 'player_shots_ot',
            bookmakerOdds: 2.05,
            confidence: 'MEDIUM',
            marketTier: 'SECONDARY',
            expectedValue: 8.1,
            edge: 3.5,
            edgeNoVig: 5.1,
            ourProbability: 54,
            impliedProbability: 48.8,
            kellyFraction: 0.8,
            suggestedStakePercent: 0.5,
            dataWarnings: ['data_quality_weak', 'market_blending_applied', 'positive_edge_no_vig'],
          },
        ]}
        bankroll={1000}
        budgetReady
        isReplayAnalysis={false}
        oddsSource="odds_api"
        placedBetKeySet={new Set()}
        replayOutcomeTone="info"
        stakes={{}}
        getStakeKey={() => 'diag'}
        getStakeValue={() => 0}
        onStakeChange={noop}
        onBet={noop}
      />
    );

    expect(screen.getByText(/Dati deboli/i)).toBeTruthy();
    expect(screen.getByText(/Probabilita corretta dal mercato/i)).toBeTruthy();
    expect(screen.getByText(/Buon edge no-vig/i)).toBeTruthy();
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

  test('mostra Consigli giornata con pick recommended e motivi di skip', () => {
    render(
      <DailySlatePanel
        slate={{
          competition: 'La Liga',
          date: '2026-05-23',
          generatedAt: '2026-05-23T10:00:00.000Z',
          matchesAnalyzed: 9,
          diagnostics: {},
          recommended: [
            {
              ...opportunity,
              matchId: 'm1',
              match: 'Valencia - Betis',
              homeTeam: 'Valencia',
              awayTeam: 'Betis',
              marketCategory: 'goal_over',
              edgeNoVig: 6.4,
              rankingScore: 0.22,
              slateDiagnostics: { slateRank: 0.31, slatePosition: 1 },
            },
          ],
          skipped: [
            {
              ...opportunity,
              matchId: 'm2',
              match: 'Girona - Elche',
              homeTeam: 'Girona',
              awayTeam: 'Elche',
              slateSkipReason: 'skippedBecauseDailyUnderCap',
            },
          ],
          matchesSkipped: [
            {
              matchId: 'm3',
              match: 'Celta Vigo - Siviglia',
              reason: 'quota_non_disponibile',
            },
          ],
        }}
      />
    );

    expect(screen.getByText('Consigli giornata')).toBeTruthy();
    expect(screen.getByText(/Valencia - Betis/)).toBeTruthy();
    expect(screen.getByText(/Edge no-vig/)).toBeTruthy();
    expect(screen.getByText(/Girona - Elche: cap Under\/No Goal raggiunto/)).toBeTruthy();
    expect(screen.getByText(/Celta Vigo - Siviglia: quota non disponibile/)).toBeTruthy();
  });

  test('mostra empty state quando non ci sono pick giornata solide', () => {
    render(
      <DailySlatePanel
        slate={{
          competition: 'Serie A',
          date: '2026-05-23',
          generatedAt: '2026-05-23T10:00:00.000Z',
          matchesAnalyzed: 5,
          diagnostics: {},
          recommended: [],
          skipped: [],
          matchesSkipped: [],
        }}
      />
    );

    expect(screen.getByText('Consigli giornata')).toBeTruthy();
    expect(screen.getByText(/Nessuna giocata abbastanza solida oggi/i)).toBeTruthy();
  });
});
