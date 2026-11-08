'use strict';
// Offline, isolated data preparation. Understat remains authoritative for goals and xG.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { canonicalTeamName, parseFootballDataCsv, matchKey, buildMarketOddsJson } = require('../../dist/services/FootballDataService');
const ROOT = path.resolve(__dirname, '../../..');

const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const read = file => { const bytes = fs.readFileSync(file); return { value: JSON.parse(bytes.toString('utf8')), sha256: hash(bytes) }; };
const assert = (condition, message) => { if (!condition) throw new Error(message); };
const resolveCsvPath = (file, manifest) => path.isAbsolute(file) ? file :
  path.resolve(/^backend[\\/]/.test(file) ? ROOT : path.dirname(manifest), file);
// Exact historical Understat/football-data pairs verified by date, opponent and score.
// This local experiment does not change the project's canonical team aliases.
const HISTORICAL_MATCH_ALIASES = Object.freeze({ sdhuesca: 'huesca', spal2013: 'spal',
  fortunaduesseldorf: 'fortunadusseldorf', nuernberg: 'nurnberg', hannover96: 'hannover',
  westbromwichalbion: 'westbrom', arminiabielefeld: 'bielefeld', greutherfuerth: 'greutherfurth' });
const historicalMatchKey = (date, home, away) => {
  const map = name => HISTORICAL_MATCH_ALIASES[canonicalTeamName(name)] || canonicalTeamName(name);
  return matchKey(date, map(home), map(away));
};
const teamKey = (league, name) => `${league}|${canonicalTeamName(name)}`;
const statFields = { homeTotalShots: 'homeShots', awayTotalShots: 'awayShots', homeShotsOnTarget: 'homeShotsOnTarget',
  awayShotsOnTarget: 'awayShotsOnTarget', homeFouls: 'homeFouls', awayFouls: 'awayFouls',
  homeYellowCards: 'homeYellow', awayYellowCards: 'awayYellow', homeRedCards: 'homeRed', awayRedCards: 'awayRed',
  homeCorners: 'homeCorners', awayCorners: 'awayCorners', referee: 'referee' };
const seasonKey = r => `${r.competition}|${r.season}`;
function add(setMap, key, value) { if (!setMap.has(key)) setMap.set(key, new Set()); setMap.get(key).add(value); }
function only(set) { return set?.size === 1 ? [...set][0] : null; }
function requireMatch(row) {
  assert(typeof row.matchId === 'string' && row.matchId.startsWith('understat_') && typeof row.competition === 'string'
    && /^\d{4}\/\d{4}$/.test(row.season) && Number.isFinite(Date.parse(row.date))
    && Number.isInteger(row.homeGoals) && row.homeGoals >= 0 && Number.isInteger(row.awayGoals) && row.awayGoals >= 0,
  `invalid_understat_record:${row.matchId}`);
}
function compatible(a, b) {
  return a.competition === b.competition && a.season === b.season && a.date === b.date
    && a.homeGoals === b.homeGoals && a.awayGoals === b.awayGoals;
}

