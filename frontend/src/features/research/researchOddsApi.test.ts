import API from '../../utils/api';
import { getResearchOddsStatus } from '../../utils/researchApi';

jest.mock('../../utils/api', () => ({ __esModule: true, default: { get: jest.fn(), post: jest.fn() } }));
const mockedGet = API.get as jest.Mock;

beforeEach(() => jest.resetAllMocks());

test('lo stato quote usa soltanto GET autenticata e inoltra il segnale di annullamento', async () => {
  const signal = new AbortController().signal;
  const payload = { providers: [], observedAt: '2026-10-27T09:00:00Z' };
  mockedGet.mockResolvedValue({ data: { success: true, data: payload } });
  expect(await getResearchOddsStatus(signal)).toEqual(payload);
  expect(mockedGet).toHaveBeenCalledWith('/research/odds-status', { signal });
  expect(API.post).not.toHaveBeenCalled();
});

test('un errore API non viene convertito in un budget o elenco provider vuoto', async () => {
  mockedGet.mockResolvedValue({ data: { success: false, error: 'Contabilità non disponibile' } });
  await expect(getResearchOddsStatus()).rejects.toThrow('Contabilità non disponibile');
});
