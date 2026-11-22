import type { AppPredictionOddsService } from '../services/AppPredictionOddsService';

type Fixture = Parameters<AppPredictionOddsService['load']>[0];

/** Resolve the supplementary bookmaker sheet against the event already identified by the primary feed. */
export async function loadResearchFixtureOdds(feed: Pick<AppPredictionOddsService, 'load'>, fixture: Fixture,
  snapshot?: Record<string, any>) {
  const names = snapshot?.providerTeamNames;
  // Verified Understat team 293 / football-data.org team 5335.
  const home = fixture.home_team_name === 'Racing Santander' && names?.home === 'Real Racing Club de Santander';
  const away = fixture.away_team_name === 'Racing Santander' && names?.away === 'Real Racing Club de Santander';
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
