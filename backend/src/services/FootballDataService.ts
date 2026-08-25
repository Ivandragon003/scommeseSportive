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

// Historical second divisions used only for the promotion/relegation audit.
// They are not added to the active match-ingestion catalog.
export const FOOTBALL_DATA_TRANSITION_LEAGUE_CODES: Record<string, string> = {
  'Serie B': 'I2',
  Championship: 'E1',
  '2. Bundesliga': 'D2',
  'Ligue 2': 'F2',
  'Segunda Division': 'SP2',
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

export const DEFAULT_SEASON_RETENTION_COUNT = 5;

/** Finestra mobile, dalla stagione piu vecchia alla corrente. */
export function buildSeasonWindow(
  now: Date = new Date(),
  keepCount = DEFAULT_SEASON_RETENTION_COUNT,
): string[] {
  const count = Math.max(1, Math.trunc(keepCount));
  const current = currentSeasonStartYear(now);
  return Array.from({ length: count }, (_, index) => seasonLabel(current - count + index + 1));
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
  santander: 'racingsantander', lacoruna: 'deportivolacoruna',
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
  homeGoals: number | null;
  awayGoals: number | null;
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
  // Quote di mercato (media bookmaker). Apertura = Avg*/B365*, chiusura = AvgC*/B365C*.
  // La "C" nel nome football-data.co.uk = Closing. Servono per backtest ROI/CLV reale.
  oddsHome: number | null;
  oddsDraw: number | null;
  oddsAway: number | null;
  oddsOver25: number | null;
  oddsUnder25: number | null;
  closingHome: number | null;
  closingDraw: number | null;
  closingAway: number | null;
  closingOver25: number | null;
  closingUnder25: number | null;
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
  const first = lines[0].charCodeAt(0) === 0xFEFF ? lines[0].slice(1) : lines[0];
  const header = first.split(',');
  const col = (name: string) => header.indexOf(name);
  const iDate = col('Date'), iHome = col('HomeTeam'), iAway = col('AwayTeam');
  if (iDate < 0 || iHome < 0 || iAway < 0) return [];
  const iHS = col('HS'), iAS = col('AS'), iHST = col('HST'), iAST = col('AST');
  const iHF = col('HF'), iAF = col('AF'), iHC = col('HC'), iAC = col('AC');
  const iHY = col('HY'), iAY = col('AY'), iHR = col('HR'), iAR = col('AR');
  const iRef = col('Referee');
  // Quote: prima colonna presente tra i candidati (media mercato, poi Bet365).
  const firstCol = (...names: string[]): number => {
    for (const n of names) { const idx = header.indexOf(n); if (idx >= 0) return idx; }
    return -1;
  };
  const iOH = firstCol('AvgH', 'BbAvH', 'B365H'), iOD = firstCol('AvgD', 'BbAvD', 'B365D'), iOA = firstCol('AvgA', 'BbAvA', 'B365A');
  const iOv = firstCol('Avg>2.5', 'BbAv>2.5', 'B365>2.5'), iUn = firstCol('Avg<2.5', 'BbAv<2.5', 'B365<2.5');
  const iCH = firstCol('AvgCH', 'B365CH'), iCD = firstCol('AvgCD', 'B365CD'), iCA = firstCol('AvgCA', 'B365CA');
  const iCOv = firstCol('AvgC>2.5', 'B365C>2.5'), iCUn = firstCol('AvgC<2.5', 'B365C<2.5');
  const pick = (c: string[], i: number): number | null => (i >= 0 ? numOrNull(c[i]) : null);

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
    const iHG = col('FTHG'), iAG = col('FTAG');
    out.push({
      date, homeTeam: home, awayTeam: away,
      homeGoals: numOrNull(c[iHG]), awayGoals: numOrNull(c[iAG]),
      homeShots: numOrNull(c[iHS]), awayShots: numOrNull(c[iAS]),
      homeShotsOnTarget: numOrNull(c[iHST]), awayShotsOnTarget: numOrNull(c[iAST]),
      homeFouls: numOrNull(c[iHF]), awayFouls: numOrNull(c[iAF]),
      homeCorners: numOrNull(c[iHC]), awayCorners: numOrNull(c[iAC]),
      homeYellow: numOrNull(c[iHY]), awayYellow: numOrNull(c[iAY]),
      homeRed: numOrNull(c[iHR]), awayRed: numOrNull(c[iAR]),
      referee: iRef >= 0 ? (c[iRef]?.trim() || null) : null,
      oddsHome: pick(c, iOH), oddsDraw: pick(c, iOD), oddsAway: pick(c, iOA),
      oddsOver25: pick(c, iOv), oddsUnder25: pick(c, iUn),
      closingHome: pick(c, iCH), closingDraw: pick(c, iCD), closingAway: pick(c, iCA),
      closingOver25: pick(c, iCOv), closingUnder25: pick(c, iCUn),
    });
  }
  return out;
}

/** Chiave di matching data+squadre canoniche. */
export function matchKey(dateIso: string, home: string, away: string): string {
  return `${String(dateIso).slice(0, 10)}|${canonicalTeamName(home)}|${canonicalTeamName(away)}`;
}

export type TransitionSeasonReference = {
  sourceCompetitionId: string;
  sourceSeason: string;
  teamsCount: number;
  meanPpg: number | null;
  stdevPpg: number | null;
  meanGoalDifferencePerMatch: number | null;
  stdevGoalDifferencePerMatch: number | null;
  matchesPerTeam: number | null;
  matchesObserved: number;
  matchesExpected: number | null;
  coveragePercent: number | null;
  identityCoveragePercent: number | null;
  coverageStatus: 'complete' | 'partial' | 'unknown';
  sourceProvider: string;
  sourceReference: string;
};

