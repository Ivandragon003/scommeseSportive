// Read-only coverage diagnostic. A match to the cached CSV is evidence of
// agreement, not proof of which provider originally populated a DB field.
const { createClient } = require('@libsql/client');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parseFootballDataCsv, matchKey } = require('../dist/services/FootballDataService');
const competitions = { I1:'Serie A', E0:'Premier League', SP1:'La Liga', D1:'Bundesliga', F1:'Ligue 1' };
const fields = { home_shots:'homeShots',away_shots:'awayShots',home_shots_on_target:'homeShotsOnTarget',away_shots_on_target:'awayShotsOnTarget',home_fouls:'homeFouls',away_fouls:'awayFouls',home_corners:'homeCorners',away_corners:'awayCorners',home_yellow_cards:'homeYellow',away_yellow_cards:'awayYellow',home_red_cards:'homeRed',away_red_cards:'awayRed',referee:'referee' };
async function main() {
  const [file, season] = process.argv.slice(2);
  if (!file || /^(libsql|https?):/i.test(file) || !/^\d{4}\/\d{4}$/.test(season || '')) throw Error('Usage: node final-observation-csv-diagnostic.js LOCAL_DB YYYY/YYYY');
  const absolute = path.resolve(file);
  if (!fs.existsSync(absolute)) throw Error('Local database not found');
  const db = createClient({url:`file:${absolute}`});
  try {
    const snapshots = await db.execute({sql:`SELECT s.code,s.csv,s.sha256,s.acquired_at FROM nightly_csv_snapshots s JOIN nightly_csv_attempts a ON a.id=s.attempt_id WHERE a.season=? AND a.status='success'
      AND a.id=(SELECT MAX(a2.id) FROM nightly_csv_attempts a2 JOIN nightly_csv_snapshots s2 ON s2.attempt_id=a2.id
        WHERE a2.season=a.season AND a2.status='success' AND s2.code=s.code) ORDER BY s.code`,args:[Number(season.slice(0,4))]});
    const matches = await db.execute({sql:`SELECT * FROM matches WHERE season=? AND home_goals IS NOT NULL AND away_goals IS NOT NULL`,args:[season]});
    const summary = {season, finalMatches:matches.rows.length, sources:[], matchStatus:{}, fields:Object.fromEntries(Object.keys(fields).map((field)=>[field,{}]))};
    const byComp = new Map();
    for (const snapshot of snapshots.rows) {
      const code=String(snapshot.code), csv=String(snapshot.csv), digest=createHash('sha256').update(csv).digest('hex');
      if (!competitions[code] || digest!==snapshot.sha256 || byComp.has(competitions[code])) throw Error(`Invalid or duplicate CSV snapshot: ${code}`);
      const index=new Map();
      for (const row of parseFootballDataCsv(csv)) { const key=matchKey(row.date,row.homeTeam,row.awayTeam); const group=index.get(key)||[]; group.push(row); index.set(key,group); }
      byComp.set(competitions[code],index); summary.sources.push({code,sha256:digest,acquiredAt:snapshot.acquired_at});
    }
    const counts=new Map();
    for (const row of matches.rows) {const k=`${row.competition}|${matchKey(row.date,row.home_team_name,row.away_team_name)}`;counts.set(k,(counts.get(k)||0)+1);}
    const add=(obj,key)=>{obj[key]=(obj[key]||0)+1;};
    for (const row of matches.rows) {
      const key=matchKey(row.date,row.home_team_name,row.away_team_name), candidates=byComp.get(row.competition)?.get(key)||[];
      const status=counts.get(`${row.competition}|${key}`)!==1 || candidates.length>1 ? 'ambiguous_identity' : candidates.length===0 ? 'no_csv_match' : candidates[0].homeGoals!==row.home_goals || candidates[0].awayGoals!==row.away_goals ? 'score_mismatch_or_missing' : 'matched_score';
      add(summary.matchStatus,status);
      for (const [column,sourceField] of Object.entries(fields)) {
        const target=row[column], source=status==='matched_score' ? candidates[0][sourceField] : null;
        const outcome=target==null || (typeof target==='string' && !target.trim()) ? 'missing_in_database' : status!=='matched_score' ? status : source==null ? 'missing_in_csv' : typeof source==='number' && (!Number.isSafeInteger(source) || source<0) ? 'invalid_csv_value' : target===source ? 'agrees_with_csv' : 'different_from_csv';
        add(summary.fields[column],outcome);
      }
    }
    console.log(JSON.stringify(summary,null,2));
  } finally {db.close();}
}
main().catch((error)=>{console.error(error.message);process.exitCode=1;});
