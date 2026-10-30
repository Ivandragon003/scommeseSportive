import { render, screen } from '@testing-library/react';
import BestValueCard from './BestValueCard';
import { AutomaticRecommendationPacket, BestValueOpportunity, CanonicalRecommendationPacket, TechnicalRecommendationAbstention } from './predictionTypes';
import {
  canonicalRankedOpportunities, canonicalRecommendationForPrediction, canonicalSuggestedStakeAmount,
  sanitizePredictionForBookmakerOdds,
} from './predictionWorkbenchUtils';

const selected: BestValueOpportunity = { selection: 'homeWin', marketName: '1X2', bookmakerName: 'Real Book',
  bookmakerOdds: 2.15, confidence: 'LOW', suggestedStakePercent: .37, expectedValue: 3, edgeNoVig: 2 };
const strongerLive: BestValueOpportunity = { ...selected, selection: 'awayWin', confidence: 'HIGH', expectedValue: 99 };
const packet = (pick: BestValueOpportunity | null = selected): CanonicalRecommendationPacket => ({
  policyVersion: 'match-page-recommendation-v1', selected: pick, ranked: pick ? [pick] : [],
  decisionStatus: pick ? 'RECOMMENDED' : 'NO_BET', asOf: '2026-10-30T03:07:01Z',
  model: { source: 'PredictionService', version: 'APP-A-example', codeHash: 'code', configHash: 'config', stateHash: 'state' },
  odds: { source: 'odds_api', capturedAt: '2026-10-30T03:07:00Z', bookmakerBySelection: { homeWin: 'Real Book' } },
  probabilities: { raw: { homeWin: .6 }, decision: { homeWin: .55 } },
});
const frozen = (pick: BestValueOpportunity | null = selected): AutomaticRecommendationPacket => ({
  ...packet(pick), actualStakeAmount: pick ? 3.7 : 0, status: pick ? 'OPEN' : 'ABSTAIN', placedAt: '2026-10-30T03:07:02Z',
});

const technicalAbstention: TechnicalRecommendationAbstention = {
  projectionKind: 'technical_abstention', selected: null, ranked: [], decisionStatus: 'NO_BET',
  actualStakeAmount: 0, status: 'ABSTAIN', reason: 'Dati della partita non disponibili al momento della Nightly.',
  asOf: '2026-10-30T03:07:01Z', placedAt: null, model: null, probabilities: null, odds: null, source: null,
  quoteArchived: false, quoteStatus: 'UNAVAILABLE', quoteCapturedAt: null,
};

test('the browser consumes the canonical selection and order without ranking a stronger local opportunity again', () => {
  const prediction = { canonicalRecommendation: { ...packet(), ranked: [selected, strongerLive] },
    valueOpportunities: [strongerLive], bestValueOpportunity: strongerLive };
  expect(canonicalRankedOpportunities(prediction)).toEqual([selected, strongerLive]);
  expect(canonicalRecommendationForPrediction(prediction)?.selected).toBe(selected);
});

test('a frozen A decision overrides a different current price, pick, confidence and manual bankroll', () => {
  const automaticRecommendation = frozen();
  const prediction = { automaticRecommendation, canonicalRecommendation: packet(strongerLive) };
  expect(canonicalRecommendationForPrediction(prediction)).toBe(automaticRecommendation);
  expect(canonicalRankedOpportunities(prediction)).toEqual([selected]);
  expect(canonicalSuggestedStakeAmount(prediction, 999999)).toBe(3.7);
});

test('frozen abstention never falls back to a later positive live recommendation', () => {
  const prediction = { automaticRecommendation: frozen(null), canonicalRecommendation: packet(strongerLive) };
  expect(canonicalRankedOpportunities(prediction)).toEqual([]);
  expect(canonicalSuggestedStakeAmount(prediction, 1000)).toBe(0);
});

