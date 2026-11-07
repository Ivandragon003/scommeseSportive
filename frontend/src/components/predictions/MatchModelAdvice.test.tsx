import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import API from '../../utils/api';
import { getMatchModelAdvice } from '../../utils/matchModelAdviceApi';
import MatchModelAdvice from './MatchModelAdvice';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
const get = API.get as jest.Mock;
const post = API.post as jest.Mock;
const row = (family: 'A' | 'C', changes: Record<string, unknown> = {}) => ({
  id: `decision-${family}`, matchId: 'match-1', family, authority: 'execution', effective: true,
  modelVersion: family === 'A' ? 'APP-A-frozen' : 'C906-frozen', modelSource: family === 'A' ? 'PredictionService' : 'CatBoost hybrid research pipeline',
  action: 'BET', selection: family === 'A' ? 'homeWin' : 'under25',
  betId: `bet-${family}`, stakeCents: family === 'A' ? 412 : 1014, betStatus: 'PENDING',
  forecastAt: '2026-10-31T11:45:00Z', createdAt: '2026-10-31T11:46:00Z',
  quote: { selection: family === 'A' ? 'homeWin' : 'under25', odds: family === 'A' ? 7.3 : 4.63,
    bookmaker: family === 'A' ? 'Coolbet' : 'Betsson', source: 'odds_api', capturedAt: '2026-10-31T11:44:00Z' },
  recommendationPacket: { decisionStatus: 'RECOMMENDED', selected: { selection: family === 'A' ? 'homeWin' : 'under25',
    bookmakerOdds: family === 'A' ? 7.3 : 4.63 } },
  ...changes,
});
const response = (decisions: unknown[], matchId = 'match-1') => ({ data: { success: true, data: { matchId, decisions } } });
const fallbackA = <section aria-label="Consiglio live A"><h2>Modello A</h2><p>Consiglio A già calcolato</p></section>;
const show = () => render(<MatchModelAdvice matchId="match-1" fallbackA={fallbackA} />);
const c = () => within(screen.getByRole('region', { name: 'Consiglio modello C' }));
const preview = (changes: Record<string, unknown> = {}) => {
  const now = Date.now();
  return { kind: 'C_PREVIEW', family: 'C', matchId: 'match-1', asOf: new Date(now - 1000).toISOString(),
    kickoffAt: new Date(now + 3600_000).toISOString(), expiresAt: new Date(now + 29_000).toISOString(),
    modelVersion: 'C906-preview', deploymentRevision: 'fallback', status: 'RECOMMENDED', reason: null,
    recommendationPacket: { selected: { selection: 'over35', bookmakerOdds: 2.7, bookmakerName: 'Bookmaker anteprima' }, decisionStatus: 'RECOMMENDED' },
    quote: { selection: 'over35', odds: 2.7, bookmaker: 'Bookmaker anteprima', source: 'odds_api', priceType: 'prematch',
      capturedAt: new Date(now - 2000).toISOString(), updatedAt: new Date(now - 2000).toISOString() },
    suggestedStakePercent: 1, registered: false, ...changes };
};
const previewResponse = (changes: Record<string, unknown> = {}) => ({ data: { success: true, data: preview(changes) } });

beforeEach(() => {
  jest.resetAllMocks();
  get.mockResolvedValue(response([row('A'), row('C')]));
  post.mockResolvedValue(previewResponse({ status: 'UNAVAILABLE', reason: 'real_fresh_quotes_unavailable', recommendationPacket: null, quote: null }));
});

test('shows the two own recorded selections, authentic quotes and debited stakes without mutation requests', async () => {
  show();
  const a = within(await screen.findByRole('region', { name: 'Consiglio modello A' }));
  expect(a.getByText('1 - Vittoria Casa')).toBeTruthy();
  expect(a.getByText('Coolbet')).toBeTruthy();
  expect(a.getByText('7,30')).toBeTruthy();
  expect(a.getByText(/^4,12\s€$/)).toBeTruthy();
  expect(c().getByText('Under 2.5 Goal')).toBeTruthy();
  expect(c().getByText('Betsson')).toBeTruthy();
  expect(c().getByText('4,63')).toBeTruthy();
  expect(c().getByText(/^10,14\s€$/)).toBeTruthy();
  expect(a.queryByText('C906-frozen')).toBeNull();
  expect(c().queryByText('APP-A-frozen')).toBeNull();
  expect(get).toHaveBeenCalledTimes(1);
  expect(get).toHaveBeenCalledWith('/research/forecasts', { params: { matchId: 'match-1' }, signal: expect.anything() });
  expect(API.post).not.toHaveBeenCalled();
});

