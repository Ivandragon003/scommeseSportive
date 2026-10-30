import { comparativeEquity, confidenceInterval, dateTime, decisionReason, marketLabel, metric, money, percent } from './researchPresentation';

test('i valori mancanti rimangono distinti da zero', () => {
  expect(money(0)).toMatch(/^0,00\s€$/);
  expect(money(undefined)).toBe('Non disponibile');
  expect(metric(null)).toBe('—');
  expect(percent(0)).toBe('0%');
  expect(percent(0.04)).toBe('4%');
  expect(dateTime('invalid')).toBe('Non disponibile');
  expect(dateTime('1')).toBe('Non disponibile');
});

test('il grafico non somma o inventa i patrimoni mancanti', () => {
  expect(comparativeEquity(
    [{ at: '2026-10-27T10:00:00Z', equityCents: 100000 }],
    [{ at: '2026-10-27T12:00:00Z', equityCents: 100900 }],
  )).toEqual([
    { at: '2026-10-27T10:00:00Z', A: 1000 },
    { at: '2026-10-27T12:00:00Z', C: 1009 },
  ]);
});

test('intervalli appaiati richiedono estremi numerici e finiti', () => {
  expect(confidenceInterval({ lower: -0.01, upper: 0.02 })).toBe('[-0,01; 0,02]');
  expect(confidenceInterval([0, Infinity])).toBeNull();
  expect(confidenceInterval(null)).toBeNull();
});

test('le motivazioni diventano frasi leggibili senza mostrare JSON tecnico', () => {
  expect(decisionReason('{"central_ev_below_threshold":4,"insufficient_validation_calibration":2}')).toBe('Valore atteso sotto la soglia richiesta. Campione di validazione insufficiente per stimare il valore prudenziale.');
  expect(decisionReason('virtual_exposure_limit')).toBe('Limite di esposizione del portafoglio raggiunto.');
  expect(decisionReason('{invalid')).toBe('Motivazione non leggibile; consultare il registro tecnico.');
});

test('i nuovi motivi distinguono assenza di consiglio, limiti C ed errori senza mostrare codici inglesi', () => {
  expect([decisionReason('app_no_recommendation'), decisionReason('challenger_no_recommendation')]).toEqual(['Il modello A non ha trovato una giocata da consigliare.', 'Il modello C non ha trovato una giocata da consigliare.']);
  expect(decisionReason('app_prediction_unavailable')).toBe('La previsione del modello A non è disponibile.');
  expect(decisionReason('invalid_app_recommendation_packet')).toBe('Il consiglio del modello A è incompleto o non verificabile.');
  expect(decisionReason('app_recommendation_quote_mismatch')).toBe('La quota del consiglio A non corrisponde alle quote condivise.');
  expect(decisionReason('invalid_app_recommendation_value')).toBe('Probabilità, valore atteso o stake del consiglio A non validi.');
  expect(decisionReason('non_binary_payout_not_supported_by_canonical_engine')).toBe('Mercato non ancora supportato dalla simulazione C.');
  expect(decisionReason('invalid_recommended_stake')).toBe('Stake consigliato non valido: nessuna puntata registrata.');
});

test('i nomi dei mercati corrispondono anche alle chiavi usate dal registro reale', () => {
  expect(marketLabel('shots_on_target')).toBe('Tiri in porta');
  expect(marketLabel('cards_total')).toBe('Cartellini totali');
});
