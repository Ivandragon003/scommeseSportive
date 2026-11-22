import type { AppPredictionOddsService } from '../services/AppPredictionOddsService';

type Fixture = Parameters<AppPredictionOddsService['load']>[0];

// Understat and Odds API spellings verified on the same fixture and kickoff.
export const verifiedBookmakerNames: ReadonlyMap<string, string> = new Map([
  ['Racing Santander', 'Real Racing Club de Santander'],
  ['Hull', 'Hull City'],
  ['Brighton', 'Brighton and Hove Albion'],
]);

const isVerifiedProviderName = (team: string, providerName: unknown): providerName is string =>
  typeof providerName === 'string' && verifiedBookmakerNames.get(team) === providerName;

export function researchProviderTeamNames(home: string, away: string, providerHome: string, providerAway: string) {
  if (!isVerifiedProviderName(home, providerHome) && !isVerifiedProviderName(away, providerAway)) return undefined;
  return { home: providerHome, away: providerAway };
}

/** Resolve the supplementary bookmaker sheet against the event already identified by the primary feed. */
export async function loadResearchFixtureOdds(feed: Pick<AppPredictionOddsService, 'load'>, fixture: Fixture,
  snapshot?: Record<string, any>) {
  const names = snapshot?.providerTeamNames;
  const home = isVerifiedProviderName(fixture.home_team_name, names?.home);
  const away = isVerifiedProviderName(fixture.away_team_name, names?.away);
  if (!home && !away) return feed.load(fixture);
  if (!snapshot?.providerEventId || Date.parse(snapshot.providerKickoffAt) !== Date.parse(fixture.date)) {
    throw new Error('research_fixture_event_mismatch');
  }
  const result = await feed.load({ ...fixture, home_team_name: home ? names.home : fixture.home_team_name,
    away_team_name: away ? names.away : fixture.away_team_name });
  if (result.metadata.providerEventId !== undefined && result.metadata.providerEventId !== snapshot.providerEventId) {
    throw new Error('research_fixture_event_mismatch');
  }
  return result;
}