test('absence of archived C requests an independent preview and unavailable prices are never an invented no-bet verdict', async () => {
  get.mockResolvedValueOnce(response([row('A')])); show();
  expect(await screen.findByText('Consiglio non ancora disponibile')).toBeTruthy();
  expect(c().queryByText('Nessuna giocata consigliata')).toBeNull();
  expect(screen.getByRole('region', { name: 'Consiglio modello A' })).toBeTruthy();
  expect(post).toHaveBeenCalledTimes(1);
  expect(post).toHaveBeenCalledWith('/research/challenger-preview', { matchId: 'match-1' }, { signal: expect.anything(), timeout: 45_000 });
});

test('legacy A80 is never used as operational A and the existing A card remains intact', async () => {
  get.mockResolvedValueOnce(response([row('A', { authority: 'legacy', modelVersion: 'A80' }), row('C')])); show();
  expect(await screen.findByText('Under 2.5 Goal')).toBeTruthy();
  expect(screen.queryByText(/C906-frozen/)).toBeNull();
  expect(screen.getByText('Consiglio A già calcolato')).toBeTruthy();
  expect(screen.queryByText(/A80/)).toBeNull();
});

test('a sporting no-bet decision differs from an unavailable forecast', async () => {
  get.mockResolvedValueOnce(response([row('C', { action: 'ABSTAIN', betId: null, stakeCents: null, reason: 'challenger_no_recommendation',
    recommendationPacket: { selected: null, decisionStatus: 'NO_BET' }, quote: null, selection: null })])); show();
  expect(await screen.findByText('Nessuna giocata consigliata')).toBeTruthy();
  expect(c().getByText('Il modello C non ha trovato una giocata da consigliare.')).toBeTruthy();
  expect(c().getByText(/^0,00\s€$/)).toBeTruthy();
  expect(c().queryByText('Consiglio non ancora disponibile')).toBeNull();
});

test.each(['virtual_exposure_limit', 'insufficient_virtual_capital', 'one_bet_per_portfolio_match'])('execution block %s preserves the advice but registers zero', async (reason) => {
  get.mockResolvedValueOnce(response([row('C', { action: 'ABSTAIN', betId: null, reason, stakeCents: 999999 })])); show();
  expect(await screen.findByText('Under 2.5 Goal')).toBeTruthy();
  expect(c().getByText('Il modello ha consigliato questa giocata, ma non è stata registrata.')).toBeTruthy();
  expect(c().getByText(/^0,00\s€$/)).toBeTruthy();
  expect(c().getByText('Nessuna puntata registrata')).toBeTruthy();
  expect(c().queryByText('Nessuna giocata consigliata')).toBeNull();
});

test('a technical abstention cannot present a surviving positive packet as usable advice', async () => {
  get.mockResolvedValueOnce(response([row('C', { action: 'ABSTAIN', betId: null, reason: 'app_recommendation_quote_mismatch' })])); show();
  expect(await screen.findByText('Valutazione non utilizzabile')).toBeTruthy();
  expect(c().queryByText('Under 2.5 Goal')).toBeNull();
  expect(c().queryByText('4,63')).toBeNull();
  expect(c().queryByText('Betsson')).toBeNull();
  expect(c().getByText(/^0,00\s€$/)).toBeTruthy();
});

test('a technical abstention without a packet remains distinct from a sporting no-bet decision', async () => {
  get.mockResolvedValueOnce(response([row('C', { action: 'ABSTAIN', betId: null, recommendationPacket: null,
    reason: 'hybrid_model_unavailable_or_incompatible' })])); show();
  expect(await screen.findByText('Valutazione non utilizzabile')).toBeTruthy();
  expect(c().getByText('Modello C assente o incompatibile.')).toBeTruthy();
  expect(c().queryByText('Nessuna giocata consigliata')).toBeNull();
});

test.each([
  null,
  { selection: 'homeWin', odds: 4.63, bookmaker: 'Betsson', source: 'odds_api' },
  { selection: 'under25', odds: 8, bookmaker: 'Betsson', source: 'odds_api' },
  { selection: 'under25', odds: 4.63, bookmaker: 'Betsson', source: 'odds_api_plus_model_completion' },
])('missing, mismatched or synthetic quotes never become bookmaker evidence (%s)', async (quote) => {
  get.mockResolvedValueOnce(response([row('C', { quote })])); show();
  expect(await screen.findByText('Under 2.5 Goal')).toBeTruthy();
  expect(c().queryByText('4,63')).toBeNull();
  expect(c().queryByText('Betsson')).toBeNull();
  expect(c().getByText('La quota conservata non è disponibile o non corrisponde al consiglio.')).toBeTruthy();
});