function prepare(archive, recent, names, sources) {
  assert(Array.isArray(archive) && Array.isArray(recent) && Array.isArray(names), 'arrays_required');
  const recentById = new Map();
  for (const row of recent) {
    assert(Number.isFinite(Date.parse(row.date)), `invalid_recent_date:${row.matchId}`);
    if (Date.parse(row.date) >= Date.parse('2026-07-01T00:00:00Z')) continue;
    requireMatch(row); assert(!recentById.has(row.matchId), `duplicate_recent_id:${row.matchId}`); recentById.set(row.matchId, row);
  }
  recent = [...recentById.values()];
  const namesById = new Map();
  for (const row of names) { assert(row.match_id && !namesById.has(row.match_id), 'duplicate_or_missing_name_id'); namesById.set(row.match_id, row); }
  const namesToIds = new Map();
  for (const r of recent) {
    const n = namesById.get(r.matchId);
    assert(n && n.home_team_id === r.homeTeamId && n.away_team_id === r.awayTeamId && n.competition === r.competition,
      `name_crosswalk_identity_mismatch:${r.matchId}`);
    for (const side of ['home', 'away']) {
      const name = n[`${side}_team_name`], id = r[`${side}TeamId`];
      assert(name && id, `missing_recent_team_identity:${r.matchId}`);
      add(namesToIds, teamKey(r.competition, name), id);
    }
  }
  const archiveTeamToRecent = new Map();
  for (const r of archive) {
    requireMatch(r);
    const same = recentById.get(r.matchId);
    if (!same) continue;
    assert(compatible(r, same), `overlap_match_conflict:${r.matchId}`);
    const n = namesById.get(r.matchId);
    for (const side of ['home', 'away']) {
      assert(canonicalTeamName(r[`${side}TeamName`]) === canonicalTeamName(n[`${side}_team_name`]), `overlap_team_conflict:${r.matchId}`);
      add(archiveTeamToRecent, `${r.competition}|${r[`${side}TeamId`]}`, same[`${side}TeamId`]);
    }
  }
  const skipped = [], methods = { overlap: 0, canonical: 0, internal: 0 }, merged = new Map(), primaryOrigin = new Map();
  for (const r of recent) {
    const n = namesById.get(r.matchId);
    merged.set(r.matchId, { ...r, homeTeamName: n.home_team_name, awayTeamName: n.away_team_name });
    primaryOrigin.set(r.matchId, Object.fromEntries(Object.keys(statFields).concat(['homeGoals', 'awayGoals', 'homeXG', 'awayXG'])
      .filter(key => r[key] != null).map(key => [key, ['homeGoals', 'awayGoals', 'homeXG', 'awayXG'].includes(key)
        ? 'understat_recent_snapshot_declared' : 'existing_snapshot_field_origin_unverified'])));
  }
  for (const original of archive) {
    const r = { ...original }; let ambiguous = false;
    for (const side of ['home', 'away']) {
      const name = r[`${side}TeamName`], old = r[`${side}TeamId`];
      assert(name && old && canonicalTeamName(name), `archive_team_missing:${r.matchId}`);
      const directSet = archiveTeamToRecent.get(`${r.competition}|${old}`), nameSet = namesToIds.get(teamKey(r.competition, name));
      const direct = only(directSet), canonical = only(nameSet);
      if (directSet?.size > 1 || nameSet?.size > 1 || (direct && canonical && direct !== canonical)) { ambiguous = true; break; }
      const method = direct ? 'overlap' : canonical ? 'canonical' : 'internal';
      r[`${side}TeamId`] = direct || canonical || `archive_internal_${canonicalTeamName(r.competition)}_${canonicalTeamName(name)}`;
      methods[method]++;
    }
    if (ambiguous) { skipped.push({ matchId: r.matchId, reason: 'ambiguous_team_crosswalk' }); continue; }
    const prior = merged.get(r.matchId);
    if (!prior) {
      merged.set(r.matchId, r);
      primaryOrigin.set(r.matchId, Object.fromEntries(Object.keys(statFields).concat(['homeGoals', 'awayGoals', 'homeXG', 'awayXG'])
        .filter(key => r[key] != null).map(key => [key, 'understat_archive'])));
      continue;
    }
    assert(compatible(prior, r) && prior.homeTeamId === r.homeTeamId && prior.awayTeamId === r.awayTeamId,
      `duplicate_match_identity_conflict:${r.matchId}`);
    for (const key of Object.keys(statFields).concat(['homeXG', 'awayXG'])) if (prior[key] == null && r[key] != null) {
      prior[key] = r[key]; primaryOrigin.get(r.matchId)[key] = 'understat_archive';
    }
  }
  const history = [...merged.values()].filter(r => Date.parse(r.date) < Date.parse('2026-07-01T00:00:00Z'))
    .sort((a, b) => a.date.localeCompare(b.date) || a.matchId.localeCompare(b.matchId));
  const index = new Map();
  for (const r of history) add(index, `${r.competition}|${historicalMatchKey(r.date, r.homeTeamName, r.awayTeamName)}`, r.matchId);
  const quoteRows = [], provenance = [], coverage = {}, usedCsvPairs = new Set(), matchedIds = new Set(), csvSources = [];
  for (const r of history) { const k = seasonKey(r); coverage[k] ??= { understat: 0, matchedCsv: 0, bet365Closing: 0, filled: {} }; coverage[k].understat++; }
  for (const source of sources) {
    const season = `${source.seasonStart}/${source.seasonStart + 1}`, pair = `${source.competition}|${season}`;
    assert(!usedCsvPairs.has(pair), `duplicate_csv_competition_season:${pair}`); usedCsvPairs.add(pair);
    const lines = source.text.split(/\r?\n/), header = lines[0].replace(/^\uFEFF/, '').split(',');
    const columns = ['B365CH', 'B365CD', 'B365CA'];
    const closingAvailable = columns.every(name => header.includes(name));
    csvSources.push({ file: source.file, sha256: source.sha256, competition: source.competition, season,
      archiveAcquiredAt: source.archiveAcquiredAt, bet365ClosingColumnsPresent: closingAvailable });
    // Never let the canonical parser prefer an average over the explicitly requested Bet365 closing columns.
    lines[0] = header.map(name => ['AvgCH', 'AvgCD', 'AvgCA'].includes(name) ? `excluded_${name}` : name).join(',');
    const csvRows = parseFootballDataCsv(lines.join('\n'));
    const grouped = new Map();
    for (const r of csvRows) add(grouped, `${source.competition}|${historicalMatchKey(r.date, r.homeTeam, r.awayTeam)}`, r);
    for (const [key, rows] of grouped) {
      const row = only(rows), matches = index.get(key), id = only(matches);
      if (!row || !id) { skipped.push({ source: source.file, key, reason: !row ? 'ambiguous_csv_rows' : matches?.size > 1 ? 'ambiguous_understat_match' : 'unmatched_csv' }); continue; }
      const match = merged.get(id);
      if (match.season !== season || match.homeGoals !== row.homeGoals || match.awayGoals !== row.awayGoals) {
        skipped.push({ source: source.file, matchId: id, reason: 'season_or_score_mismatch' }); continue;
      }
      const stats = coverage[pair]; stats.matchedCsv++; matchedIds.add(id);
      for (const [field, csvField] of Object.entries(statFields)) {
        const incoming = row[csvField];
        if (match[field] == null && incoming != null && (field === 'referee' || Number.isFinite(incoming) && incoming >= 0)) {
          match[field] = incoming; stats.filled[field] = (stats.filled[field] || 0) + 1;
          primaryOrigin.get(id)[field] = `football_data_csv:${source.sha256}`;
          provenance.push({ matchId: id, field, source: 'football_data_csv', sourceFile: source.file, sourceSha256: source.sha256 });
        }
      }
      const market = closingAvailable ? buildMarketOddsJson(row) : null;
      const c = market?.closing;
      if (c && ['homeWin', 'draw', 'awayWin'].every(k => Number.isFinite(c[k]) && c[k] > 1)) {
        quoteRows.push({ matchId: id, competition: match.competition, season: match.season, kickoffAt: match.date,
          bookmaker: 'Bet365', source: 'football_data_csv', priceType: 'closing', archiveAcquiredAt: source.archiveAcquiredAt,
          prices: [c.homeWin, c.draw, c.awayWin], sourceFile: source.file, sourceSha256: source.sha256, sourceColumns: columns });
        stats.bet365Closing++;
      }
    }
  }
  assert(new Set(quoteRows.map(x => x.matchId)).size === quoteRows.length, 'duplicate_closing_quote_match');
  return { history, quotes: { rows: quoteRows }, audit: { coverage, skipped, crosswalkMethods: methods, supplementalProvenance: provenance,
    historicalMatchAliases: HISTORICAL_MATCH_ALIASES,
    csvSources, unmatchedUnderstat: history.filter(row => usedCsvPairs.has(seasonKey(row)) && !matchedIds.has(row.matchId))
      .map(row => ({ matchId: row.matchId, competition: row.competition, season: row.season })),
    fieldProvenance: Object.fromEntries(history.map(row => [row.matchId, primaryOrigin.get(row.matchId)])),
    closingQuoteNote: 'Closing prices from historical CSV are not verified available before kickoff; no pre-match or ROI claim.',
    identityPolicy: 'Recent IDs are preserved; archive-only unmatched canonical identities use explicit archive_internal namespace.' } };
}

