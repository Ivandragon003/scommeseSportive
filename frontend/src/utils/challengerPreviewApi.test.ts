import API from './api';
import { getChallengerPreview, validateChallengerPreview } from './challengerPreviewApi';

jest.mock('./api', () => ({ __esModule: true, default: { post: jest.fn(), get: jest.fn() } }));
const post = API.post as jest.Mock;
const now = Date.parse('2026-10-31T12:00:00Z');
const preview = (changes: Record<string, unknown> = {}) => ({
  kind: 'C_PREVIEW', family: 'C', matchId: 'match-1', asOf: '2026-10-31T11:59:59Z',
  kickoffAt: '2026-10-31T13:00:00Z', expiresAt: '2026-10-31T12:00:29Z',
  modelVersion: 'C906', deploymentRevision: 'fallback', status: 'RECOMMENDED', reason: null,
  suggestedStakePercent: 1, registered: false,
  recommendationPacket: { decisionStatus: 'RECOMMENDED', selected: { selection: 'under25', bookmakerOdds: 3.3, bookmakerName: 'Bookmaker reale' } },
  quote: { selection: 'under25', odds: 3.3, bookmaker: 'Bookmaker reale', source: 'odds_api',
    priceType: 'prematch', capturedAt: '2026-10-31T11:59:58Z', updatedAt: '2026-10-31T11:59:58Z' },
  ...changes,
});

beforeEach(() => { jest.resetAllMocks(); jest.spyOn(Date, 'now').mockReturnValue(now); });
afterEach(() => jest.restoreAllMocks());

test('requests only the dedicated preview route and sanitizes away execution fields', async () => {
  post.mockResolvedValue({ data: { success: true, data: preview({ betId: 'invented', stakeCents: 1000, action: 'BET' }) } });
  const signal = new AbortController().signal;
  const result = await getChallengerPreview('match-1', signal);
  expect(post).toHaveBeenCalledWith('/research/challenger-preview', { matchId: 'match-1' }, { signal, timeout: 45_000 });
  expect(post).toHaveBeenCalledTimes(1);
  expect(API.get).not.toHaveBeenCalled();
  expect(result).toEqual(validateChallengerPreview(preview(), 'match-1', now));
  expect(result).not.toHaveProperty('betId');
  expect(result).not.toHaveProperty('stakeCents');
  expect(result).not.toHaveProperty('action');
});

test.each([
  { family: 'A' }, { matchId: 'wrong' }, { registered: true }, { suggestedStakePercent: 2 },
  { asOf: '2026-10-31T12:01:00Z' }, { status: 'BET' }, { kind: 'execution' },
])('rejects an inconsistent preview identity or provenance (%s)', (change) => {
  expect(() => validateChallengerPreview(preview(change), 'match-1', now)).toThrow();
});

test.each([
  { expiresAt: '2026-10-31T11:59:59Z' }, { kickoffAt: '2026-10-31T11:59:00Z' },
  { expiresAt: null }, { kickoffAt: null },
])('expired or unverifiable eligibility never becomes actionable (%s)', (change) => {
  const result = validateChallengerPreview(preview(change), 'match-1', now);
  expect(result.status).toBe('UNAVAILABLE');
  expect(result.recommendationPacket).toBeNull();
  expect(result.quote).toBeNull();
});

test.each([
  { source: 'odds_api_plus_model_completion' }, { source: 'synthetic' }, { priceType: 'closing' },
  { selection: 'over25' }, { odds: 8 }, { bookmaker: 'Other' },
  { updatedAt: '2026-10-31T11:50:00Z' }, { capturedAt: '2026-10-31T12:00:01Z' },
  { timestampEvidence: 'observed_snapshot' },
])('missing or incoherent quote evidence is unavailable (%s)', (change) => {
  const value = preview();
  const result = validateChallengerPreview({ ...value, quote: { ...value.quote, ...change } }, 'match-1', now);
  expect(result.status).toBe('UNAVAILABLE');
  expect(result.quote).toBeNull();
  expect(result.recommendationPacket).toBeNull();
});

test('a valid no-bet is preserved without invented prices or a positive selection', () => {
  const result = validateChallengerPreview(preview({ status: 'NO_BET', reason: 'challenger_no_recommendation',
    recommendationPacket: { selected: null, decisionStatus: 'NO_BET' }, quote: null }), 'match-1', now);
  expect(result.status).toBe('NO_BET');
  expect(result.quote).toBeNull();
  expect(result.recommendationPacket?.selected).toBeNull();
  expect(() => validateChallengerPreview(preview({ status: 'NO_BET' }), 'match-1', now)).toThrow();
});

test('transport and malformed-response failures remain visible', async () => {
  post.mockRejectedValueOnce(new Error('Network Error'));
  await expect(getChallengerPreview('match-1')).rejects.toThrow('Network Error');
  post.mockResolvedValueOnce({ data: { success: false, error: 'provider URL with secret' } });
  await expect(getChallengerPreview('match-1')).rejects.toThrow('L’anteprima del modello C non è disponibile.');
});
