import { formatMatchDateTime, formatMatchTime, getMatchDayKey } from './dateTime';

describe('dateTime match formatting', () => {
  test('mostra un ISO UTC in timezone Europe/Rome durante ora legale', () => {
    expect(formatMatchTime('2026-05-19T18:30:00Z')).toBe('20:30');
  });

  test('non mostra l ora UTC grezza per una partita estiva', () => {
    expect(formatMatchTime('2026-05-19T18:30:00Z')).not.toBe('18:30');
  });

  test('gestisce anche ora solare italiana', () => {
    expect(formatMatchTime('2026-01-19T18:30:00Z')).toBe('19:30');
  });

  test('genera day key secondo Europe/Rome', () => {
    expect(getMatchDayKey('2026-05-19T22:30:00Z')).toBe('2026-05-20');
  });

  test('mostra Fiorentina-Atalanta nel giorno italiano corretto alle 20:45', () => {
    const kickoff = '2026-05-22T18:45:00Z';

    expect(formatMatchTime(kickoff)).toBe('20:45');
    expect(getMatchDayKey(kickoff)).toBe('2026-05-22');
    expect(formatMatchDateTime(kickoff)).toContain('20:45');
  });

  test('mostra un kickoff 16:00 UTC alle 18:00 italiane senza slittare al giorno dopo', () => {
    const kickoff = '2026-05-23T16:00:00Z';

    expect(formatMatchTime(kickoff)).toBe('18:00');
    expect(getMatchDayKey(kickoff)).toBe('2026-05-23');
  });
});