function main() {
  const args = process.argv.slice(2), options = {};
  for (let i = 0; i < args.length; i += 2) { assert(args[i]?.startsWith('--') && args[i + 1], 'named_arguments_required'); options[args[i].slice(2)] = args[i + 1]; }
  for (const key of ['archive', 'recent', 'names', 'csv-manifest', 'out']) assert(options[key], `missing_argument:${key}`);
  assert(!fs.existsSync(options.out), 'output_directory_must_not_exist');
  const archive = read(options.archive), recent = read(options.recent), names = read(options.names), manifest = read(options['csv-manifest']);
  assert(Array.isArray(manifest.value.sources), 'csv_sources_required');
  const sources = manifest.value.sources.map(s => {
    assert(typeof s.file === 'string' && /^[a-f0-9]{64}$/.test(s.sha256) && Number.isInteger(s.seasonStart)
      && Number.isFinite(Date.parse(s.archiveAcquiredAt)) && typeof s.competition === 'string', 'invalid_csv_manifest_entry');
    const file = resolveCsvPath(s.file, options['csv-manifest']);
    const bytes = fs.readFileSync(file); assert(hash(bytes) === s.sha256, `csv_hash_mismatch:${s.file}`);
    return { ...s, text: bytes.toString('utf8') };
  });
  const result = prepare(archive.value, recent.value, names.value, sources);
  result.audit.inputHashes = { archive: archive.sha256, recent: recent.sha256, names: names.sha256, csvManifest: manifest.sha256 };
  fs.mkdirSync(options.out, { recursive: false });
  for (const [name, value] of [['history.json', result.history], ['quotes.json', result.quotes], ['input-audit.json', result.audit]])
    fs.writeFileSync(path.join(options.out, name), JSON.stringify(value));
  console.log(JSON.stringify({ historyRows: result.history.length, quotes: result.quotes.rows.length, output: options.out }));
}
if (require.main === module) main();
module.exports = { prepare, resolveCsvPath };