export type TransitionStanding = {
  teamName: string;
  normalizedTeamName: string;
  played: number;
  points: number;
  goalDifference: number;
  rank: number;
  ppg: number;
};

export function seasonStartFromLabel(value: unknown): number {
  const match = String(value ?? '').match(/^(\d{4})/);
  return match ? Number(match[1]) : Number.NaN;
}

/** Selects only the latest transition relevant to a destination season. */
export function selectLatestRelevantTransition<T extends { destination_competition_id?: string; destination_season?: string }>(
  transitions: T[], destinationCompetitionId: string, destinationSeason: string,
): T | null {
  const target = seasonStartFromLabel(destinationSeason);
  return transitions
    .filter((transition) => transition.destination_competition_id === destinationCompetitionId)
    .filter((transition) => seasonStartFromLabel(transition.destination_season) <= target)
    .sort((a, b) => seasonStartFromLabel(b.destination_season) - seasonStartFromLabel(a.destination_season))[0] ?? null;
}

/** Builds a deterministic final-table view from completed result rows. */
export function buildTransitionStandings(rows: FootballDataRow[]): TransitionStanding[] {
  const table = new Map<string, { teamName: string; played: number; points: number; goalDifference: number }>();
  for (const row of rows) {
    if (row.homeGoals == null || row.awayGoals == null) continue;
    const homeKey = canonicalTeamName(row.homeTeam);
    const awayKey = canonicalTeamName(row.awayTeam);
    if (!table.has(homeKey)) table.set(homeKey, { teamName: row.homeTeam, played: 0, points: 0, goalDifference: 0 });
    if (!table.has(awayKey)) table.set(awayKey, { teamName: row.awayTeam, played: 0, points: 0, goalDifference: 0 });
    const home = table.get(homeKey)!;
    const away = table.get(awayKey)!;
    home.played += 1; away.played += 1;
    home.goalDifference += row.homeGoals - row.awayGoals;
    away.goalDifference += row.awayGoals - row.homeGoals;
    if (row.homeGoals > row.awayGoals) home.points += 3;
    else if (row.homeGoals < row.awayGoals) away.points += 3;
    else { home.points += 1; away.points += 1; }
  }
  return [...table.entries()]
    .map(([normalizedTeamName, team]) => ({
      ...team,
      normalizedTeamName,
      rank: 0,
      ppg: team.played > 0 ? team.points / team.played : 0,
    }))
    .sort((a, b) => b.points - a.points || b.goalDifference - a.goalDifference || a.teamName.localeCompare(b.teamName))
    .map((team, index) => ({ ...team, rank: index + 1 }));
}

/**
 * Builds a final-table summary from a football-data result CSV. It is pure and
 * idempotent: the caller can upsert the resulting reference by competition and
 * season. No promotion/playoff status is inferred here.
 */
export function buildTransitionSeasonReference(
  competitionId: string,
  competitionName: string,
  seasonStartYear: number,
  rows: FootballDataRow[],
  sourceReference: string,
): TransitionSeasonReference {
  const standings = buildTransitionStandings(rows).filter((team) => team.played > 0);
  const values = standings;
  const ppg = values.map((team) => team.ppg);
  const gdPerMatch = values.map((team) => team.goalDifference / team.played);
  const mean = (items: number[]) => items.length ? items.reduce((a, b) => a + b, 0) / items.length : null;
  const stdev = (items: number[]) => {
    if (items.length < 2) return null;
    const avg = mean(items)!;
    return Math.sqrt(items.reduce((sum, value) => sum + (value - avg) ** 2, 0) / (items.length - 1));
  };
  // The source CSV represents the regular league season, not playoffs. The
  // supported second divisions use a double round-robin regular season.
  const expectedMatchesPerTeam = values.length > 1 ? 2 * (values.length - 1) : 0;
  const matchesObserved = Math.round(values.reduce((sum, team) => sum + team.played, 0) / 2);
  const matchesExpected = expectedMatchesPerTeam > 0
    ? Math.round(values.length * expectedMatchesPerTeam / 2)
    : null;
  const coveragePercent = matchesExpected ? Math.min(100, (matchesObserved / matchesExpected) * 100) : null;
  const complete = values.length > 0 && values.every((team) => team.played >= expectedMatchesPerTeam);
  return {
    sourceCompetitionId: competitionId,
    sourceSeason: seasonLabel(seasonStartYear),
    teamsCount: values.length,
    meanPpg: mean(ppg),
    stdevPpg: stdev(ppg),
    meanGoalDifferencePerMatch: mean(gdPerMatch),
    stdevGoalDifferencePerMatch: stdev(gdPerMatch),
    matchesPerTeam: mean(values.map((team) => team.played)),
    matchesObserved,
    matchesExpected,
    coveragePercent,
    // This is populated by the transition sync after matching team identities;
    // source completeness itself must never be reduced because Understat does
    // not contain the lower-division teams.
    identityCoveragePercent: null,
    coverageStatus: complete ? 'complete' : values.length ? 'partial' : 'unknown',
    sourceProvider: 'football-data.co.uk',
    sourceReference,
  };
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
  /** Salva le quote di mercato (apertura+chiusura) in matches.fd_odds_json. Idempotente. Ritorna true se scritte. */
  saveMarketOdds(matchId: string, row: FootballDataRow): Promise<boolean>;
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
  now?: Date;
}

export interface LowerDivisionTeamSeasonWrite {
  teamId: string; sourceCompetitionId: string; sourceSeason: string;
  finalRank: number; matchesPlayed: number; points: number; ppg: number;
  goalDifference: number; goalDifferencePerMatch: number;
  sourceProvider: string; sourceReference: string; coverageStatus: 'complete' | 'partial';
}

