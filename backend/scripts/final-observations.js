const { createClient } = require('@libsql/client');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { assessFinalObservations, OBSERVATION_FIELDS } = require('../dist/services/FinalObservationLock');
const { assessCsvObservations, CSV_FIELDS } = require('../dist/services/FinalObservationCsv');
const { parseFootballDataCsv, matchKey } = require('../dist/services/FootballDataService');
const competitions = { I1:'Serie A', E0:'Premier League', SP1:'La Liga', D1:'Bundesliga', F1:'Ligue 1' };
const UNVERIFIED_FIELDS = ['home_shots','away_shots','home_shots_on_target','away_shots_on_target',
  'home_possession','away_possession','home_fouls','away_fouls','home_yellow_cards','away_yellow_cards',
  'home_red_cards','away_red_cards','home_corners','away_corners','referee'];
const hash = (data) => createHash('sha256').update(data).digest('hex');
async function buildObservationPlan(client, season) {
  if (!/^\d{4}\/\d{4}$/.test(season || '')) throw Error('Invalid season');
    const result = await client.execute({ sql: `SELECT m.*,h.source_team_id AS home_source_team_id,a.source_team_id AS away_source_team_id
      FROM matches m LEFT JOIN teams h ON h.team_id=m.home_team_id LEFT JOIN teams a ON a.team_id=m.away_team_id
      WHERE m.season=? AND m.home_goals IS NOT NULL AND m.away_goals IS NOT NULL ORDER BY m.match_id`, args: [season] });
    const reasons = Object.fromEntries([...OBSERVATION_FIELDS, ...UNVERIFIED_FIELDS].map((field) => [field, {}]));
    const observations = [];
    for (const row of result.rows) {
      const assessment = assessFinalObservations(row);
      observations.push(...assessment.observations);
      for (const field of OBSERVATION_FIELDS) reasons[field][assessment.reasons[field]] = (reasons[field][assessment.reasons[field]] || 0) + 1;
      for (const field of UNVERIFIED_FIELDS) {
        const reason = row[field] == null || (typeof row[field] === 'string' && !row[field].trim()) ? 'missing' : 'present_not_individually_verified';
        reasons[field][reason] = (reasons[field][reason] || 0) + 1;
      }
    }
    const tables = await client.execute("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('nightly_csv_snapshots','nightly_csv_attempts')");
    const snapshots = tables.rows.length === 2 ? await client.execute({sql:`SELECT s.code,s.csv,s.sha256,s.acquired_at FROM nightly_csv_snapshots s
      JOIN nightly_csv_attempts a ON a.id=s.attempt_id WHERE a.season=? AND a.status='success'
      AND a.id=(SELECT MAX(a2.id) FROM nightly_csv_attempts a2 JOIN nightly_csv_snapshots s2 ON s2.attempt_id=a2.id
        WHERE a2.season=a.season AND a2.status='success' AND s2.code=s.code) ORDER BY s.code`,args:[Number(season.slice(0,4))]}) : {rows:[]};
    const sources = [], indexes = new Map(), targetCounts = new Map();
    for (const snapshot of snapshots.rows) {
      const code=String(snapshot.code), csv=String(snapshot.csv), sha256=String(snapshot.sha256), acquiredAt=String(snapshot.acquired_at);
      if (!competitions[code] || hash(csv)!==sha256 || indexes.has(competitions[code])) throw Error(`Invalid or duplicate CSV snapshot: ${code}`);
      const index=new Map();
      for (const row of parseFootballDataCsv(csv)) { const key=matchKey(row.date,row.homeTeam,row.awayTeam); index.set(key,[...(index.get(key)||[]),row]); }
      indexes.set(competitions[code],{index,code,sha256,acquiredAt}); sources.push({code,csv,sha256,acquiredAt});
    }
    for (const row of result.rows) { const key=`${row.competition}|${matchKey(row.date,row.home_team_name,row.away_team_name)}`; targetCounts.set(key,(targetCounts.get(key)||0)+1); }
    for (const row of result.rows) {
      const key=matchKey(row.date,row.home_team_name,row.away_team_name), source=indexes.get(row.competition), candidates=source?.index.get(key)||[];
      if (targetCounts.get(`${row.competition}|${key}`)!==1 || candidates.length!==1) continue;
      const eligible=assessCsvObservations(row,candidates[0],source);
      observations.push(...eligible);
      for (const item of eligible) {
        reasons[item.field].present_not_individually_verified--;
        reasons[item.field].eligible_csv_agreement=(reasons[item.field].eligible_csv_agreement||0)+1;
      }
      if (row.home_goals===candidates[0].homeGoals && row.away_goals===candidates[0].awayGoals) {
        for (const [field,key] of Object.entries(CSV_FIELDS)) {
          if (row[field] == null || (typeof row[field] === 'string' && !row[field].trim()) || eligible.some(item=>item.field===field)) continue;
          const value=candidates[0][key];
          const reason=value==null ? 'missing_in_csv' : 'csv_disagreement_or_invalid';
          reasons[field].present_not_individually_verified--;
          reasons[field][reason]=(reasons[field][reason]||0)+1;
        }
      }
    }
    return { version: 2, season, matches: result.rows.length, reasons, sources, observations };
}
async function applyObservationPlan(tx, plan) {
  const current = await buildObservationPlan(tx, plan.season);
  if (hash(JSON.stringify(current)) !== hash(JSON.stringify(plan))) throw Error('Plan or source changed; create and review a new plan');
  const existingRows = await tx.execute('SELECT match_id,field,value FROM final_observations');
  const existing = new Map(existingRows.rows.map(row => [`${row.match_id}|${row.field}`,row.value]));
  const statements=[];
  for (const source of plan.sources) statements.push({sql:`INSERT INTO final_observation_sources(sha256,csv,source,acquired_at)
    VALUES(?,?,'football_data_csv',?) ON CONFLICT(sha256) DO NOTHING`,args:[source.sha256,source.csv,source.acquiredAt]});
  for (const item of plan.observations) {
    const key=`${item.matchId}|${item.field}`;
    if (existing.has(key)) { if (existing.get(key)!==item.value) throw Error('Existing observation differs; explicit review required'); continue; }
    statements.push({sql:`INSERT INTO final_observations(match_id,field,value,source,evidence_json,evidence_sha256)
      SELECT ?,?,?,?,?,? WHERE NOT EXISTS(SELECT 1 FROM final_observations WHERE match_id=? AND field=?)`,
      args:[item.matchId,item.field,item.value,item.source,item.evidenceJson,item.evidenceSha256,item.matchId,item.field]});
  }
  let inserted=0;
  for (let i=0;i<statements.length;i+=50) {
    const chunk=statements.slice(i,i+50); const results=await tx.batch(chunk);
    results.forEach((result,index)=>{ if (chunk[index].sql.includes('INSERT INTO final_observations(')) inserted+=Number(result.rowsAffected||0); });
  }
  return {inserted};
}
async function main() {
  const [mode, dbPath, season, planPath, backupPath, manifestPath, expectedHash] = process.argv.slice(2);
  if (!['plan', 'apply'].includes(mode) || !dbPath || !/^\d{4}\/\d{4}$/.test(season || '') || !planPath) throw Error('Usage: node final-observations.js plan|apply LOCAL_DB SEASON PLAN_JSON [BACKUP_DB MANIFEST EXPECTED_PLAN_SHA256]');
  if (/^(libsql|https?):/i.test(dbPath)) throw Error('Only local database files are supported');
  const absoluteDb=path.resolve(dbPath);
  if (!fs.existsSync(absoluteDb)) throw Error('Database file not found');
  const db=createClient({url:`file:${absoluteDb}`});
  try {
    const plan=await buildObservationPlan(db,season), planHash=hash(JSON.stringify(plan));
    if(mode==='plan') {
      fs.writeFileSync(planPath,JSON.stringify({...plan,planSha256:planHash},null,2));
      console.log(JSON.stringify({season,matches:plan.matches,reasons:plan.reasons,observations:plan.observations.length,planSha256:planHash})); return;
    }
    if (!backupPath || !manifestPath || !/^[a-f0-9]{64}$/.test(expectedHash || '')) throw Error('Apply requires backup, manifest and reviewed plan hash');
    const {planSha256,...content}=JSON.parse(fs.readFileSync(planPath,'utf8'));
    if(planSha256!==expectedHash || hash(JSON.stringify(content))!==expectedHash || planHash!==expectedHash) throw Error('Plan or source changed; create and review a new plan');
    const backup=path.resolve(backupPath); if(backup===absoluteDb) throw Error('Backup must be separate from target');
    const manifest=JSON.parse(fs.readFileSync(manifestPath,'utf8')), backupHash=hash(fs.readFileSync(backup));
    if(!manifest.complete || !manifest.verification?.readable || manifest.verification.databaseSha256!==backupHash) throw Error('Backup manifest or hash invalid');
    const tx=await db.transaction('write');
    try {const result=await applyObservationPlan(tx,plan);await tx.commit();console.log(JSON.stringify({...result,planSha256,backupSha256:backupHash}));}
    catch(error){await tx.rollback();throw error;}
  } finally {db.close();}
}
module.exports={buildObservationPlan,applyObservationPlan};
if(require.main===module) main().catch((error)=>{console.error(error.message);process.exitCode=1;});
