// FootballDataService — fonte statistiche SUPPLEMENTARE via football-data.co.uk.
//
// Understat resta la fonte PRIMARIA (goal, xG, tiri, giocatori). football-data.co.uk
// riempie via HTTP/CSV i campi che Understat copre male o per niente: tiri, tiri in
// porta, gialli, rossi, FALLI, CORNER, ARBITRO. È una fonte HTTP stabile (no browser,
// no anti-bot, no API key), coerente con AGENTS.md §8. Sostituisce lo scraper
// SofaScore (Playwright) per questi campi; l'unico dato non coperto è il possesso.
//
// Scrittura NON distruttiva: riempie solo le colonne attualmente NULL
// (UPDATE ... = COALESCE(col, :nuovo)), quindi non sovrascrive mai i valori Understat.

export const FOOTBALL_DATA_LEAGUE_CODES: Record<string, string> = {
  'Serie A': 'I1',
  'Premier League': 'E0',
  'La Liga': 'SP1',
  'Bundesliga': 'D1',
  'Ligue 1': 'F1',
};

/** Codici stagione football-data (es. '2425' = 2024/25). */
export function seasonToFootballDataCode(seasonStartYear: number): string {
  const a = String(seasonStartYear).slice(-2);
  const b = String(seasonStartYear + 1).slice(-2);
  return `${a}${b}`;
}

/**
 * Anno d'inizio della stagione corrente per una data. Le stagioni europee
 * iniziano ad agosto: da luglio in poi si punta alla stagione che sta per
 * iniziare (evita di rincorrere quella conclusa nel pre-campionato).
 */
export function currentSeasonStartYear(now: Date = new Date()): number {
  const y = now.getUTCFullYear();
  return now.getUTCMonth() >= 6 ? y : y - 1; // getUTCMonth: 6 = luglio
}

/** Etichetta stagione 'YYYY/YYYY' da anno d'inizio (formato usato nel DB). */
export function seasonLabel(seasonStartYear: number): string {
  return `${seasonStartYear}/${seasonStartYear + 1}`;
}

/**
 * Alias nome-squadra: chiave = nome football-data normalizzato, valore = nome DB
 * (Understat) normalizzato. Solo le squadre che differiscono dopo la
 * normalizzazione. Costruito verificando i nomi reali di DB e CSV su 5 leghe.
 */
const TEAM_ALIASES: Record<string, string> = {
  // Serie A
  inter: 'internazionale', milan: 'acmilan', parma: 'parmacalcio1913',
  // Premier League
  mancity: 'manchestercity', manunited: 'manchesterunited', newcastle: 'newcastleunited',
  nottmforest: 'nottinghamforest', wolves: 'wolverhamptonwanderers',
  // La Liga
  athbilbao: 'athleticclub', athmadrid: 'atleticomadrid', celta: 'celtavigo',
  espanol: 'espanyol', oviedo: 'realoviedo', sociedad: 'realsociedad',
  valladolid: 'realvalladolid', vallecano: 'rayovallecano', betis: 'realbetis',
  // Bundesliga
  leverkusen: 'bayerleverkusen', dortmund: 'borussiadortmund', mgladbach: 'borussiamgladbach',
  einfrankfurt: 'eintrachtfrankfurt', fckoln: 'fccologne', heidenheim: 'fcheidenheim',
  hamburg: 'hamburgersv', mainz: 'mainz05', rbleipzig: 'rasenballsportleipzig',
  stuttgart: 'vfbstuttgart',
  // Ligue 1
  parissg: 'parissaintgermain', psg: 'parissaintgermain', marseille: 'olympiquemarseille',
  lyon: 'olympiquelyonnais', stetienne: 'saintetienne', lehavre: 'havreac',
  clermont: 'clermontfoot',
  // squadre retrocesse / stagioni passate
  hertha: 'herthaberlin',
};