export interface LowerDivisionTeamMatchWrite {
  historyId: string; teamId: string; sourceCompetitionId: string; sourceSeason: string;
  playedAt: string; venue: 'home' | 'away'; opponentName: string;
  goalsFor: number | null; goalsAgainst: number | null;
  shotsFor: number | null; shotsAgainst: number | null;
  shotsOnTargetFor: number | null; shotsOnTargetAgainst: number | null;
  foulsFor: number | null; foulsAgainst: number | null;
  cornersFor: number | null; cornersAgainst: number | null;
  yellowCardsFor: number | null; yellowCardsAgainst: number | null;
  redCardsFor: number | null; redCardsAgainst: number | null;
  referee: string | null; sourceProvider: string; sourceReference: string; rawJson: string;
}

export interface TeamCompetitionTransitionWrite {
  transitionId: string; teamId: string; sourceCompetitionId: string; sourceSeason: string;
  destinationCompetitionId: string; destinationSeason: string;
  transitionType: 'promoted' | 'relegated'; sourceRank: number; sourcePoints: number;
  sourceMatches: number; sourcePpg: number; sourceGoalDifference: number;
  sourceGoalDifferencePerMatch: number; transitionMode: 'direct_1' | 'direct_2';
  coverageStatus: 'complete' | 'partial'; sourceQuality: 'estimated';
  sourceProvider: string; sourceReference: string; notes: string;
  transitionSequence?: number | null;
  sourceIdentityStatus?: 'matched' | 'unresolved' | 'unknown';
}

export interface LowerDivisionHistoryBatch {
  reference: TransitionSeasonReference;
  teamSeasons: LowerDivisionTeamSeasonWrite[];
  teamMatches: LowerDivisionTeamMatchWrite[];
  transitions: TeamCompetitionTransitionWrite[];
}

export interface TransitionReferenceDb {
  upsertTransitionSeasonReference(reference: TransitionSeasonReference): Promise<void>;
  hasCompleteTransitionSeasonReference?(sourceCompetitionId: string, sourceSeason: string): Promise<boolean>;
  hasTransitionForSourceSeason?(sourceCompetitionId: string, sourceSeason: string): Promise<boolean>;
  hasCompleteLowerDivisionTeamHistory?(
    sourceCompetitionId: string,
    sourceSeason: string,
    expectedTeamIds: string[],
    expectedHistoryRows: number,
  ): Promise<boolean>;
  upsertLowerDivisionHistoryBatch?(batch: LowerDivisionHistoryBatch): Promise<void>;
  getTransitionTeams?(): Promise<Array<{ team_id: string; name: string }>>;
  upsertLowerDivisionTeamSeason?(season: LowerDivisionTeamSeasonWrite): Promise<void>;
  upsertLowerDivisionTeamMatch?(match: LowerDivisionTeamMatchWrite): Promise<void>;
  upsertTeamCompetitionTransition?(transition: TeamCompetitionTransitionWrite): Promise<void>;
}

export interface TransitionReferenceSyncOptions {
  competitions?: Record<string, string>;
  seasonStartYears?: number[];
  fetcher?: FootballDataFetcher;
}

export interface TransitionReferenceSyncSummary {
  requested: number;
  downloaded: number;
  persisted: number;
  skipped: number;
  errors: Array<{ competition: string; season: number; error: string }>;
  transitionsPersisted: number;
  teamSeasonsPersisted: number;
  teamMatchesPersisted: number;
  unresolvedTeams: string[];
  modelAdjustmentEnabled: false;
  perSeason: Record<string, {
    status: 'complete' | 'skipped_complete' | 'failed';
    rows: number;
    teamSeasons: number;
    teamMatches: number;
    transitions: number;
    error: string | null;
  }>;
}

const TRANSITION_RULES: Record<string, { destinationCompetitionId: string; directPromotionRanks: number[] }> = {
  serie_b: { destinationCompetitionId: 'serie_a', directPromotionRanks: [1, 2] },
  championship: { destinationCompetitionId: 'premier_league', directPromotionRanks: [1, 2] },
  '2_bundesliga': { destinationCompetitionId: 'bundesliga', directPromotionRanks: [1, 2] },
  ligue_2: { destinationCompetitionId: 'ligue_1', directPromotionRanks: [1, 2] },
  segunda_division: { destinationCompetitionId: 'la_liga', directPromotionRanks: [1, 2] },
};

