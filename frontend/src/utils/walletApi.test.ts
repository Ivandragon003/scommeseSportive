import API from './api';
import { getAppWallets, getWalletArchive } from './walletApi';
import { ComparisonBet, ResearchComparison } from '../features/research/researchComparisonTypes';

jest.mock('./api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
const get = API.get as jest.Mock;
const post = API.post as jest.Mock;
const query = { period: 'all' as const };

const fixture = (): ResearchComparison => ({
  period: { key: 'all', from: null, to: '2026-10-30T15:00:00.000Z', timezone: 'Europe/Rome', label: 'Intera simulazione' },
  portfolios: [
    { family: 'A', portfolioId: 'shadow_A', initialCents: 100000, currentEquityCents: 100000, currentAvailableCents: 95580, currentCommittedCents: 4420, betCount: 3, equity: [] },
    { family: 'C', portfolioId: 'shadow_C', initialCents: 100000, currentEquityCents: 100000, currentAvailableCents: 98000, currentCommittedCents: 2000, betCount: 2, equity: [] },
  ],
  leader: 'TIE', byLeague: [], byMarket: [],
  decisionDifferences: { comparedCount: 5, differentCount: 4, total: 4, truncated: false, rows: [] },
  bets: { total: 5, truncated: false, rows: [420, 1800, 2200, 1000, 1000].map<ComparisonBet>((stakeCents, index) => ({
    id: `funded-${index}`, family: index < 3 ? 'A' : 'C', portfolioId: index < 3 ? 'shadow_A' : 'shadow_C',
    matchId: `match-${index}`, modelVersion: index < 3 ? 'APP-A-recorded' : 'C-recorded', selection: 'over25',
    market: 'goals_ou', stakeCents, odds: [8, 2.14, 1.93, 2.9, 2.94][index], status: 'PENDING',
    createdAt: '2026-10-30T14:17:00.000Z', quote: { bookmaker: index < 3 ? 'Codere (IT)' : 'Betsson', source: 'odds_api' },
  })) },
});

beforeEach(() => jest.resetAllMocks());

test('reads the wallet endpoint once and preserves all registered data and the server label', async () => {
  const data = fixture(); const before = JSON.stringify(data); const signal = new AbortController().signal;
  get.mockResolvedValueOnce({ data: { success: true, data } });
  const result = await getAppWallets(query, signal);
  expect(get).toHaveBeenCalledTimes(1);
  expect(get).toHaveBeenCalledWith('/wallets', { params: query, signal });
  expect(result).toBe(data);
  expect(JSON.stringify(result)).toBe(before);
  expect(result.bets.rows.map((bet) => bet.stakeCents)).toEqual([420, 1800, 2200, 1000, 1000]);
  expect(result.bets.rows.map((bet) => bet.odds)).toEqual([8, 2.14, 1.93, 2.9, 2.94]);
  expect(post).not.toHaveBeenCalled();
});

test.each([401, 403, 404, 429, 500, 502, 503, undefined])('propagates HTTP %s or network failure without another endpoint', async (status) => {
  const failure = status === undefined ? new Error('Network Error') : { response: { status } };
  get.mockRejectedValueOnce(failure);
  await expect(getAppWallets(query)).rejects.toBe(failure);
  expect(get).toHaveBeenCalledTimes(1);
  expect(post).not.toHaveBeenCalled();
});

test('forwards cancellation without retry or mutation', async () => {
  const controller = new AbortController(); controller.abort();
  const failure = new Error('canceled'); get.mockRejectedValueOnce(failure);
  await expect(getAppWallets(query, controller.signal)).rejects.toBe(failure);
  expect(get).toHaveBeenCalledWith('/wallets', { params: query, signal: controller.signal });
  expect(get).toHaveBeenCalledTimes(1);
  expect(post).not.toHaveBeenCalled();
});

test('preserves an explicit server error', async () => {
  get.mockResolvedValueOnce({ data: { success: false, error: 'Contabilità non disponibile' } });
  await expect(getAppWallets(query)).rejects.toThrow('Contabilità non disponibile');
  expect(get).toHaveBeenCalledTimes(1);
});

test.each([null, undefined, {}, { success: false }, { success: true, data: null }, { success: 'true', data: fixture() }])(
  'rejects missing or unsuccessful envelopes without showing empty balances', async (body) => {
    get.mockResolvedValueOnce({ data: body });
    await expect(getAppWallets(query)).rejects.toThrow('Portafogli e giocate non disponibili.');
    expect(get).toHaveBeenCalledTimes(1);
    expect(post).not.toHaveBeenCalled();
  },
);

test.each([
  ['missing collections', {}],
  ['paper accounting envelope', { ...fixture(), accountingMode: 'PAPER_FIXED_UNIT' }],
  ['paper identifier in euro rows', { ...fixture(), bets: { ...fixture().bets, rows: [{ ...fixture().bets.rows[0], id: 'paper:old' }] } }],
  ['paper accounting in euro rows', { ...fixture(), bets: { ...fixture().bets, rows: [{ ...fixture().bets.rows[0], accountingMode: 'PAPER_FIXED_UNIT' }] } }],
  ['invalid period', { ...fixture(), period: { ...fixture().period, key: 'invalid' } }],
  ['negative total', { ...fixture(), bets: { ...fixture().bets, total: -1 } }],
  ['fractional total', { ...fixture(), bets: { ...fixture().bets, total: 5.5 } }],
  ['detail count exceeds total', { ...fixture(), bets: { ...fixture().bets, total: 1 } }],
  ['null portfolio', { ...fixture(), portfolios: [null] }],
  ['null bet', { ...fixture(), bets: { ...fixture().bets, rows: [null] } }],
  ['invalid equity point', { ...fixture(), portfolios: [{ ...fixture().portfolios[0], equity: [null] }] }],
  ['string balance', { ...fixture(), portfolios: [{ ...fixture().portfolios[0], currentAvailableCents: '1000' }] }],
  ['nonfinite balance', { ...fixture(), portfolios: [{ ...fixture().portfolios[0], currentAvailableCents: Infinity }] }],
  ['fractional cents', { ...fixture(), bets: { ...fixture().bets, rows: [{ ...fixture().bets.rows[0], stakeCents: 10.5 }] } }],
  ['nonfinite price', { ...fixture(), bets: { ...fixture().bets, rows: [{ ...fixture().bets.rows[0], odds: NaN }] } }],
  ['object match label', { ...fixture(), bets: { ...fixture().bets, rows: [{ ...fixture().bets.rows[0], matchLabel: {} }] } }],
  ['object match identifier', { ...fixture(), bets: { ...fixture().bets, rows: [{ ...fixture().bets.rows[0], matchId: {} }] } }],
  ['object bookmaker', { ...fixture(), bets: { ...fixture().bets, rows: [{ ...fixture().bets.rows[0], quote: { bookmaker: {} } }] } }],
  ['object bet count', { ...fixture(), portfolios: [{ ...fixture().portfolios[0], betCount: {} }] }],
  ['nonfinite ROI', { ...fixture(), portfolios: [{ ...fixture().portfolios[0], roi: Infinity }] }],
])('rejects malformed wallet data: %s', async (_label, data) => {
  get.mockResolvedValueOnce({ data: { success: true, data } });
  await expect(getAppWallets(query)).rejects.toThrow('Risposta dei portafogli non valida.');
  expect(get).toHaveBeenCalledTimes(1);
  expect(post).not.toHaveBeenCalled();
});

test('keeps missing balances unavailable and accepts an empty funded ledger without inventing funds', async () => {
  const data = fixture();
  data.portfolios = [{ ...data.portfolios[0], initialized: false, initialCents: null,
    currentAvailableCents: null, currentCommittedCents: null, currentEquityCents: null }];
  data.bets = { total: 0, truncated: false, rows: [] };
  get.mockResolvedValueOnce({ data: { success: true, data } });
  expect(await getAppWallets(query)).toBe(data);
  expect(data.portfolios[0].currentAvailableCents).toBeNull();
  expect(post).not.toHaveBeenCalled();
});

test('preserves a settled partial loss with negative profit', async () => {
  const data = fixture();
  data.bets.rows[0] = { ...data.bets.rows[0], status: 'HALF_LOST', stakeCents: 1000, profitCents: -500 };
  get.mockResolvedValueOnce({ data: { success: true, data } });
  expect(await getAppWallets(query)).toBe(data);
  expect(data.bets.rows[0].profitCents).toBe(-500);
});

test('preserves null optional metadata returned by the backend', async () => {
  const data = fixture();
  data.bets.rows[0] = { ...data.bets.rows[0], matchId: null, matchLabel: null, league: null,
    kickoffAt: null, bookmaker: null, quote: null, profitCents: null };
  get.mockResolvedValueOnce({ data: { success: true, data } });
  expect(await getAppWallets(query)).toBe(data);
});

test('preserves custom labels, date boundaries and query arguments', async () => {
  const data = fixture(); data.period = { ...data.period, key: 'custom', label: '30 ottobre 2026', from: '2026-10-29T23:00:00.000Z' };
  const customQuery = { period: 'custom' as const, from: '2026-10-30', to: '2026-10-30' };
  get.mockResolvedValueOnce({ data: { success: true, data } });
  expect(await getAppWallets(customQuery)).toBe(data);
  expect(get).toHaveBeenLastCalledWith('/wallets', { params: customQuery, signal: undefined });
  expect(post).not.toHaveBeenCalled();
});

test('euro archive rejects paper records even if they contain a cents-shaped field', async () => {
  get.mockResolvedValueOnce({ data: { success: true, data: {
    summary: { total: 1 }, total: 1, rows: [{ ...fixture().bets.rows[0], id: 'paper:cancelled' }],
    byClassification: [], byModel: [], offset: 0, limit: 200,
  } } });
  await expect(getWalletArchive({ model: 'all' })).rejects.toThrow('Archivio non disponibile.');
  expect(post).not.toHaveBeenCalled();
});
