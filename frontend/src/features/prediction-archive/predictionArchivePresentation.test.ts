import { archiveOdds, confidenceBadge } from './predictionArchivePresentation';

describe('prediction archive presentation', () => {
  test('mostra solo quote prediction con provenienza reale registrata', () => {
    expect(archiveOdds({
      prediction_id: 'real', match_id: 'm1', market: '1x2', selection: 'home',
      odds_at_prediction: 2.1, source: 'odds_api', was_played: 0,
    }).prediction).toBe(2.1);

    expect(archiveOdds({
      prediction_id: 'synthetic', match_id: 'm1', market: '1x2', selection: 'home',
      odds_at_prediction: 4.5, source: 'odds_api_plus_model_completion', was_played: 0,
    }).prediction).toBeNull();
  });

  test('non ricalcola la confidence quando il valore archiviato manca', () => {
    expect(confidenceBadge('HIGH')).toEqual({ label: 'High', tone: 'high' });
    expect(confidenceBadge(null)).toEqual({ label: 'Non classificata', tone: 'unclassified' });
  });
});