/** Downloads and upserts seasonal references. Re-running it is safe. */
export async function syncTransitionSeasonReferences(
  db: TransitionReferenceDb,
  options: TransitionReferenceSyncOptions = {},
): Promise<TransitionReferenceSyncSummary> {
  const competitions = options.competitions ?? FOOTBALL_DATA_TRANSITION_LEAGUE_CODES;
  const seasons = options.seasonStartYears
    ?? buildSeasonWindow().map((label) => Number(label.slice(0, 4)));
  const fetcher = options.fetcher ?? defaultFootballDataFetcher;
  const summary: TransitionReferenceSyncSummary = {
    requested: 0, downloaded: 0, persisted: 0, skipped: 0, errors: [],
    transitionsPersisted: 0, teamSeasonsPersisted: 0, teamMatchesPersisted: 0,
    unresolvedTeams: [], modelAdjustmentEnabled: false, perSeason: {},
  };
  const teams = db.getTransitionTeams ? await db.getTransitionTeams() : [];
  const teamByName = new Map(teams.map((team) => [canonicalTeamName(team.name), team.team_id]));
  for (const [competitionName, leagueCode] of Object.entries(competitions)) {
    const competitionId = competitionName === 'Serie B' ? 'serie_b'
      : competitionName === 'Championship' ? 'championship'
        : competitionName === '2. Bundesliga' ? '2_bundesliga'
          : competitionName === 'Ligue 2' ? 'ligue_2' : 'segunda_division';
    for (const seasonStartYear of seasons) {
      summary.requested += 1;
      const seasonCode = seasonToFootballDataCode(seasonStartYear);
      const sourceReference = `https://www.football-data.co.uk/mmz4281/${seasonCode}/${leagueCode}.csv`;
      const seasonLabelValue = seasonLabel(seasonStartYear);
      const seasonKey = `${competitionName} ${seasonLabelValue}`;
      try {
        const needsTeamHistory = Boolean(
          db.upsertLowerDivisionHistoryBatch
          || db.upsertLowerDivisionTeamSeason
          || db.upsertLowerDivisionTeamMatch,
        );
        // Senza storico squadra il vecchio marker completo consente di evitare
        // anche il download. Con lo storico scarichiamo il CSV per scoprire
        // eventuali squadre divenute note, ma saltiamo tutte le scritture se i
        // conteggi attesi risultano gia presenti.
        if (db.hasCompleteTransitionSeasonReference
          && await db.hasCompleteTransitionSeasonReference(competitionId, seasonLabelValue)
          && (!db.hasTransitionForSourceSeason || await db.hasTransitionForSourceSeason(competitionId, seasonLabelValue))
          && !needsTeamHistory
          && !db.upsertLowerDivisionHistoryBatch) {
          summary.skipped += 1;
          summary.perSeason[seasonKey] = {
            status: 'skipped_complete', rows: 0, teamSeasons: 0, teamMatches: 0,
            transitions: 0, error: null,
          };
          continue;
        }
        const csv = await fetcher(leagueCode, seasonCode);
        if (!csv) throw new Error(`CSV non disponibile: ${sourceReference}`);
        summary.downloaded += 1;
        const parsedRows = parseFootballDataCsv(csv);
        if (parsedRows.length === 0) throw new Error(`CSV vuoto o senza righe valide: ${sourceReference}`);
        const standings = buildTransitionStandings(parsedRows);
        const identityMatched = standings.filter((item) => teamByName.has(item.normalizedTeamName)).length;
        const reference = buildTransitionSeasonReference(
          competitionId, competitionName, seasonStartYear,
          parsedRows, sourceReference,
        );
        reference.identityCoveragePercent = standings.length > 0
          ? (identityMatched / standings.length) * 100
          : null;
        const teamSeasons: LowerDivisionTeamSeasonWrite[] = standings.flatMap((standing) => {
          const teamId = teamByName.get(standing.normalizedTeamName);
          return teamId ? [{
            teamId, sourceCompetitionId: competitionId, sourceSeason: reference.sourceSeason,
            finalRank: standing.rank, matchesPlayed: standing.played, points: standing.points,
            ppg: standing.ppg, goalDifference: standing.goalDifference,
            goalDifferencePerMatch: standing.goalDifference / Math.max(1, standing.played),
            sourceProvider: reference.sourceProvider, sourceReference,
            coverageStatus: reference.coverageStatus === 'complete' ? 'complete' : 'partial',
          }] : [];
        });
        const teamMatches: LowerDivisionTeamMatchWrite[] = [];
        for (const row of parsedRows) {
          for (const side of ['home', 'away'] as const) {
            const ownName = side === 'home' ? row.homeTeam : row.awayTeam;
            const opponentName = side === 'home' ? row.awayTeam : row.homeTeam;
            const teamId = teamByName.get(canonicalTeamName(ownName));
            if (!teamId) continue;
            teamMatches.push({
              historyId: `fd:${competitionId}:${seasonStartYear}:${teamId}:${row.date}:${side}:${canonicalTeamName(opponentName)}`,
              teamId, sourceCompetitionId: competitionId, sourceSeason: reference.sourceSeason,
              playedAt: row.date, venue: side, opponentName,
              goalsFor: side === 'home' ? row.homeGoals : row.awayGoals,
              goalsAgainst: side === 'home' ? row.awayGoals : row.homeGoals,
              shotsFor: side === 'home' ? row.homeShots : row.awayShots,
              shotsAgainst: side === 'home' ? row.awayShots : row.homeShots,
              shotsOnTargetFor: side === 'home' ? row.homeShotsOnTarget : row.awayShotsOnTarget,
              shotsOnTargetAgainst: side === 'home' ? row.awayShotsOnTarget : row.homeShotsOnTarget,
              foulsFor: side === 'home' ? row.homeFouls : row.awayFouls,
              foulsAgainst: side === 'home' ? row.awayFouls : row.homeFouls,
              cornersFor: side === 'home' ? row.homeCorners : row.awayCorners,
              cornersAgainst: side === 'home' ? row.awayCorners : row.homeCorners,
              yellowCardsFor: side === 'home' ? row.homeYellow : row.awayYellow,
              yellowCardsAgainst: side === 'home' ? row.awayYellow : row.homeYellow,
              redCardsFor: side === 'home' ? row.homeRed : row.awayRed,
              redCardsAgainst: side === 'home' ? row.awayRed : row.homeRed,
              referee: row.referee, sourceProvider: reference.sourceProvider, sourceReference,
              rawJson: JSON.stringify(row),
            });
          }
        }
        const transitions: TeamCompetitionTransitionWrite[] = [];
        const rule = TRANSITION_RULES[competitionId];
        if (rule && reference.coverageStatus === 'complete' && db.getTransitionTeams) {
          for (const standing of standings.filter((item) => rule.directPromotionRanks.includes(item.rank))) {
            const teamId = teamByName.get(standing.normalizedTeamName);
            if (!teamId) { summary.unresolvedTeams.push(`${competitionName}:${standing.teamName}:${reference.sourceSeason}`); continue; }
            const destinationSeason = seasonLabel(seasonStartYear + 1);
            transitions.push({
              transitionId: `auto:${competitionId}:${reference.sourceSeason}:${teamId}:promoted`,
              teamId,
              sourceCompetitionId: competitionId,
              sourceSeason: reference.sourceSeason,
              destinationCompetitionId: rule.destinationCompetitionId,
              destinationSeason,
              transitionType: 'promoted',
              sourceRank: standing.rank,
              sourcePoints: standing.points,
              sourceMatches: standing.played,
              sourcePpg: standing.ppg,
              sourceGoalDifference: standing.goalDifference,
              sourceGoalDifferencePerMatch: standing.goalDifference / standing.played,
              transitionMode: standing.rank === 1 ? 'direct_1' : 'direct_2',
              coverageStatus: reference.coverageStatus === 'complete' ? 'complete' : 'partial',
              sourceQuality: 'estimated',
              sourceProvider: reference.sourceProvider,
              sourceReference,
              notes: 'Auto-identificata dalla posizione finale; i playoff non sono inferiti dai soli CSV di campionato.',
              sourceIdentityStatus: 'matched',
            });
          }
        }

        const expectedTeamIds = [...new Set(teamSeasons.map((item) => item.teamId))].sort();
        const referenceComplete = db.hasCompleteTransitionSeasonReference
          ? await db.hasCompleteTransitionSeasonReference(competitionId, seasonLabelValue)
          : false;
        const transitionsComplete = transitions.length === 0 || (db.hasTransitionForSourceSeason
          ? await db.hasTransitionForSourceSeason(competitionId, seasonLabelValue)
          : false);
        const historyComplete = db.hasCompleteLowerDivisionTeamHistory
          ? await db.hasCompleteLowerDivisionTeamHistory(
              competitionId, seasonLabelValue, expectedTeamIds, teamMatches.length,
            )
          : false;
        if (reference.coverageStatus === 'complete' && referenceComplete && transitionsComplete && historyComplete) {
          summary.skipped += 1;
          summary.perSeason[seasonKey] = {
            status: 'skipped_complete', rows: parsedRows.length, teamSeasons: teamSeasons.length,
            teamMatches: teamMatches.length, transitions: transitions.length, error: null,
          };
          continue;
        }

        if (db.upsertLowerDivisionHistoryBatch) {
          await db.upsertLowerDivisionHistoryBatch({ reference, teamSeasons, teamMatches, transitions });
        } else {
          await db.upsertTransitionSeasonReference(reference);
          for (const season of teamSeasons) await db.upsertLowerDivisionTeamSeason?.(season);
          for (const match of teamMatches) await db.upsertLowerDivisionTeamMatch?.(match);
          for (const transition of transitions) await db.upsertTeamCompetitionTransition?.(transition);
        }
        summary.persisted += 1;
        summary.teamSeasonsPersisted += teamSeasons.length;
        summary.teamMatchesPersisted += teamMatches.length;
        summary.transitionsPersisted += transitions.length;
        summary.perSeason[seasonKey] = {
          status: 'complete', rows: parsedRows.length, teamSeasons: teamSeasons.length,
          teamMatches: teamMatches.length, transitions: transitions.length, error: null,
        };
      } catch (error: any) {
        const message = error?.message ?? String(error);
        summary.errors.push({ competition: competitionName, season: seasonStartYear, error: message });
        summary.perSeason[seasonKey] = {
          status: 'failed', rows: 0, teamSeasons: 0, teamMatches: 0,
          transitions: 0, error: message,
        };
      }
    }
  }
  return summary;
}

