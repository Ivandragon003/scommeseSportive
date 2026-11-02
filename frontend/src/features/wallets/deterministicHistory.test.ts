import { withDeterministicHistory } from './deterministicHistory';
test('A combines historical outcomes, weights ROI by stakes and never changes spendable funds or C', () => {
  const data = { period:{key:'all'}, portfolios:[{family:'A',currentAvailableCents:95000,profitCents:-1000,settledStakeCents:2000,betCount:1,settledCount:1,lostCount:1}, {family:'C',profitCents:300}] } as any;
  const merged = withDeterministicHistory(data,[{status:'WON',stake:100,profit:20}])!;
  expect(merged.portfolios[0]).toMatchObject({profitCents:1000,settledStakeCents:12000,betCount:2,settledCount:2,wonCount:1,currentAvailableCents:95000});
  expect(merged.portfolios[0].roi).toBeCloseTo(1000/12000);
  expect(merged.portfolios[1]).toBe(data.portfolios[1]); expect(data.portfolios[0].profitCents).toBe(-1000);
});
test('settlements enter the selected period by closing time rather than the placing date', () => {
  const data = {period:{key:'custom',from:'2026-11-01T00:00:00Z',to:'2026-11-02T23:59:59Z'},portfolios:[{family:'A',betCount:0,settledCount:0}]} as any;
  const merged = withDeterministicHistory(data,[{status:'HALF_WON',stake:10,profit:5,placed_at:'2026-10-30T12:00:00Z',settled_at:'2026-11-01T12:00:00Z'}])!;
  expect(merged.portfolios[0]).toMatchObject({betCount:0,settledCount:1,profitCents:500});
});
