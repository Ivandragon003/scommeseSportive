import { createHash } from 'node:crypto';
import type { Client } from '@libsql/client';
import {
  canonicalTeamName, createLibsqlFootballDataDb, FOOTBALL_DATA_LEAGUE_CODES,
  matchKey, parseFootballDataCsv, seasonToFootballDataCode, syncFootballData,
  type FootballDataDb, type FootballDataRow, type FootballDataSyncSummary, type LibsqlLike,
} from './FootballDataService';

const FIELDS = ['home_shots', 'away_shots', 'home_shots_on_target', 'away_shots_on_target',
  'home_fouls', 'away_fouls', 'home_corners', 'away_corners', 'home_yellow_cards', 'away_yellow_cards',
  'home_red_cards', 'away_red_cards', 'referee'] as const;
const COUNT_COLUMNS = ['HS', 'AS', 'HST', 'AST', 'HF', 'AF', 'HC', 'AC', 'HY', 'AY', 'HR', 'AR'];

export type CapturedSupplementInput = {
  client: Client; csv: string; competition: string; seasonStart: number;
  acquiredAt: string; asOf: string; sourceUrl: string; sha256: string;
};
export type CapturedSupplementResult = {
  csvRows: number; eligibleRows: number; unmatchedRows: number; ambiguousRows: number; scoreMismatchRows: number;
  updatedMatchIds: string[]; updatedTeamIds: string[]; summary: FootballDataSyncSummary | null;
};