export interface FootballDataSyncSummary {
  requested: number;
  completed: number;
  pending: number;
  allExpectedSeasonsComplete: boolean;
  allExpectedSeasonsReady: boolean;
  pendingSeasonPairs: Array<{ key: string; reason: string }>;
  csvRows: number;
  matched: number;
  updated: number;
  oddsWritten: number;
  dateToleranceMatched: number;
  unmatchedTeams: string[];
  perCompetition: Record<string, {
    csvRows: number; matched: number; updated: number; oddsWritten: number; dateToleranceMatched: number;
  }>;
  perSeason: Record<string, {
    status: 'complete' | 'pending' | 'failed';
    csvRows: number;
    matched: number;
    updated: number;
    oddsWritten: number;
    dateToleranceMatched: number;
    sourceLatestDate: string | null;
    matchedLatestDate: string | null;
    error: string | null;
    pendingReason?: string | null;
  }>;
  errors: Array<{ competition: string; season: number; error: string }>;
}

const romeCalendarDate = (now: Date): string => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now);
  const part = (type: string) => parts.find((entry) => entry.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
};

const expectedFootballDataPendingReason = (params: {
  competition: string;
  seasonStart: number;
  rows: FootballDataRow[];
  unmatchedRows: FootballDataRow[];
  matched: number;
  error: string;
  now: Date;
}): string | null => {
  const { competition, seasonStart, rows, unmatchedRows, matched, error, now } = params;
  if (romeCalendarDate(now) >= '2026-08-28' || seasonStart !== 2026) return null;

  if (competition === 'Bundesliga'
    && rows.length === 0
    && /CSV non disponibile/i.test(error)) {
    return 'stagione corrente non ancora pubblicata dalla fonte prima del via ufficiale';
  }

  if (competition === 'Ligue 1'
    && matched === rows.length - 1
    && unmatchedRows.length === 1
    && error === `Copertura CSV incompleta: ${matched}/${rows.length} partite abbinate`) {
    const [row] = unmatchedRows;
    // La LFP ha invertito ufficialmente PSG-Rennes il 19/08/2026, dopo la
    // pubblicazione del calendario iniziale. Understat espone ancora la vecchia
    // identita della gara: non associare mai le statistiche a casa/trasferta
    // invertite. La quarantena scade il 28/08 e torna quindi fail-closed.
    // https://ligue1.com/fr/articles/l1_article_5699-j1-psg-rennes-inverse-l1-2627
    if (row.date === '2026-08-23'
      && canonicalTeamName(row.homeTeam) === 'rennes'
      && canonicalTeamName(row.awayTeam) === 'parissaintgermain') {
      return 'inversione ufficiale Rennes-PSG in quarantena in attesa del riallineamento Understat';
    }
  }
  return null;
};