function normalizeTeam(name: string): string {
  return String(name ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Nome squadra canonico (allineato ai nomi DB Understat) per il matching. */
export function canonicalTeamName(name: string): string {
  const n = normalizeTeam(name);
  return TEAM_ALIASES[n] ?? n;
}

export interface FootballDataRow {
  date: string;            // ISO yyyy-mm-dd
  homeTeam: string;
  awayTeam: string;
  homeShots: number | null;
  awayShots: number | null;
  homeShotsOnTarget: number | null;
  awayShotsOnTarget: number | null;
  homeFouls: number | null;
  awayFouls: number | null;
  homeCorners: number | null;
  awayCorners: number | null;
  homeYellow: number | null;
  awayYellow: number | null;
  homeRed: number | null;
  awayRed: number | null;
  referee: string | null;
}

const numOrNull = (v: string | undefined): number | null => {
  if (v === undefined) return null;
  const s = v.trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
};

/** Parsa un CSV football-data.co.uk in righe tipizzate (solo campi supplementari). */
export function parseFootballDataCsv(text: string): FootballDataRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = lines[0].replace(/^﻿/, '').split(',');
  const col = (name: string) => header.indexOf(name);
  const iDate = col('Date'), iHome = col('HomeTeam'), iAway = col('AwayTeam');
  if (iDate < 0 || iHome < 0 || iAway < 0) return [];
  const iHS = col('HS'), iAS = col('AS'), iHST = col('HST'), iAST = col('AST');
  const iHF = col('HF'), iAF = col('AF'), iHC = col('HC'), iAC = col('AC');
  const iHY = col('HY'), iAY = col('AY'), iHR = col('HR'), iAR = col('AR');
  const iRef = col('Referee');

  const out: FootballDataRow[] = [];
  for (let i = 1; i < lines.length; i++) {
    const c = lines[i].split(',');
    if (c.length <= Math.max(iDate, iHome, iAway)) continue;
    const raw = c[iDate]?.trim();
    const m = raw && raw.match(/^(\d{2})\/(\d{2})\/(\d{2,4})$/);
    if (!m) continue;
    const yyyy = m[3].length === 2 ? `20${m[3]}` : m[3];
    const date = `${yyyy}-${m[2]}-${m[1]}`;
    const home = c[iHome]?.trim(), away = c[iAway]?.trim();
    if (!home || !away) continue;
    out.push({
      date, homeTeam: home, awayTeam: away,
      homeShots: numOrNull(c[iHS]), awayShots: numOrNull(c[iAS]),
      homeShotsOnTarget: numOrNull(c[iHST]), awayShotsOnTarget: numOrNull(c[iAST]),
      homeFouls: numOrNull(c[iHF]), awayFouls: numOrNull(c[iAF]),
      homeCorners: numOrNull(c[iHC]), awayCorners: numOrNull(c[iAC]),
      homeYellow: numOrNull(c[iHY]), awayYellow: numOrNull(c[iAY]),
      homeRed: numOrNull(c[iHR]), awayRed: numOrNull(c[iAR]),
      referee: iRef >= 0 ? (c[iRef]?.trim() || null) : null,
    });
  }
  return out;
}

/** Chiave di matching data+squadre canoniche. */
export function matchKey(dateIso: string, home: string, away: string): string {
  return `${String(dateIso).slice(0, 10)}|${canonicalTeamName(home)}|${canonicalTeamName(away)}`;
}

export interface FootballDataDbMatch {
  match_id: string;
  date: string;
  home_team_name: string | null;
  away_team_name: string | null;
}

export interface FootballDataDb {
  /** Match completati di una competizione dal 2024-08-01 (per il matching). */
  getMatchesForCompetition(competition: string): Promise<FootballDataDbMatch[]>;
  /** Riempie SOLO i campi NULL del match (COALESCE existing-wins). Ritorna true se una riga è stata toccata. */
  fillSupplementalStats(matchId: string, row: FootballDataRow): Promise<boolean>;
}

export interface FootballDataFetcher {
  (leagueCode: string, seasonCode: string): Promise<string | null>;
}

/** Fetcher HTTP di default (Node 20+ global fetch). */
export const defaultFootballDataFetcher: FootballDataFetcher = async (leagueCode, seasonCode) => {
  const url = `https://www.football-data.co.uk/mmz4281/${seasonCode}/${leagueCode}.csv`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!res.ok) return null;
  return await res.text();
};

