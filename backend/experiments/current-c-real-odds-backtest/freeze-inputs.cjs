'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../../..');
const output = path.resolve(process.argv[2]);
if (!process.argv[2] || fs.existsSync(output)) throw Error('A new output directory is required');
process.loadEnvFile(path.join(root, '.env'));
const { createClient } = require(path.join(root, 'backend/node_modules/@libsql/client'));
if (!process.env.TURSO_WATCHDOG_READONLY_TOKEN) throw Error('Read-only database token required');
const db = createClient({ url: process.env.TURSO_DATABASE_URL, authToken: process.env.TURSO_WATCHDOG_READONLY_TOKEN });
const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const queries = {
  matches: "SELECT match_id,home_team_id,away_team_id,date,competition,season,home_goals,away_goals,home_xg,away_xg,home_shots,away_shots,home_shots_on_target,away_shots_on_target,home_yellow_cards,away_yellow_cards,home_red_cards,away_red_cards,home_fouls,away_fouls,home_team_name,away_team_name FROM matches WHERE competition IN ('Serie A','Premier League','La Liga','Bundesliga','Ligue 1') ORDER BY date,match_id",
  models: "SELECT family,version,artifact_hash,created_at FROM research_models WHERE family='C' ORDER BY created_at DESC",
  deployment: 'SELECT sequence,action,deployment_json,created_at FROM challenger_adoption_events ORDER BY sequence DESC LIMIT 1',
};
(async () => {
  try {
    const manifest = { capturedAt: new Date().toISOString(), databaseWrites: 0, credentialMode: 'read_only_token', queries, outputs: {} };
    const results = {};
    for (const [name, sql] of Object.entries(queries)) results[name] = (await db.execute(sql)).rows.map(row => ({ ...row }));
    fs.mkdirSync(output, { recursive: true });
    const camel = key => key.replace(/_([a-z])/g, (_, char) => char.toUpperCase());
    const rename = { homeXg: 'homeXG', awayXg: 'awayXG', homeShots: 'homeTotalShots', awayShots: 'awayTotalShots' };
    results.history = results.matches.map(row => Object.fromEntries(Object.entries(row).filter(([key]) => !key.endsWith('_team_name'))
      .map(([key, value]) => [rename[camel(key)] || camel(key), value])));
    for (const [name, value] of Object.entries(results)) {
      const bytes = JSON.stringify(value);
      fs.writeFileSync(path.join(output, name + '.json'), bytes, { flag: 'wx', mode: 0o600 });
      manifest.outputs[name] = { rows: value.length, sha256: hash(bytes), bytes: Buffer.byteLength(bytes) };
    }
    fs.writeFileSync(path.join(output, 'freeze-manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ ...manifest.outputs, currentModel: results.models[0], adoptedDeployment: results.deployment }));
  } finally { db.close(); }
})().catch(() => { console.error('Input freeze failed; only SELECT statements were issued.'); process.exitCode = 1; });