/**
 * Estrae le quote di mercato (apertura+chiusura) da una riga CSV nel formato del
 * motore. Ritorna null se nessuna quota valida. Chiavi: homeWin/draw/awayWin, over25/under25.
 */
export function buildMarketOddsJson(
  row: FootballDataRow
): { opening: Record<string, number>; closing: Record<string, number> } | null {
  const clean = (o: Record<string, number | null>): Record<string, number> => {
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(o)) {
      if (v != null && Number.isFinite(v) && (v as number) > 1) out[k] = Number(v);
    }
    return out;
  };
  const opening = clean({ homeWin: row.oddsHome, draw: row.oddsDraw, awayWin: row.oddsAway, over25: row.oddsOver25, under25: row.oddsUnder25 });
  const closing = clean({ homeWin: row.closingHome, draw: row.closingDraw, awayWin: row.closingAway, over25: row.closingOver25, under25: row.closingUnder25 });
  if (Object.keys(opening).length === 0 && Object.keys(closing).length === 0) return null;
  return { opening, closing };
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
  const now = options.now ?? new Date();

  const summary: FootballDataSyncSummary = {
    requested: 0, completed: 0, pending: 0,
    allExpectedSeasonsComplete: false, allExpectedSeasonsReady: false, pendingSeasonPairs: [],
    csvRows: 0, matched: 0, updated: 0, oddsWritten: 0, dateToleranceMatched: 0,
    unmatchedTeams: [], perCompetition: {}, perSeason: {}, errors: [],
  };
  const unmatched = new Set<string>();

  for (const competition of competitions) {
    const leagueCode = FOOTBALL_DATA_LEAGUE_CODES[competition];
    if (!leagueCode) continue;

    const dbMatches = await db.getMatchesForCompetition(competition);
    const index = new Map<string, FootballDataDbMatch>();
    const byTeamPair = new Map<string, FootballDataDbMatch[]>();
    const dbTeams = new Set<string>();
    for (const m of dbMatches) {
      index.set(matchKey(String(m.date).slice(0, 10), m.home_team_name ?? '', m.away_team_name ?? ''), m);
      const pairKey = `${canonicalTeamName(m.home_team_name ?? '')}|${canonicalTeamName(m.away_team_name ?? '')}`;
      byTeamPair.set(pairKey, [...(byTeamPair.get(pairKey) ?? []), m]);
      dbTeams.add(canonicalTeamName(m.home_team_name ?? ''));
      dbTeams.add(canonicalTeamName(m.away_team_name ?? ''));
    }

    const perComp = { csvRows: 0, matched: 0, updated: 0, oddsWritten: 0, dateToleranceMatched: 0 };
    for (const seasonStart of seasons) {
      summary.requested += 1;
      const label = seasonLabel(seasonStart);
      const seasonKey = `${competition} ${label}`;
      let rows: FootballDataRow[] = [];
      let matched = 0;
      let updated = 0;
      let oddsWritten = 0;
      let dateToleranceMatched = 0;
      let matchedLatestDate: string | null = null;
      const unmatchedRows: FootballDataRow[] = [];
      try {
        const csv = await fetcher(leagueCode, seasonToFootballDataCode(seasonStart));
        if (!csv) throw new Error('CSV non disponibile');
        rows = parseFootballDataCsv(csv);
        if (rows.length === 0) throw new Error('CSV vuoto o senza righe valide');
        perComp.csvRows += rows.length;
        for (const row of rows) {
          let hit = index.get(matchKey(row.date, row.homeTeam, row.awayTeam));
          if (!hit) {
            const pairKey = `${canonicalTeamName(row.homeTeam)}|${canonicalTeamName(row.awayTeam)}`;
            const rowTimestamp = Date.parse(`${row.date}T00:00:00Z`);
            const candidates = (byTeamPair.get(pairKey) ?? []).filter((candidate) => {
              const candidateTimestamp = Date.parse(`${String(candidate.date).slice(0, 10)}T00:00:00Z`);
              return Number.isFinite(rowTimestamp) && Number.isFinite(candidateTimestamp)
                && Math.abs(candidateTimestamp - rowTimestamp) <= 24 * 60 * 60 * 1000;
            });
            if (candidates.length === 1) {
              [hit] = candidates;
              dateToleranceMatched += 1;
            }
          }
          if (!hit) {
            const pairKey = `${canonicalTeamName(row.homeTeam)}|${canonicalTeamName(row.awayTeam)}`;
            const seasonStartDate = Date.parse(`${seasonStart}-07-01T00:00:00Z`);
            const nextSeasonStartDate = Date.parse(`${seasonStart + 1}-07-01T00:00:00Z`);
            const candidates = (byTeamPair.get(pairKey) ?? []).filter((candidate) => {
              const candidateTimestamp = Date.parse(`${String(candidate.date).slice(0, 10)}T00:00:00Z`);
              return Number.isFinite(candidateTimestamp)
                && candidateTimestamp >= seasonStartDate
                && candidateTimestamp < nextSeasonStartDate;
            });
            if (candidates.length === 1) {
              [hit] = candidates;
              dateToleranceMatched += 1;
            }
          }
          if (!hit) {
            unmatchedRows.push(row);
            if (!dbTeams.has(canonicalTeamName(row.homeTeam))) unmatched.add(row.homeTeam);
            if (!dbTeams.has(canonicalTeamName(row.awayTeam))) unmatched.add(row.awayTeam);
            continue;
          }
          matched += 1;
          matchedLatestDate = !matchedLatestDate || row.date > matchedLatestDate ? row.date : matchedLatestDate;
          const changed = await db.fillSupplementalStats(hit.match_id, row);
          if (changed) updated += 1;
          const oddsSaved = await db.saveMarketOdds(hit.match_id, row);
          if (oddsSaved) oddsWritten += 1;
        }
        const sourceLatestDate = rows.reduce<string | null>(
          (latest, row) => !latest || row.date > latest ? row.date : latest,
          null,
        );
        if (matched === 0) throw new Error('Nessuna partita CSV corrisponde ai dati Understat nel DB');
        if (matched !== rows.length) {
          throw new Error(`Copertura CSV incompleta: ${matched}/${rows.length} partite abbinate`);
        }
        if (sourceLatestDate !== matchedLatestDate) {
          throw new Error(`Dati non freschi: ultima data fonte ${sourceLatestDate}, ultima data abbinata ${matchedLatestDate ?? 'nessuna'}`);
        }
        perComp.matched += matched;
        perComp.updated += updated;
        perComp.oddsWritten += oddsWritten;
        perComp.dateToleranceMatched += dateToleranceMatched;
        summary.completed += 1;
        summary.perSeason[seasonKey] = {
          status: 'complete', csvRows: rows.length, matched, updated, oddsWritten, dateToleranceMatched,
          sourceLatestDate, matchedLatestDate, error: null,
        };
      } catch (error: any) {
        const message = error?.message ?? String(error);
        perComp.matched += matched;
        perComp.updated += updated;
        perComp.oddsWritten += oddsWritten;
        perComp.dateToleranceMatched += dateToleranceMatched;
        const sourceLatestDate = rows.reduce<string | null>(
          (latest, row) => !latest || row.date > latest ? row.date : latest,
          null,
        );
        const pendingReason = expectedFootballDataPendingReason({
          competition, seasonStart, rows, unmatchedRows, matched, error: message, now,
        });
        const previousFourComplete = [1, 2, 3, 4].every((yearsBack) =>
          summary.perSeason[`${competition} ${seasonLabel(seasonStart - yearsBack)}`]?.status === 'complete'
        );
        if (pendingReason && previousFourComplete) {
          summary.pending += 1;
          summary.pendingSeasonPairs.push({ key: seasonKey, reason: pendingReason });
          summary.perSeason[seasonKey] = {
            status: 'pending', csvRows: rows.length, matched, updated, oddsWritten, dateToleranceMatched,
            sourceLatestDate, matchedLatestDate, error: null, pendingReason,
          };
        } else {
          summary.errors.push({ competition, season: seasonStart, error: message });
          summary.perSeason[seasonKey] = {
            status: 'failed', csvRows: rows.length, matched, updated, oddsWritten, dateToleranceMatched,
            sourceLatestDate, matchedLatestDate, error: message, pendingReason: null,
          };
        }
      }
    }
    summary.perCompetition[competition] = perComp;
    summary.csvRows += perComp.csvRows;
    summary.matched += perComp.matched;
    summary.updated += perComp.updated;
    summary.oddsWritten += perComp.oddsWritten;
    summary.dateToleranceMatched += perComp.dateToleranceMatched;
  }
  summary.unmatchedTeams = [...unmatched].sort();
  summary.allExpectedSeasonsComplete = summary.completed === summary.requested && summary.errors.length === 0;
  summary.allExpectedSeasonsReady = summary.completed + summary.pending === summary.requested
    && summary.errors.length === 0;
  return summary;
}

