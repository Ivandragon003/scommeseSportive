import { createHash } from 'node:crypto';
import { matchKey, type FootballDataRow } from './FootballDataService';

export const CSV_FIELDS = {
  home_shots:'homeShots', away_shots:'awayShots', home_shots_on_target:'homeShotsOnTarget', away_shots_on_target:'awayShotsOnTarget',
  home_fouls:'homeFouls', away_fouls:'awayFouls', home_corners:'homeCorners', away_corners:'awayCorners',
  home_yellow_cards:'homeYellow', away_yellow_cards:'awayYellow', home_red_cards:'homeRed', away_red_cards:'awayRed', referee:'referee',
} as const;
export type CsvObservation = { matchId:string; field:string; value:number|string; source:'football_data_csv'; evidenceJson:string; evidenceSha256:string };
/** Caller must establish one-to-one matching for both the local and source fixture. */
export function assessCsvObservations(target: Record<string, any>, row: FootballDataRow, source: {sha256:string; acquiredAt:string; code:string}): CsvObservation[] {
  if (!/^[a-f0-9]{64}$/.test(source.sha256) || !Number.isFinite(Date.parse(source.acquiredAt))
    || matchKey(target.date,target.home_team_name,target.away_team_name) !== matchKey(row.date,row.homeTeam,row.awayTeam)
    || row.homeGoals == null || row.awayGoals == null || target.home_goals !== row.homeGoals || target.away_goals !== row.awayGoals) return [];
  const output: CsvObservation[] = [];
  for (const [field, key] of Object.entries(CSV_FIELDS)) {
    const value = target[field], sourceValue = row[key];
    if (value == null || sourceValue == null || value !== sourceValue
      || (typeof sourceValue === 'number' && (!Number.isSafeInteger(sourceValue) || sourceValue < 0))
      || (typeof sourceValue === 'string' && !sourceValue.trim())) continue;
    const evidenceJson = JSON.stringify({ provider:'football_data_csv', code:source.code, csvSha256:source.sha256,
      acquiredAt:source.acquiredAt, matchId:String(target.match_id), field, value, row });
    output.push({matchId:String(target.match_id),field,value,source:'football_data_csv',evidenceJson,
      evidenceSha256:createHash('sha256').update(evidenceJson).digest('hex')});
  }
  return output;
}
