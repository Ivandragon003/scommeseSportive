import { oddsCategoryLabel, switchMarketTab } from './predictionWorkbenchUtils';

describe('switchMarketTab', () => {
  it('changes only the visible market and never invokes analysis', () => {
    const setActiveMarket = jest.fn();
    const requestAnalysis = jest.fn();

    switchMarketTab('cards', setActiveMarket);

    expect(setActiveMarket).toHaveBeenCalledWith('cards');
    expect(requestAnalysis).not.toHaveBeenCalled();
  });
});

describe('oddsCategoryLabel', () => {
  it('maps provider market families to the user-facing drilldown without refetching data', () => {
    expect(oddsCategoryLabel('alternate_totals_cards_over_4.5')).toBe('Cartellini');
    expect(oddsCategoryLabel('alternate_spreads_cards_home_-1.5')).toBe('Cartellini');
    expect(oddsCategoryLabel('player_mateo_retegui_shots_over_1.5')).toBe('Tiri giocatore');
    expect(oddsCategoryLabel('alternate_totals_shots_over_23.5')).toBe('Tiri');
    expect(oddsCategoryLabel('alternate_totals_fouls_over_22.5')).toBe('Falli');
  });
});