function timestamp(value: string): number {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return NaN;
  const time = Date.parse(value);
  const day = value.slice(0, 10);
  const calendar = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(time) && Number.isFinite(calendar.getTime()) && calendar.toISOString().slice(0, 10) === day ? time : NaN;
}
function count(value: unknown): number | null {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'string' && !value.trim())) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Import a previously captured CSV inside one explicit caller-visible transaction. */
export async function importCapturedSupplement(input: CapturedSupplementInput): Promise<CapturedSupplementResult> {
  const code = FOOTBALL_DATA_LEAGUE_CODES[input.competition];
  if (!code || !Number.isInteger(input.seasonStart) || input.seasonStart < 2000 || input.seasonStart > 9998) throw new Error('supplement_scope_invalid');
  if (typeof input.csv !== 'string' || !/^[a-f0-9]{64}$/.test(input.sha256 ?? '')
    || createHash('sha256').update(input.csv, 'utf8').digest('hex') !== input.sha256) throw new Error('supplement_hash_invalid');
  const acquired = timestamp(input.acquiredAt), asOf = timestamp(input.asOf);
  if (!Number.isFinite(acquired) || !Number.isFinite(asOf) || acquired > asOf) throw new Error('supplement_time_invalid');
  let url: URL;
  try { url = new URL(input.sourceUrl); } catch { throw new Error('supplement_source_invalid'); }
  const sourcePath = `/mmz4281/${seasonToFootballDataCode(input.seasonStart)}/${code}.csv`;
  if (url.protocol !== 'https:' || url.hostname !== 'www.football-data.co.uk' || url.port || url.username || url.password
    || url.pathname !== sourcePath || url.search || url.hash) throw new Error('supplement_source_invalid');
  const lines = input.csv.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2 || lines.some((line) => line.includes('"'))) throw new Error('supplement_csv_invalid');
  const header = lines[0].replace(/^\uFEFF/, '').split(',');
  const required = ['Div', 'Date', 'HomeTeam', 'AwayTeam', 'FTHG', 'FTAG'];
  if (required.some((name) => header.filter((col) => col === name).length !== 1)
    || COUNT_COLUMNS.some((name) => header.filter((col) => col === name).length > 1)) throw new Error('supplement_header_invalid');
  const fields = lines.slice(1).map((line) => line.split(','));
  for (const cols of fields) {
    if (cols.length !== header.length || cols[header.indexOf('Div')]?.trim() !== code) throw new Error('supplement_scope_invalid');
    const rawDate = cols[header.indexOf('Date')]?.trim();
    const m = /^(\d{2})\/(\d{2})\/(\d{2}|\d{4})$/.exec(rawDate ?? '');
    if (!m) throw new Error('supplement_date_invalid');
    const year = Number(m[3].length === 2 ? `20${m[3]}` : m[3]);
    const iso = `${year}-${m[2]}-${m[1]}`;
    const date = new Date(`${iso}T00:00:00Z`);
    if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== iso
      || iso < `${input.seasonStart}-07-01` || iso >= `${input.seasonStart + 1}-07-01`
      || date.getTime() > acquired) throw new Error('supplement_date_invalid');
    if (count(cols[header.indexOf('FTHG')]) === null || count(cols[header.indexOf('FTAG')]) === null) throw new Error('supplement_score_invalid');
    for (const name of COUNT_COLUMNS) {
      const index = header.indexOf(name);
      if (index >= 0 && cols[index]?.trim() && count(cols[index]) === null) throw new Error('supplement_count_invalid');
    }
  }
  const parsed = parseFootballDataCsv(input.csv);
  if (parsed.length !== fields.length || parsed.some((row) => !canonicalTeamName(row.homeTeam) || !canonicalTeamName(row.awayTeam)
    || canonicalTeamName(row.homeTeam) === canonicalTeamName(row.awayTeam))) throw new Error('supplement_csv_invalid');

  const tx = await input.client.transaction('write');
  try {
    // Expose only execute: the existing adapter must not create nested batches.
    const executor: LibsqlLike = { execute: (statement) => tx.execute(statement as any) };
    const adapter = createLibsqlFootballDataDb(executor);
    const candidates = await adapter.getMatchesForCompetition(input.competition, [input.seasonStart]);
    const scores = await tx.execute({ sql: `SELECT match_id, home_goals, away_goals, source, source_match_id, date FROM matches
      WHERE competition = ? AND date >= ? AND date < ?`,
    args: [input.competition, `${input.seasonStart}-07-01`, `${input.seasonStart + 1}-07-01`] });
    const byId = new Map(scores.rows.map((row) => [String(row.match_id), row]));
    const index = new Map<string, typeof candidates>();
    for (const match of candidates) {
      const row = byId.get(match.match_id);
      const providerId = count(row?.source_match_id);
      const allowedSource = row?.source === 'understat' || (row?.source === 'football_data_org'
        && providerId !== null && providerId > 0 && match.match_id === `football_data_org_${providerId}`);
      if (!row || !allowedSource || count(row.home_goals) === null || count(row.away_goals) === null
        || !Number.isFinite(Date.parse(String(row.date))) || Date.parse(String(row.date)) > acquired) continue;
      const key = matchKey(match.date, match.home_team_name ?? '', match.away_team_name ?? '');
      index.set(key, [...(index.get(key) ?? []), match]);
    }
    const sourceCounts = new Map<string, number>();
    for (const row of parsed) { const key = matchKey(row.date, row.homeTeam, row.awayTeam); sourceCounts.set(key, (sourceCounts.get(key) ?? 0) + 1); }
    let unmatchedRows = 0, ambiguousRows = 0, scoreMismatchRows = 0;
    const eligibleLines: string[] = [];
    const eligibleIds = new Set<string>();
    for (const [i, row] of parsed.entries()) {
      const key = matchKey(row.date, row.homeTeam, row.awayTeam), found = index.get(key) ?? [];
      if (!found.length) { unmatchedRows++; continue; }
      if (found.length !== 1 || sourceCounts.get(key)! > 1) { ambiguousRows++; continue; }
      const score = byId.get(found[0].match_id)!;
      if (count(score.home_goals) !== row.homeGoals || count(score.away_goals) !== row.awayGoals) { scoreMismatchRows++; continue; }
      eligibleLines.push(lines[i + 1]);
      eligibleIds.add(found[0].match_id);
    }
    const empty = (): CapturedSupplementResult => ({ csvRows: parsed.length, eligibleRows: 0, unmatchedRows, ambiguousRows, scoreMismatchRows,
      updatedMatchIds: [], updatedTeamIds: [], summary: null });
    if (!eligibleLines.length) { await tx.commit(); return empty(); }
    const wrapped: FootballDataDb = {
      getMatchesForCompetition: async (competition, years) =>
        (await adapter.getMatchesForCompetition(competition, years)).filter((match) => eligibleIds.has(match.match_id)),
      saveMarketOdds: async () => false,
      fillSupplementalStats: async (matchId: string, row: FootballDataRow) => {
        const before = (await tx.execute({ sql: `SELECT ${FIELDS.join(', ')}, raw_json FROM matches WHERE match_id = ?`, args: [matchId] })).rows[0];
        if (!before) throw new Error('supplement_match_missing');
        let raw: Record<string, unknown>;
        if (before.raw_json == null) raw = {};
        else {
          try { const parsedRaw = JSON.parse(String(before.raw_json)); if (!object(parsedRaw)) throw new Error('invalid'); raw = parsedRaw; }
          catch { throw new Error('supplement_raw_invalid'); }
        }
        const existing = raw.fieldProvenance;
        if (existing !== undefined && !object(existing)) throw new Error('supplement_provenance_invalid');
        const changed = await adapter.fillSupplementalStats(matchId, row);
        if (!changed) return false;
        const after = (await tx.execute({ sql: `SELECT ${FIELDS.join(', ')} FROM matches WHERE match_id = ?`, args: [matchId] })).rows[0];
        if (!after) throw new Error('supplement_match_missing');
        const provenance = existing as Record<string, unknown> | undefined;
        const additions: Array<{ field: string; evidence: string }> = [];
        for (const field of FIELDS) {
          const wasMissing = field === 'referee' ? !String(before[field] ?? '').trim() : before[field] == null;
          const isPresent = field === 'referee' ? !!String(after[field] ?? '').trim() : after[field] != null;
          if (!wasMissing || !isPresent) continue;
          if (provenance && Object.prototype.hasOwnProperty.call(provenance, field)) throw new Error('supplement_provenance_conflict');
          additions.push({ field, evidence: JSON.stringify({ source: 'football-data.co.uk', sourceUrl: input.sourceUrl,
            acquiredAt: input.acquiredAt, payloadSha256: input.sha256, version: 'football-data-supplement-v1' }) });
        }
        if (!additions.length) throw new Error('supplement_change_unverified');
        const duplicateRoots = await tx.execute({ sql: `SELECT COUNT(*) AS count FROM json_each(COALESCE(?, '{}')) WHERE key = 'fieldProvenance'`,
          args: [before.raw_json] });
        if (Number(duplicateRoots.rows[0]?.count ?? 0) > 1) throw new Error('supplement_provenance_invalid');
        const paths = additions.map(() => '?, json(?)').join(', ');
        const args = additions.flatMap(({ field, evidence }) => [`$.fieldProvenance.${field}`, evidence]);
        await tx.execute({ sql: `UPDATE matches SET raw_json = json_set(COALESCE(raw_json, '{}'), ${paths}) WHERE match_id = ?`,
          args: [...args, matchId] });
        return true;
      },
    };
    const filteredCsv = [lines[0], ...eligibleLines].join('\n');
    const summary = await syncFootballData(wrapped, { competitions: [input.competition], seasonStartYears: [input.seasonStart],
      now: new Date(asOf), fetcher: async (league, season) => {
        if (league !== code || season !== seasonToFootballDataCode(input.seasonStart)) throw new Error('supplement_scope_invalid');
        return filteredCsv;
      } });
    if (summary.errors.length || summary.pending || summary.matched !== eligibleLines.length || summary.oddsWritten !== 0) throw new Error('supplement_sync_failed');
    await tx.commit();
    return { csvRows: parsed.length, eligibleRows: eligibleLines.length, unmatchedRows, ambiguousRows, scoreMismatchRows,
      updatedMatchIds: summary.updatedMatchIds, updatedTeamIds: summary.updatedTeamIds, summary };
  } catch (error) {
    await tx.rollback();
    throw error;
  }
}
