import { utcDateTime, validCacheRate } from './researchOddsPresentation';

test('il calendario contabile mostra UTC anche quando Roma usa ora legale o solare', () => {
  expect(utcDateTime('2026-07-01T00:00:00Z')).toContain('00:00 UTC');
  expect(utcDateTime('2026-11-01T00:00:00Z')).toContain('00:00 UTC');
  expect(utcDateTime(undefined)).toBe('Non disponibile');
});

test('nessuna misura cache è distinta da un tasso misurato di zero', () => {
  expect(validCacheRate(null)).toBe(false);
  expect(validCacheRate(undefined)).toBe(false);
  expect(validCacheRate(0)).toBe(true);
  expect(validCacheRate(1.1)).toBe(false);
});