test('live advice preserves its suggested percent without applying the manual one-euro minimum', () => {
  expect(canonicalSuggestedStakeAmount({ canonicalRecommendation: packet() }, 10)).toBeCloseTo(.037, 12);
  expect(canonicalRankedOpportunities({})).toEqual([]);
});

test('missing current prices clear live advice while keeping the recorded Nightly decision', () => {
  const automaticRecommendation = frozen();
  const prediction = sanitizePredictionForBookmakerOdds({ canonicalRecommendation: packet(), automaticRecommendation }, 'odds_unavailable');
  expect(prediction.canonicalRecommendation.selected).toBeNull();
  expect(prediction.automaticRecommendation).toBe(automaticRecommendation);
  expect(canonicalRankedOpportunities(prediction)).toEqual([selected]);
});

test('the main card identifies the actual A debit, frozen quote and recorded status', () => {
  render(<BestValueCard opportunity={selected} automaticRecommendation={frozen()}
    oddsBadge={{ label: 'Current market', className: 'pr-badge-green' }} />);
  expect(screen.getByLabelText('Decisione Nightly A').textContent).toMatch(/Importo registrato: EUR 3.70/);
  expect(screen.getByText(/prezzo archiviato, non quota corrente/)).toBeTruthy();
  expect(screen.getByText('Quota archiviata: Real Book')).toBeTruthy();
  expect(screen.getByTestId('best-value-metric-puntata-suggerita').textContent).toBe('EUR 3.70');
  expect(screen.getByLabelText('Decisione Nightly A').textContent).toMatch(/In corso/);
});

test('a recorded abstention is shown honestly without an amount or a made-up current price', () => {
  render(<BestValueCard opportunity={null} automaticRecommendation={frozen(null)}
    oddsBadge={{ label: 'Quota non disponibile', className: 'pr-badge-gray' }} />);
  expect(screen.getByText('Nessuna giocata consigliata')).toBeTruthy();
  expect(screen.getByLabelText('Decisione Nightly A').textContent).toMatch(/EUR 0.00/);
  expect(screen.getByLabelText('Decisione Nightly A').textContent).toMatch(/Nessuna puntata/);
});

test('technical abstention with unknown model and quotes stays authoritative over a current positive forecast', () => {
  const prediction = { automaticRecommendation: technicalAbstention, canonicalRecommendation: packet(strongerLive) };
  expect(canonicalRecommendationForPrediction(prediction)).toBe(technicalAbstention);
  expect(canonicalRankedOpportunities(prediction)).toEqual([]);
  expect(canonicalSuggestedStakeAmount(prediction, 1000)).toBe(0);
  expect(technicalAbstention.model).toBeNull();
});

test('technical abstention renders its real reason and zero A debit without accessing a missing quote packet', () => {
  render(<BestValueCard opportunity={strongerLive} automaticRecommendation={technicalAbstention}
    oddsBadge={{ label: 'Current live price available', className: 'pr-badge-green' }} />);
  expect(screen.getByText('Valutazione Nightly non completata')).toBeTruthy();
  expect(screen.getByLabelText('Decisione Nightly A').textContent).toContain(technicalAbstention.reason);
  expect(screen.getByLabelText('Decisione Nightly A').textContent).toContain('EUR 0.00');
  expect(screen.getByText('Quota Nightly non disponibile')).toBeTruthy();
  expect(screen.queryByTestId('best-value-metric-quota-bookmaker')).toBeNull();
  expect(screen.queryByText(/prezzo archiviato, non quota corrente/)).toBeNull();
});

test('the main card translates a recorded technical reason with the common presentation formatter', () => {
  render(<BestValueCard opportunity={null} automaticRecommendation={{ ...technicalAbstention, reason: 'app_prediction_unavailable' }}
    oddsBadge={{ label: 'Quota non disponibile', className: 'pr-badge-gray' }} />);
  expect(screen.getByLabelText('Decisione Nightly A').textContent).toContain('La previsione del modello A non è disponibile.');
  expect(screen.getByLabelText('Decisione Nightly A').textContent).not.toContain('app_prediction_unavailable');
});
