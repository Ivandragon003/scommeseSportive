import API from './api';
import { getPaperBets } from './paperBetsApi';
jest.mock('./api', () => ({ __esModule: true, default: { get: jest.fn() } }));
const metrics = { totalCount: 0, betCount: 0, openCount: 0, settledCount: 0, totalStakeUnits: 0,
  settledStakeUnits: 0, returnUnits: 0, profitUnits: 0, roiPercent: null, winRatePercent: null,
  wonCount: 0, lostCount: 0, voidCount: 0 };
const emptyPaper = () => ({ ...metrics, accountingMode: 'PAPER_FIXED_UNIT', fixedStakeUnits: 1,
  portfolios: ['A', 'C'].map(family => ({ ...metrics, family, history: [] })), history: [], bets: [] });

test('legge il contratto unitario completo senza chiamare gli endpoint funded', async () => {
  const data = emptyPaper();
  (API.get as jest.Mock).mockResolvedValue({ data: { success: true, data } });
  await expect(getPaperBets()).resolves.toBe(data);
});

test('rifiuta un dettaglio troncato che nasconderebbe parte delle giocate', async () => {
  (API.get as jest.Mock).mockResolvedValue({ data: { success: true, data: { ...emptyPaper(), totalCount: 125 } } });
  await expect(getPaperBets()).rejects.toThrow('non valida o incompleta');
});

test('lo schema assente viene reso esplicito senza fallback ai portafogli', async () => {
  (API.get as jest.Mock).mockRejectedValue({ response: { data: { code: 'paper_schema_required' } } });
  await expect(getPaperBets()).rejects.toThrow('schema del database deve essere aggiornato');
  expect(API.get).toHaveBeenCalledWith('/paper-bets', { signal: undefined });
});

test('non accetta un payload funded come contabilità paper', async () => {
  (API.get as jest.Mock).mockResolvedValue({ data: { success: true, data: { portfolios: [], bets: { total: 125, rows: [] } } } });
  await expect(getPaperBets()).rejects.toThrow('non valida o incompleta');
});

test('conserva le frazioni di unità e il ROI senza arrotondare i ritorni parziali', async () => {
  const settled = { ...metrics, totalCount: 1, betCount: 1, settledCount: 1, totalStakeUnits: 1,
    settledStakeUnits: 1, returnUnits: 1.505, profitUnits: .505, roiPercent: 50.5, winRatePercent: 100, wonCount: 1 };
  const history = [{ at: '2026-11-06T21:00:00Z', betId: 'paper:half-win', profitUnits: .505 }];
  const data = { ...emptyPaper(), ...settled, history,
    portfolios: [{ ...settled, family: 'A', history }, { ...metrics, family: 'C', history: [] }],
    bets: [{ id: 'paper:half-win', accountingMode: 'PAPER_FIXED_UNIT', family: 'A', odds: 2.01,
      stakeUnits: 1, returnUnits: 1.505, profitUnits: .505, status: 'HALF_WON', market: 'asian_handicap', selection: 'ahcp_025' }] };
  (API.get as jest.Mock).mockResolvedValue({ data: { success: true, data } });
  const result = await getPaperBets();
  expect(result.bets[0].returnUnits).toBe(1.505);
  expect(result.profitUnits).toBe(.505);
  expect(result.roiPercent).toBe(50.5);
});
