import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import ModelBetActions from './ModelBetActions';
import { placeModelBet, archiveModelOpportunity } from '../../utils/modelBetActionsApi';

jest.mock('../../utils/modelBetActionsApi');
const place = placeModelBet as jest.MockedFunction<typeof placeModelBet>;
const archive = archiveModelOpportunity as jest.MockedFunction<typeof archiveModelOpportunity>;
const portfolios: any[] = [{ family: 'A', portfolioId: 'shadow_A', currentEquityCents: 100000, initialized: true },
  { family: 'C', portfolioId: 'shadow_C', currentEquityCents: 150000, initialized: true }];
const opportunity = { selection: 'over25', marketName: 'Gol totali', bookmakerOdds: 2.1, bookmakerName: 'Bookmaker reale', suggestedStakePercent: 2 };
beforeEach(() => { jest.resetAllMocks(); place.mockResolvedValue({} as any); archive.mockResolvedValue({} as any); });

test.each([['A', 2000], ['C', 1500]] as const)('manual %s uses its own capital and sends the displayed real price', async (family, stakeCents) => {
  const refresh = jest.fn().mockResolvedValue(undefined);
  render(<ModelBetActions family={family} matchId="m1" opportunity={opportunity} portfolios={portfolios} onSaved={refresh} />);
  fireEvent.click(screen.getByRole('button', { name: `Scommetti con ${family}` }));
  await waitFor(() => expect(place).toHaveBeenCalledWith({ family, matchId: 'm1', selection: 'over25', stakeCents, bookmakerOdds: 2.1, bookmakerName: 'Bookmaker reale' }));
  await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  expect(archive).not.toHaveBeenCalled();
});

test('LOW archive sends classification without placing a funded bet', async () => {
  render(<ModelBetActions family="A" matchId="m1" opportunity={{ ...opportunity, confidence: 'LOW' }} portfolios={portfolios} onSaved={async () => undefined} />);
  fireEvent.click(screen.getByRole('button', { name: 'Archivia senza puntare' }));
  await waitFor(() => expect(archive).toHaveBeenCalledWith(expect.objectContaining({ family: 'A', classification: 'LOW', selection: 'over25' })));
  expect(place).not.toHaveBeenCalled();
});

test('registered and unavailable matches cannot submit a new bet', () => {
  const view = render(<ModelBetActions family="C" matchId="m1" opportunity={opportunity} portfolios={portfolios} registered onSaved={async () => undefined} />);
  expect(screen.getByRole('button', { name: 'Giocata già registrata' }).hasAttribute('disabled')).toBe(true);
  view.rerender(<ModelBetActions family="C" matchId="m1" opportunity={opportunity} portfolios={portfolios} unavailable onSaved={async () => undefined} />);
  expect(screen.getByRole('button', { name: 'Scommetti con C' }).hasAttribute('disabled')).toBe(true);
  expect(place).not.toHaveBeenCalled();
});

test('a balance refresh failure never presents a successful transaction as failed', async () => {
  render(<ModelBetActions family="A" matchId="m1" opportunity={opportunity} portfolios={portfolios} onSaved={async () => { throw new Error('offline'); }} />);
  fireEvent.click(screen.getByRole('button', { name: 'Scommetti con A' }));
  expect(await screen.findByText(/Giocata virtuale registrata.*saldo non è ancora aggiornato/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Giocata già registrata' }).hasAttribute('disabled')).toBe(true);
  expect(place).toHaveBeenCalledTimes(1);
});

test('an expired saved quote disables betting but still permits a LOW archive', async () => {
  render(<ModelBetActions family="A" matchId="m1" opportunity={{ ...opportunity, confidence: 'LOW' }}
    quoteCapturedAt={new Date(Date.now() - 600_000).toISOString()} portfolios={portfolios} onSaved={async () => undefined} />);
  expect(screen.getByRole('button', { name: 'Scommetti con A' }).hasAttribute('disabled')).toBe(true);
  expect(screen.getByText(/Quota salvata non più valida/)).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Archivia senza puntare' }));
  await waitFor(() => expect(archive).toHaveBeenCalledTimes(1));
  expect(place).not.toHaveBeenCalled();
});


test('LOW requires explicit confirmation; exit never places a bet', async () => {
 render(<ModelBetActions family="A" matchId="m1" opportunity={{...opportunity,confidence:'LOW'}} portfolios={portfolios} onSaved={async()=>undefined} />);
 fireEvent.click(screen.getByRole('button',{name:'Scommetti con A'}));
 expect(screen.getByRole('dialog')).toBeTruthy(); expect(place).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Esci'}));
 await waitFor(()=>expect(screen.getByRole('button',{name:'Scommetti con A'}).hasAttribute('disabled')).toBe(false)); expect(place).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole('button',{name:'Scommetti con A'}));
 fireEvent.click(screen.getByRole('button',{name:'Gioca'}));
 await waitFor(()=>expect(place).toHaveBeenCalledTimes(1));
});
