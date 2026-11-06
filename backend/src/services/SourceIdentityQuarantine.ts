/** Reviewed incident; only the disputed team in this competition and season is blocked. */
export function sourceIdentityQuarantined(competition: string, season: number, home?: string, away?: string): boolean {
  return competition === 'FL1' && season === 2026
    && (home === 'understat_team_172' || away === 'understat_team_172');
}