// ---------------------------------------------------------------------------
// Adapter libSQL + retention stagioni
// ---------------------------------------------------------------------------

/** Minimo sottoinsieme del client libSQL usato qui. */
export interface LibsqlLike {
  execute(query: { sql: string; args?: any } | string): Promise<{ rows: any[]; rowsAffected?: number }>;
  batch?(
    statements: Array<{ sql: string; args?: any }>,
    mode?: 'write',
  ): Promise<Array<{ rows: any[]; rowsAffected?: number }>>;
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
    async saveMarketOdds(matchId: string, row: FootballDataRow) {
      const payload = buildMarketOddsJson(row);
      if (!payload) return false;
      // Idempotente: sovrascrive con gli stessi valori a ogni run (le quote di un
      // match concluso sono finali). Scrittura additiva (colonna dedicata).
      const res = await client.execute({
        sql: `UPDATE matches SET fd_odds_json = :json WHERE match_id = :id`,
        args: { json: JSON.stringify(payload), id: matchId },
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
  linkedRowsDeleted: number;
}

const DELETE_ORPHAN_LINEUP_BATCHES_SQL = `DELETE FROM player_lineup_snapshot_batches
  WHERE NOT EXISTS (
    SELECT 1 FROM player_lineup_snapshots snapshot
    WHERE snapshot.batch_id = player_lineup_snapshot_batches.batch_id
  ) AND NOT EXISTS (
    SELECT 1 FROM player_injury_refresh_batches injury
    WHERE injury.batch_id = player_lineup_snapshot_batches.batch_id
  )`;

/**
 * Retention: tiene la stagione corrente e le `keepCount - 1` precedenti,
 * elimina in un unico batch i match fuori finestra e i dati tecnici collegati.
 * Prediction e bet restano append-only e non vengono mai cancellate.
 * Le stagioni con label non standard (null/'') non vengono mai toccate.
 */
export async function pruneOldSeasons(
  client: LibsqlLike,
  keepCount = DEFAULT_SEASON_RETENTION_COUNT,
  now: Date = new Date(),
): Promise<PruneSummary> {
  const res = await client.execute({
    // La sorgente della lista e l'unione di tutte le tabelle tecniche: una
    // stagione inferiore o un parametro orfano va eliminato anche se i match
    // Top 5 corrispondenti non sono (piu) presenti.
    sql: `SELECT season FROM matches WHERE season IS NOT NULL AND TRIM(season) <> ''
          UNION SELECT source_season AS season FROM source_season_reference WHERE TRIM(source_season) <> ''
          UNION SELECT source_season AS season FROM lower_division_team_seasons WHERE TRIM(source_season) <> ''
          UNION SELECT source_season AS season FROM lower_division_team_matches WHERE TRIM(source_season) <> ''
          UNION SELECT source_season AS season FROM team_competition_transitions WHERE TRIM(source_season) <> ''
          UNION SELECT destination_season AS season FROM team_competition_transitions WHERE TRIM(destination_season) <> ''
          UNION SELECT season FROM model_params WHERE season IS NOT NULL AND TRIM(season) <> ''`,
    args: [],
  });
  const seasons = res.rows
    .map((r) => ({ label: String(r.season), start: Number(String(r.season).slice(0, 4)) }))
    .filter((s) => /^\d{4}[/-]\d{4}$/.test(s.label) && Number.isFinite(s.start))
    .sort((a, b) => b.start - a.start);

  const currentStart = currentSeasonStartYear(now);
  const oldestStart = currentStart - Math.max(1, Math.trunc(keepCount)) + 1;
  const keep = seasons.filter((season) => season.start >= oldestStart && season.start <= currentStart);
  const drop = seasons.filter((season) => season.start < oldestStart || season.start > currentStart);
  if (drop.length === 0) {
    // La pulizia dei contenitori snapshot vuoti e housekeeping indipendente:
    // deve avvenire anche quando la finestra stagionale e gia corretta.
    const orphanCleanup = await client.execute({ sql: DELETE_ORPHAN_LINEUP_BATCHES_SQL, args: [] });
    return {
      seasonsKept: keep.map((season) => season.label),
      seasonsDeleted: [],
      matchesDeleted: 0,
      oddsDeleted: 0,
      linkedRowsDeleted: Number(orphanCleanup.rowsAffected ?? 0),
    };
  }
  if (typeof client.batch !== 'function') {
    throw new Error('Atomic season retention requires libSQL batch support');
  }

  type DeletionKind = 'matches' | 'odds' | 'linked';
  const statements: Array<{ sql: string; args: any[] }> = [];
  const kinds: DeletionKind[] = [];
  const add = (kind: DeletionKind, sql: string, args: any[]) => {
    statements.push({ sql, args });
    kinds.push(kind);
  };

  for (const season of drop) {
    const args = [season.label];
    const matchIds = `SELECT match_id FROM matches WHERE season = ?`;
    add('linked', `DELETE FROM player_injury_refresh_batches WHERE match_id IN (${matchIds})`, args);
    add('linked', `DELETE FROM player_lineup_snapshots WHERE match_id IN (${matchIds})`, args);
    add('linked', `DELETE FROM player_lineup_status WHERE match_id IN (${matchIds})`, args);
    add('linked', `DELETE FROM learning_reviews WHERE match_id IN (${matchIds})`, args);
    add('odds', `DELETE FROM odds_snapshots WHERE match_id IN (${matchIds})`, args);
    // Le transizioni vanno eliminate prima dei riferimenti di stagione (FK).
    add('linked', `DELETE FROM team_competition_transitions WHERE source_season = ? OR destination_season = ?`, [season.label, season.label]);
    add('linked', `DELETE FROM lower_division_team_matches WHERE source_season = ?`, args);
    add('linked', `DELETE FROM lower_division_team_seasons WHERE source_season = ?`, args);
    add('linked', `DELETE FROM source_season_reference WHERE source_season = ?`, args);
    add('linked', `DELETE FROM model_params WHERE season = ?`, args);
    add('matches', `DELETE FROM matches WHERE season = ?`, args);
  }
  add('linked', DELETE_ORPHAN_LINEUP_BATCHES_SQL, []);

  // Turso/libSQL esegue batch in una transazione implicita: una singola
  // cancellazione fallita annulla l'intera retention.
  const results = await client.batch(statements, 'write');
  let matchesDeleted = 0;
  let oddsDeleted = 0;
  let linkedRowsDeleted = 0;
  results.forEach((result, index) => {
    const affected = Number(result?.rowsAffected ?? 0);
    if (kinds[index] === 'matches') matchesDeleted += affected;
    else if (kinds[index] === 'odds') oddsDeleted += affected;
    else linkedRowsDeleted += affected;
  });
  return {
    seasonsKept: keep.map((season) => season.label),
    seasonsDeleted: drop.map((season) => season.label),
    matchesDeleted,
    oddsDeleted,
    linkedRowsDeleted,
  };
}
