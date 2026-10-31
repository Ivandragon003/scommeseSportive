/* Read-only C audit: reconcile normalized statistics with persisted Understat payloads. */
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { createClient } = require('@libsql/client');
const fields = ['homeTotalShots', 'awayTotalShots', 'homeShotsOnTarget', 'awayShotsOnTarget',
  'homeYellowCards', 'awayYellowCards', 'homeRedCards', 'awayRedCards'];
const number = value => !['number', 'string'].includes(typeof value) || String(value).trim() === ''
  ? null : Number.isFinite(Number(value)) ? Number(value) : null;

function reconcile(frozen, details) {
  const byId = new Map(details.map(row => [row.match_id, row]));
  if (byId.size !== details.length) throw Error('Duplicate persisted match identity');
  const findings = [], coverage = Object.fromEntries(fields.map(field => [field, { compared: 0, unavailable: 0, differing: 0 }]));
  const missingMatches = [];
  for (const match of frozen.filter(row => Number.isInteger(row.homeGoals) && Number.isInteger(row.awayGoals))) {
    const raw = byId.get(match.matchId);
    if (!raw) { missingMatches.push(match.matchId); continue; }
    const derived = {};
    for (const [side, letter] of [['home', 'h'], ['away', 'a']]) {
      derived[side + 'TotalShots'] = raw[letter + '_shots'];
      derived[side + 'ShotsOnTarget'] = raw[letter + '_on_target'];
      const roster = JSON.parse(raw[letter + '_cards'] ?? '[]');
      for (const [index, name] of [[0, 'YellowCards'], [1, 'RedCards']]) {
        const values = roster.map(player => number(player[index]));
        derived[side + name] = values.length >= 11 && values.every(value => Number.isInteger(value) && value >= 0)
          ? values.reduce((sum, value) => sum + value, 0) : null;
      }
    }
    for (const field of fields) {
      const expected = number(derived[field]), actual = number(match[field]);
      if (expected === null || actual === null) { coverage[field].unavailable++; continue; }
      coverage[field].compared++;
      if (actual !== expected) {
        coverage[field].differing++;
        findings.push({ matchId: match.matchId, field, frozen: actual, persistedPrimary: expected });
      }
    }
  }
  return { completedFrozenMatches: frozen.filter(row => Number.isInteger(row.homeGoals) && Number.isInteger(row.awayGoals)).length,
    coverage, missingMatches, findings,
    comparedFields: Object.values(coverage).reduce((sum, field) => sum + field.compared, 0),
    differingFields: findings.length, sourceScope: 'persisted_primary_payload_not_independent_live_provider_or_historical_timestamp_attestation' };
}

async function main(argv = process.argv.slice(2)) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, '');
    if (!['matches', 'out', 'derived'].includes(key) || !argv[index].startsWith('--') || !argv[index + 1] || options[key]) throw Error('Invalid audit arguments');
    options[key] = argv[index + 1];
  }
  if (!options.matches || !options.out || fs.existsSync(options.out)) throw Error('Frozen --matches and new --out required');
  const bytes = fs.readFileSync(options.matches), frozen = JSON.parse(bytes);
  if (!Array.isArray(frozen) || !frozen.length) throw Error('Expected nonempty frozen match array');
  const databaseUrl = process.env.TURSO_DATABASE_URL;
  if (!options.derived && !databaseUrl) throw Error('TURSO_DATABASE_URL or saved --derived required');
  const db = options.derived ? null : createClient({ url: databaseUrl, authToken: process.env.TURSO_AUTH_TOKEN });
  const selections = ['match_id'];
  for (const side of ['h', 'a']) {
    const shots = `$.details.shots.${side}`, roster = `$.details.rosters.${side}`;
    selections.push(`CASE WHEN json_type(raw_json,'${shots}')='array' THEN json_array_length(raw_json,'${shots}') ELSE NULL END AS ${side}_shots`,
      `CASE WHEN json_type(raw_json,'${shots}')='array' THEN (SELECT COUNT(*) FROM json_each(matches.raw_json,'${shots}') WHERE TRIM(json_extract(value,'$.result')) IN ('Goal','SavedShot')) ELSE NULL END AS ${side}_on_target`,
      `(SELECT json_group_array(json_array(json_extract(value,'$.yellow_card'),json_extract(value,'$.red_card'))) FROM json_each(matches.raw_json,'${roster}')) AS ${side}_cards`);
  }
  const details = options.derived ? JSON.parse(fs.readFileSync(options.derived)) : [];
  if (!Array.isArray(details)) throw Error('Expected persisted derived rows');
  try {
    for (let offset = 0; db; offset += 200) {
      const result = await db.execute({ sql: `SELECT ${selections.join(',')} FROM matches WHERE home_goals IS NOT NULL AND away_goals IS NOT NULL ORDER BY match_id LIMIT 200 OFFSET ?`, args: [offset] });
      details.push(...result.rows);
      if (result.rows.length < 200) break;
    }
  } finally { db?.close(); }
  const payload = JSON.stringify(details);
  const report = { schemaVersion: 'c-persisted-primary-statistics-audit-v1', capturedAt: new Date().toISOString(),
    readOnly: true, readMode: options.derived ? 'saved_derived_payload' : 'paginated_select_only',
    inputSha256: createHash('sha256').update(bytes).digest('hex'),
    persistedDerivedRows: details.length, persistedDerivedSha256: createHash('sha256').update(payload).digest('hex'),
    ...reconcile(frozen, details) };
  fs.writeFileSync(options.out, JSON.stringify(report, null, 2), { flag: 'wx' });
  fs.writeFileSync(options.out + '.derived.json', payload, { flag: 'wx' });
  console.log(JSON.stringify({ completedFrozenMatches: report.completedFrozenMatches,
    comparedFields: report.comparedFields, differingFields: report.differingFields, missingMatches: report.missingMatches.length, readOnly: true }));
}
if (require.main === module) main().catch(() => { console.error('Persisted primary statistics audit failed; no database writes were issued.'); process.exitCode = 1; });
module.exports = { reconcile };