test('a malformed C record cannot substitute A or hide the independent valid A record', async () => {
  get.mockResolvedValueOnce(response([row('A'), row('C', { matchId: 'wrong-match' })])); show();
  expect(await screen.findByText('Il consiglio archiviato del modello C non è verificabile.')).toBeTruthy();
  expect(screen.getByRole('region', { name: 'Consiglio modello A' })).toBeTruthy();
  expect(c().queryByText('1 - Vittoria Casa')).toBeNull();
});

test('settled does not mean won and a missing registered stake is never fabricated as zero', async () => {
  get.mockResolvedValueOnce(response([row('C', { stakeCents: null, betStatus: 'SETTLED' })])); show();
  expect(await screen.findByText('Liquidata')).toBeTruthy();
  expect(c().queryByText('Vinta')).toBeNull();
  expect(c().queryByText(/^0,00\s€$/)).toBeNull();
  expect(c().getByText('Non disponibile', {selector:'dd'})).toBeTruthy();
});

test('a failed read keeps existing A visible and can retry without any write', async () => {
  get.mockRejectedValueOnce(new Error('Network Error')); show();
  const retry = await screen.findByRole('button', { name: 'Riprova consigli A/C' });
  expect(screen.getByText('Consiglio A già calcolato')).toBeTruthy();
  expect(c().getByRole('alert')).toBeTruthy();
  fireEvent.click(retry);
  expect(await screen.findByText('Under 2.5 Goal')).toBeTruthy();
  expect(get).toHaveBeenCalledTimes(2);
  expect(API.post).not.toHaveBeenCalled();
});

test('changing matches aborts the first read and late results cannot overwrite the current match', async () => {
  let resolveFirst: (value: unknown) => void;
  get.mockImplementationOnce(() => new Promise((resolve) => { resolveFirst = resolve; }));
  const next = { ...row('C'), matchId: 'match-2', recommendationPacket: { selected: { selection: 'awayWin' }, decisionStatus: 'RECOMMENDED' }, selection: 'awayWin' };
  get.mockResolvedValueOnce(response([next], 'match-2'));
  const view = show();
  const firstSignal = get.mock.calls[0][1].signal;
  view.rerender(<MatchModelAdvice matchId="match-2" fallbackA={fallbackA} />);
  expect(firstSignal.aborted).toBe(true);
  expect(await screen.findByText('2 - Vittoria Ospite')).toBeTruthy();
  await act(async () => resolveFirst(response([row('C')])));
  expect(c().getByText('2 - Vittoria Ospite')).toBeTruthy();
  expect(c().queryByText('Under 2.5 Goal')).toBeNull();
});

test('switching away from a loaded match never displays its C recommendation for the next match', async () => {
  const view = show(); await screen.findByText('Under 2.5 Goal');
  get.mockImplementationOnce(() => new Promise(() => undefined));
  view.rerender(<MatchModelAdvice matchId="match-2" fallbackA={fallbackA} />);
  expect(screen.queryByText('Under 2.5 Goal')).toBeNull();
  expect(c().getByRole('status')).toBeTruthy();
});

test('refresh requests a new effective snapshot even for the same match', async () => {
  const view = show(); await screen.findByText('Under 2.5 Goal');
  get.mockResolvedValueOnce(response([]));
  view.rerender(<MatchModelAdvice matchId="match-1" fallbackA={fallbackA} refreshKey={1} />);
  expect(await screen.findByText('Consiglio non ancora disponibile')).toBeTruthy();
  expect(get).toHaveBeenCalledTimes(2);
  expect(screen.getByText('Consiglio A già calcolato')).toBeTruthy();
});

test('the read boundary rejects another match and malformed successful responses', async () => {
  get.mockResolvedValueOnce(response([], 'wrong-match'));
  await expect(getMatchModelAdvice('match-1')).rejects.toThrow('non sono disponibili');
  get.mockResolvedValueOnce({ data: { success: true, data: { matchId: 'match-1', decisions: {} } } });
  await expect(getMatchModelAdvice('match-1')).rejects.toThrow('non sono disponibili');
});

test('the read boundary never resolves duplicate effective decisions by choosing a random snapshot', async () => {
  get.mockResolvedValueOnce(response([row('C'), row('C', { id: 'another-effective-C' })]));
  const result = await getMatchModelAdvice('match-1');
  expect(result.C).toBeNull(); expect(result.errors.C).toContain('non è verificabile');
  await waitFor(() => expect(API.post).not.toHaveBeenCalled());
});