export interface FootballDataSyncOptions {
  competitions?: string[];
  seasonStartYears?: number[]; // es. [2024, 2025]
  fetcher?: FootballDataFetcher;
}

export interface FootballDataSyncSummary {
  csvRows: number;
  matched: number;
  updated: number;
  unmatchedTeams: string[];
  perCompetition: Record<string, { csvRows: number; matched: number; updated: number }>;
}

/**
 * Scarica i CSV football-data per le competizioni/stagioni richieste, li matcha ai
 * match del DB (data + squadre canoniche) e riempie i campi supplementari NULL.
 */
export async function syncFootballData(
  db: FootballDataDb,
  options: FootballDataSyncOptions = {}
): Promise<FootballDataSyncSummary> {
  const competitions = options.competitions ?? Object.keys(FOOTBALL_DATA_LEAGUE_CODES);
  const seasons = options.seasonStartYears ?? [2024, 2025];
  const fetcher = options.fetcher ?? defaultFootballDataFetcher;

  const summary: FootballDataSyncSummary = { csvRows: 0, matched: 0, updated: 0, unmatchedTeams: [], perCompetition: {} };
  const unmatched = new Set<string>();

  for (const competition of competitions) {
    const leagueCode = FOOTBALL_DATA_LEAGUE_CODES[competition];
    if (!leagueCode) continue;

    const dbMatches = await db.getMatchesForCompetition(competition);
    const index = new Map<string, FootballDataDbMatch>();
    const dbTeams = new Set<string>();
    for (const m of dbMatches) {
      index.set(matchKey(String(m.date).slice(0, 10), m.home_team_name ?? '', m.away_team_name ?? ''), m);
      dbTeams.add(canonicalTeamName(m.home_team_name ?? ''));
      dbTeams.add(canonicalTeamName(m.away_team_name ?? ''));
    }

    const perComp = { csvRows: 0, matched: 0, updated: 0 };
    for (const seasonStart of seasons) {
      const csv = await fetcher(leagueCode, seasonToFootballDataCode(seasonStart));
      if (!csv) continue;
      const rows = parseFootballDataCsv(csv);
      perComp.csvRows += rows.length;
      for (const row of rows) {
        const hit = index.get(matchKey(row.date, row.homeTeam, row.awayTeam));
        if (!hit) {
          if (!dbTeams.has(canonicalTeamName(row.homeTeam))) unmatched.add(row.homeTeam);
          if (!dbTeams.has(canonicalTeamName(row.awayTeam))) unmatched.add(row.awayTeam);
          continue;
        }
        perComp.matched += 1;
        const changed = await db.fillSupplementalStats(hit.match_id, row);
        if (changed) perComp.updated += 1;
      }
    }
    summary.perCompetition[competition] = perComp;
    summary.csvRows += perComp.csvRows;
    summary.matched += perComp.matched;
    summary.updated += perComp.updated;
  }
  summary.unmatchedTeams = [...unmatched].sort();
  return summary;
}

// ---------------------------------------------------------------------------
// Adapter libSQL + retention stagioni
// ---------------------------------------------------------------------------

/** Minimo sottoinsieme del client libSQL usato qui. */
export interface LibsqlLike {
  execute(query: { sql: string; args?: any } | string): Promise<{ rows: any[]; rowsAffected?: number }>;
}

/** Colonne supplementari riempite (solo dove NULL). */
const SUPPLEMENTAL_COLS = [
  'home_shots', 'away_shots', 'home_shots_on_target', 'away_shots_on_target',
  'home_fouls', 'away_fouls', 'home_corners', 'away_corners',
  'home_yellow_cards', 'away_yellow_cards', 'home_red_cards', 'away_red_cards',
];

