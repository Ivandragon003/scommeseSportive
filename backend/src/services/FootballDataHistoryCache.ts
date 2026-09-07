import { createHash } from 'node:crypto';
import type { LibsqlLike, FootballDataFetcher } from './FootballDataService';

export type VerifiedFootballDataCsv = {
  csv: string;
  sha256: string;
  version: number;
  verifiedAt: string;
};

export interface FootballDataHistoryStore {
  get(leagueCode: string, seasonStart: number): Promise<VerifiedFootballDataCsv | null>;
  put(leagueCode: string, seasonStart: number, entry: VerifiedFootballDataCsv): Promise<void>;
}

export function createFootballDataHistoryStore(client: LibsqlLike): FootballDataHistoryStore {
  return {
    async get(leagueCode, seasonStart) {
      const result = await client.execute({
        sql: 'SELECT csv, sha256, version, verified_at FROM football_data_verified_csv WHERE league_code = ? AND season_start = ?',
        args: [leagueCode, seasonStart],
      });
      const row = result.rows[0];
      return row ? { csv: String(row.csv), sha256: String(row.sha256), version: Number(row.version), verifiedAt: String(row.verified_at) } : null;
    },
    async put(leagueCode, seasonStart, entry) {
      await client.execute({
        sql: `INSERT INTO football_data_verified_csv (league_code, season_start, csv, sha256, version, verified_at)
              VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(league_code, season_start) DO UPDATE SET
              csv = excluded.csv, sha256 = excluded.sha256, version = excluded.version, verified_at = excluded.verified_at`,
        args: [leagueCode, seasonStart, entry.csv, entry.sha256, entry.version, entry.verifiedAt],
      });
    },
  };
}

const VERSION = 1;
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const hash = (csv: string) => createHash('sha256').update(csv).digest('hex');

/** A cache hit only replaces HTTP: callers must still validate and repair DB coverage. */
export async function loadFootballDataCsv(params: {
  leagueCode: string; seasonStart: number; currentSeasonStart: number;
  seasonCode: string; fetcher: FootballDataFetcher; now: Date;
  store?: FootballDataHistoryStore; forceRefresh?: boolean;
}): Promise<{ csv: string | null; reused: boolean; markVerified: () => Promise<void> }> {
  const { store, leagueCode, seasonStart, now } = params;
  const historical = seasonStart < params.currentSeasonStart;
  if (store && historical && !params.forceRefresh) {
    const entry = await store.get(leagueCode, seasonStart);
    const age = entry ? now.getTime() - Date.parse(entry.verifiedAt) : NaN;
    if (entry && entry.version === VERSION && age >= 0 && age < MAX_AGE_MS && hash(entry.csv) === entry.sha256) {
      return { csv: entry.csv, reused: true, markVerified: async () => {} };
    }
  }
  const csv = await params.fetcher(leagueCode, params.seasonCode);
  return {
    csv, reused: false,
    markVerified: async () => {
      if (store && historical && csv) {
        await store.put(leagueCode, seasonStart, { csv, sha256: hash(csv), version: VERSION, verifiedAt: now.toISOString() });
      }
    },
  };
}