test('inconsistent packet status cannot turn a stored no-bet into a recommendation', async () => {
  get.mockResolvedValueOnce(response([row('C', { recommendationPacket: { selected: { selection: 'under25' }, decisionStatus: 'NO_BET' } })]));
  const result = await getMatchModelAdvice('match-1');
  expect(result.C).toBeNull(); expect(result.errors.C).toContain('non è verificabile');
});

test('missing forecast time is not silently replaced by the later archival time', async () => {
  get.mockResolvedValueOnce(response([row('C', { forecastAt: null })])); show();
  await screen.findByText('Under 2.5 Goal');
  expect(c().getByText('Valutata il')).toBeTruthy();
  expect(c().getByText('Non disponibile', {selector:'dd'})).toBeTruthy();
});

test('malformed optional quote fields cannot crash the cards or become provenance', async () => {
  get.mockResolvedValueOnce(response([row('C', { quote: { selection: 'under25', odds: 4.63, bookmaker: 'Betsson', source: 123 } })])); show();
  await screen.findByText('Under 2.5 Goal');
  expect(c().queryByText('4,63')).toBeNull();
  expect(c().getByText('La quota conservata non è disponibile o non corrisponde al consiglio.')).toBeTruthy();
});

test('a new C preview is explicitly nonregistered and leaves the recorded A decision intact', async () => {
  get.mockResolvedValueOnce(response([row('A')]));
  post.mockResolvedValueOnce(previewResponse());
  show();
  expect(await screen.findByText('Over 3.5 Goal')).toBeTruthy();
  expect(c().getByText('Valutazione C · nessuna puntata automatica')).toBeTruthy();
  expect(c().getByText('Bookmaker anteprima')).toBeTruthy();
  expect(c().getByText('2,70')).toBeTruthy();
  expect(c().getByText('Nessuna puntata registrata.')).toBeTruthy();
  expect(c().getByText('L’anteprima non registra giocate né addebita il portafoglio.')).toBeTruthy();
  expect(c().queryByText('Importo virtuale registrato')).toBeNull();
  expect(c().queryByText('Decisione Nightly archiviata')).toBeNull();
  expect(screen.getByRole('region', { name: 'Consiglio modello A' }).textContent).toContain('4,12');
  expect(post.mock.calls.map((call) => call[0])).toEqual(['/research/challenger-preview']);
});

test('an archived C abstention always has priority and never starts preview inference', async () => {
  get.mockResolvedValueOnce(response([row('C', { action: 'ABSTAIN', betId: null, reason: 'challenger_no_recommendation',
    recommendationPacket: { selected: null, decisionStatus: 'NO_BET' } })]));
  show(); await screen.findByText('Nessuna giocata consigliata');
  expect(post).not.toHaveBeenCalled();
  expect(c().queryByText('Valutazione C · nessuna puntata automatica')).toBeNull();
});

test('an unreadable or malformed C archive never falls back to a preview', async () => {
  get.mockResolvedValueOnce(response([row('C', { matchId: 'wrong-match' })]));
  show(); await screen.findByText('Il consiglio archiviato del modello C non è verificabile.');
  expect(post).not.toHaveBeenCalled();
});

test('preview no-bet differs from provider unavailability', async () => {
  get.mockResolvedValueOnce(response([]));
  post.mockResolvedValueOnce(previewResponse({ status: 'NO_BET', reason: 'challenger_no_recommendation', quote: null,
    recommendationPacket: { selected: null, decisionStatus: 'NO_BET' } }));
  show();
  expect(await screen.findByText('Nessuna giocata consigliata')).toBeTruthy();
  expect(c().getByText('La valutazione C non ha selezionato una giocata con le quote disponibili.')).toBeTruthy();
  expect(c().queryByText('Bookmaker anteprima')).toBeNull();
});

test.each([
  { finished: true, kickoffAt: new Date(Date.now() + 3600_000).toISOString() },
  { kickoffAt: '2020-01-01T00:00:00Z' }, { kickoffAt: 'unverified' },
])('ineligible client fixture metadata never starts a preview (%s)', async (props) => {
  get.mockResolvedValueOnce(response([]));
  render(<MatchModelAdvice matchId="match-1" fallbackA={fallbackA} {...props} />);
  expect(await screen.findByText('L’anteprima C è disponibile solo prima dell’inizio della partita.')).toBeTruthy();
  expect(post).not.toHaveBeenCalled();
});