/** Costruisce un FootballDataDb su un client libSQL. Scrittura non distruttiva (COALESCE). */
export function createLibsqlFootballDataDb(client: LibsqlLike): FootballDataDb {
  return {
    async getMatchesForCompetition(competition: string) {
      const res = await client.execute({
        sql: `SELECT match_id, date, home_team_name, away_team_name FROM matches
              WHERE competition = ? AND date >= '2022-08-01' AND home_goals IS NOT NULL`,
        args: [competition],
      });
      return res.rows.map((r) => ({
        match_id: String(r.match_id),
        date: String(r.date),
        home_team_name: r.home_team_name ?? null,
        away_team_name: r.away_team_name ?? null,
      }));
    },
    async fillSupplementalStats(matchId: string, row: FootballDataRow) {
      const nullCond = SUPPLEMENTAL_COLS.map((c) => `${c} IS NULL`).join(' OR ')
        + ` OR referee IS NULL OR TRIM(referee) = ''`;
      const res = await client.execute({
        sql: `UPDATE matches SET
          home_shots = COALESCE(home_shots, :hs), away_shots = COALESCE(away_shots, :as_),
          home_shots_on_target = COALESCE(home_shots_on_target, :hst), away_shots_on_target = COALESCE(away_shots_on_target, :ast),
          home_fouls = COALESCE(home_fouls, :hf), away_fouls = COALESCE(away_fouls, :af),
          home_corners = COALESCE(home_corners, :hc), away_corners = COALESCE(away_corners, :ac),
          home_yellow_cards = COALESCE(home_yellow_cards, :hy), away_yellow_cards = COALESCE(away_yellow_cards, :ay),
          home_red_cards = COALESCE(home_red_cards, :hr), away_red_cards = COALESCE(away_red_cards, :ar),
          referee = COALESCE(NULLIF(TRIM(referee), ''), :ref)
          WHERE match_id = :id AND (${nullCond})`,
        args: {
          hs: row.homeShots, as_: row.awayShots, hst: row.homeShotsOnTarget, ast: row.awayShotsOnTarget,
          hf: row.homeFouls, af: row.awayFouls, hc: row.homeCorners, ac: row.awayCorners,
          hy: row.homeYellow, ay: row.awayYellow, hr: row.homeRed, ar: row.awayRed,
          ref: row.referee, id: matchId,
        },
      });
      return Number(res.rowsAffected ?? 0) > 0;
    },
  };
}

export interface PruneSummary {
  seasonsKept: string[];
  seasonsDeleted: string[];
  matchesDeleted: number;
  oddsDeleted: number;
}

/**
 * Retention: tiene solo le `keepCount` stagioni più recenti (per anno d'inizio),
 * elimina le più vecchie e gli odds_snapshots orfani. Libera lo spazio del
 * raw_json pesante. Safeguard: non fa nulla se le stagioni presenti sono ≤ keepCount.
 * Le stagioni con label non standard (null/'') non vengono mai toccate.
 */
export async function pruneOldSeasons(client: LibsqlLike, keepCount = 4): Promise<PruneSummary> {
  const res = await client.execute({
    sql: `SELECT season, COUNT(*) n FROM matches WHERE season IS NOT NULL AND TRIM(season) <> '' GROUP BY season`,
  });
  const seasons = res.rows
    .map((r) => ({ label: String(r.season), start: Number(String(r.season).slice(0, 4)) }))
    .filter((s) => Number.isFinite(s.start))
    .sort((a, b) => b.start - a.start);

  if (seasons.length <= keepCount) {
    return { seasonsKept: seasons.map((s) => s.label), seasonsDeleted: [], matchesDeleted: 0, oddsDeleted: 0 };
  }
  const keep = seasons.slice(0, keepCount);
  const drop = seasons.slice(keepCount);
  let matchesDeleted = 0, oddsDeleted = 0;
  for (const s of drop) {
    // odds_snapshots orfani prima (FK logica), poi i match
    try {
      const o = await client.execute({
        sql: `DELETE FROM odds_snapshots WHERE match_id IN (SELECT match_id FROM matches WHERE season = ?)`,
        args: [s.label],
      });
      oddsDeleted += Number(o.rowsAffected ?? 0);
    } catch { /* tabella odds assente in alcuni ambienti */ }
    const m = await client.execute({ sql: `DELETE FROM matches WHERE season = ?`, args: [s.label] });
    matchesDeleted += Number(m.rowsAffected ?? 0);
  }
  return { seasonsKept: keep.map((s) => s.label), seasonsDeleted: drop.map((s) => s.label), matchesDeleted, oddsDeleted };
}
