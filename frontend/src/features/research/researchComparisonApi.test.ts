import API from '../../utils/api';
import { getResearchComparison } from '../../utils/researchApi';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
const get = API.get as jest.Mock;
beforeEach(() => jest.resetAllMocks());

test('confronto usa GET autenticata con query e annullamento, senza scritture', async () => {
  const signal = new AbortController().signal;
  const query = { period: 'custom' as const, from: '2026-10-25', to: '2026-10-25' };
  const payload = { period: query, portfolios: [] };
  get.mockResolvedValue({ data: { success: true, data: payload } });
  expect(await getResearchComparison(query, signal)).toEqual(payload);
  expect(get).toHaveBeenCalledWith('/research/comparison', { params: query, signal });
  expect(API.post).not.toHaveBeenCalled();
});

test('errore backend non diventa un confronto vuoto', async () => {
  get.mockResolvedValue({ data: { success: false, error: 'Confronto non disponibile' } });
  await expect(getResearchComparison({ period: '30d' })).rejects.toThrow('Confronto non disponibile');
});