test('a failed preview can retry independently without registering any bet', async () => {
  get.mockResolvedValue(response([row('A')]));
  post.mockRejectedValueOnce(new Error('Network Error')).mockResolvedValueOnce(previewResponse());
  show();
  fireEvent.click(await screen.findByRole('button', { name: 'Riprova anteprima C' }));
  expect(await screen.findByText('Over 3.5 Goal')).toBeTruthy();
  expect(post).toHaveBeenCalledTimes(2);
  expect(post.mock.calls.every((call) => call[0] === '/research/challenger-preview')).toBe(true);
  expect(screen.getByRole('region', { name: 'Consiglio modello A' })).toBeTruthy();
});

test('a Nightly decision created during preview is re-read once and replaces the preview', async () => {
  get.mockResolvedValueOnce(response([row('A')])).mockResolvedValueOnce(response([row('A'), row('C')]));
  post.mockResolvedValueOnce(previewResponse({ status: 'ARCHIVED', reason: 'nightly_decision_available', quote: null, recommendationPacket: null }));
  show();
  expect(await screen.findByText('Under 2.5 Goal')).toBeTruthy();
  expect(get).toHaveBeenCalledTimes(2);
  expect(post).toHaveBeenCalledTimes(1);
  expect(c().getByText('Decisione Nightly archiviata')).toBeTruthy();
  expect(c().queryByText('Valutazione C · nessuna puntata automatica')).toBeNull();
});

test('an unreadable newly archived decision does not start an inference loop', async () => {
  get.mockResolvedValue(response([]));
  post.mockResolvedValueOnce(previewResponse({ status: 'ARCHIVED', reason: 'nightly_decision_available', quote: null, recommendationPacket: null }));
  show();
  expect(await screen.findByText('La decisione archiviata non è ancora leggibile. Riprova i consigli della partita.')).toBeTruthy();
  expect(get).toHaveBeenCalledTimes(2);
  expect(post).toHaveBeenCalledTimes(1);
  expect(c().queryByText('Over 3.5 Goal')).toBeNull();
});

test('changing matches aborts pending preview and a late preview cannot overwrite the new C decision', async () => {
  let resolvePreview: (value: unknown) => void;
  get.mockResolvedValueOnce(response([]));
  post.mockImplementationOnce(() => new Promise((resolve) => { resolvePreview = resolve; }));
  const view = show();
  await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
  const previewSignal = post.mock.calls[0][2].signal;
  get.mockResolvedValueOnce(response([{ ...row('C'), matchId: 'match-2' }], 'match-2'));
  view.rerender(<MatchModelAdvice matchId="match-2" fallbackA={fallbackA} />);
  expect(previewSignal.aborted).toBe(true);
  await screen.findByText('Under 2.5 Goal');
  await act(async () => resolvePreview(previewResponse()));
  expect(c().queryByText('Over 3.5 Goal')).toBeNull();
  expect(c().getByText('Under 2.5 Goal')).toBeTruthy();
});

test('an on-screen preview expires without automatic network requests', async () => {
  jest.useFakeTimers();
  try {
    get.mockResolvedValueOnce(response([]));
    post.mockResolvedValueOnce(previewResponse({ expiresAt: new Date(Date.now() + 1000).toISOString() }));
    show();
    await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    expect(c().getByText('Over 3.5 Goal')).toBeTruthy();
    await act(async () => { jest.advanceTimersByTime(1001); });
    expect(c().getByText('Anteprima scaduta')).toBeTruthy();
    expect(c().queryByText('Over 3.5 Goal')).toBeNull();
    expect(c().queryByText('2,70')).toBeNull();
    expect(c().getByRole('button', { name: 'Riprova anteprima C' })).toBeTruthy();
    expect(post).toHaveBeenCalledTimes(1);
  } finally { jest.useRealTimers(); }
});


test('the server expiry can exceed thirty seconds and is honoured exactly without polling', async () => {
  jest.useFakeTimers();
  try {
    get.mockResolvedValueOnce(response([]));
    post.mockResolvedValueOnce(previewResponse({ expiresAt: new Date(Date.now() + 240_000).toISOString() }));
    show(); await act(async () => { await Promise.resolve(); await Promise.resolve(); });
    await act(async () => { jest.advanceTimersByTime(31_000); });
    expect(c().getByText('Over 3.5 Goal')).toBeTruthy();
    await act(async () => { jest.advanceTimersByTime(209_001); });
    expect(c().getByText('Anteprima scaduta')).toBeTruthy();
    expect(c().queryByText('Over 3.5 Goal')).toBeNull(); expect(post).toHaveBeenCalledTimes(1);
  } finally { jest.useRealTimers(); }
});
