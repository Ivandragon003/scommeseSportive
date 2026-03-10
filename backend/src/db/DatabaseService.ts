import { createClient } from '@libsql/client';

type SqlArgs = Record<string, any> | any[];

export class DatabaseService {
  private db: ReturnType<typeof createClient>;
  private initPromise: Promise<void>;

  constructor() {
    const url = (process.env.TURSO_DATABASE_URL ?? '').trim();
    const authToken = (process.env.TURSO_AUTH_TOKEN ?? '').trim();

    if (!url) {
      throw new Error('Missing TURSO_DATABASE_URL. Set a Turso/libSQL URL before starting the backend.');
    }
    if (!authToken) {
      throw new Error('Missing TURSO_AUTH_TOKEN. Set a fresh Turso auth token before starting the backend.');
    }

    this.db = createClient({ url, authToken });
    this.initPromise = this.initialize();
  }

  private normalizeValue(value: unknown): unknown {
    if (typeof value === 'bigint') return Number(value);
    return value;
  }

  private normalizeRow(row: Record<string, unknown> | null | undefined): any {
    if (!row) return null;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(row)) out[k] = this.normalizeValue(v);
    return out;
  }

  private normalizeRows(rows: Array<Record<string, unknown>>): any[] {
    return rows.map((row) => this.normalizeRow(row));
  }

  private async execute(sql: string, args?: SqlArgs, skipInit = false): Promise<any> {
    if (!skipInit) await this.initPromise;
    if (args === undefined) return this.db.execute(sql);
    return this.db.execute({ sql, args });
  }

  private async run(sql: string, args?: SqlArgs): Promise<void> {
    await this.execute(sql, args);
  }

  private async all(sql: string, args?: SqlArgs): Promise<any[]> {
    const result = await this.execute(sql, args);
    return this.normalizeRows((result.rows ?? []) as Array<Record<string, unknown>>);
  }

  private async get(sql: string, args?: SqlArgs): Promise<any | null> {
    const rows = await this.all(sql, args);
    return rows.length > 0 ? rows[0] : null;
  }

  private async initialize(): Promise<void> {
    await this.execute('PRAGMA foreign_keys = ON', undefined, true);
    await this.initSchema();
    await this.ensureOptionalColumns();
  }

  private async initSchema(): Promise<void> {
    const statements = [
      `CREATE TABLE IF NOT EXISTS matches (
        match_id TEXT PRIMARY KEY,
        home_team_id TEXT NOT NULL,
        away_team_id TEXT NOT NULL,
        home_team_name TEXT,
        away_team_name TEXT,
        date TEXT NOT NULL,
        home_goals INTEGER,
        away_goals INTEGER,
        home_xg REAL,
        away_xg REAL,
        home_shots INTEGER,
        away_shots INTEGER,
        home_shots_on_target INTEGER,
        away_shots_on_target INTEGER,
        home_possession REAL,
        away_possession REAL,
        home_fouls INTEGER,
        away_fouls INTEGER,
        home_yellow_cards INTEGER,
        away_yellow_cards INTEGER,
        home_red_cards INTEGER,
        away_red_cards INTEGER,
        home_corners INTEGER,
        away_corners INTEGER,
        referee TEXT,
        competition TEXT,
        season TEXT,
        source TEXT DEFAULT 'manual',
        source_match_id INTEGER,
        raw_json TEXT,
        created_at TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS teams (
        team_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        short_name TEXT,
        country TEXT,
        competition TEXT,
        attack_strength REAL DEFAULT 0.0,
        defence_strength REAL DEFAULT 0.0,
        avg_home_shots REAL DEFAULT 12.1,
        avg_away_shots REAL DEFAULT 10.4,
        avg_home_shots_ot REAL DEFAULT 4.8,
        avg_away_shots_ot REAL DEFAULT 3.9,
        avg_home_xg REAL,
        avg_away_xg REAL,
        avg_yellow_cards REAL DEFAULT 1.9,
        avg_red_cards REAL DEFAULT 0.11,
        avg_fouls REAL DEFAULT 11.2,
        avg_home_corners REAL DEFAULT 5.5,
        avg_away_corners REAL DEFAULT 4.5,
        shots_suppression REAL DEFAULT 1.0,
        source_team_id INTEGER,
        team_stats_json TEXT,
        last_updated TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS players (
        player_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        team_id TEXT NOT NULL REFERENCES teams(team_id),
        position_code TEXT NOT NULL DEFAULT 'MF',
        avg_shots_per_game REAL DEFAULT 0.0,
        avg_shots_on_target_per_game REAL DEFAULT 0.0,
        avg_xg_per_game REAL DEFAULT 0.0,
        avg_xgot_per_game REAL DEFAULT 0.0,
        total_goals INTEGER DEFAULT 0,
        total_shots INTEGER DEFAULT 0,
        total_shots_on_target INTEGER DEFAULT 0,
        shot_share_of_team REAL DEFAULT 0.0,
        games_played INTEGER DEFAULT 0,
        is_available INTEGER DEFAULT 1,
        source_player_id INTEGER,
        stats_json TEXT,
        last_updated TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS referees (
        referee_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        avg_fouls_per_game REAL DEFAULT 22.4,
        avg_yellow_cards_per_game REAL DEFAULT 3.8,
        avg_red_cards_per_game REAL DEFAULT 0.22,
        total_games INTEGER DEFAULT 0,
        dispersion_yellow REAL DEFAULT 12.4,
        last_updated TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS model_params (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        competition TEXT NOT NULL,
        season TEXT NOT NULL,
        params_json TEXT NOT NULL,
        fitted_at TEXT DEFAULT (datetime('now')),
        training_matches INTEGER,
        log_likelihood REAL
      )`,
      `CREATE TABLE IF NOT EXISTS users (
        user_id TEXT PRIMARY KEY,
        username TEXT NOT NULL UNIQUE,
        created_at TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS budgets (
        user_id TEXT PRIMARY KEY REFERENCES users(user_id),
        total_budget REAL NOT NULL DEFAULT 0,
        available_budget REAL NOT NULL DEFAULT 0,
        total_bets INTEGER DEFAULT 0,
        total_staked REAL DEFAULT 0,
        total_won REAL DEFAULT 0,
        total_lost REAL DEFAULT 0,
        roi REAL DEFAULT 0,
        win_rate REAL DEFAULT 0,
        created_at TEXT DEFAULT (datetime('now')),
        updated_at TEXT DEFAULT (datetime('now'))
      )`,
      `CREATE TABLE IF NOT EXISTS bets (
        bet_id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(user_id),
        match_id TEXT NOT NULL,
        home_team_name TEXT,
        away_team_name TEXT,
        competition TEXT,
        match_date TEXT,
        market_name TEXT NOT NULL,
        selection TEXT NOT NULL,
        odds REAL NOT NULL,
        stake REAL NOT NULL,
        our_probability REAL NOT NULL,
        expected_value REAL NOT NULL,
        status TEXT DEFAULT 'PENDING',
        return_amount REAL,
        profit REAL,
        placed_at TEXT NOT NULL,
        settled_at TEXT,
        notes TEXT
      )`,
      `CREATE TABLE IF NOT EXISTS backtest_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        competition TEXT,
        season_range TEXT,
        result_json TEXT NOT NULL,
        run_at TEXT DEFAULT (datetime('now'))
      )`,
      'CREATE INDEX IF NOT EXISTS idx_matches_date ON matches(date)',
      'CREATE INDEX IF NOT EXISTS idx_matches_competition ON matches(competition)',
      'CREATE INDEX IF NOT EXISTS idx_players_team ON players(team_id)',
      'CREATE INDEX IF NOT EXISTS idx_bets_user ON bets(user_id)',
      'CREATE INDEX IF NOT EXISTS idx_bets_status ON bets(status)',
      "INSERT OR IGNORE INTO users (user_id, username) VALUES ('user1', 'Giocatore 1'), ('user2', 'Giocatore 2')",
    ];

    for (const sql of statements) {
      await this.execute(sql, undefined, true);
    }
  }

  private async ensureOptionalColumns(): Promise<void> {
    const columns: Array<{ table: string; column: string; type: string }> = [
      { table: 'matches', column: 'source', type: "TEXT DEFAULT 'manual'" },
      { table: 'matches', column: 'source_match_id', type: 'INTEGER' },
      { table: 'matches', column: 'raw_json', type: 'TEXT' },
      { table: 'matches', column: 'home_corners', type: 'INTEGER' },
      { table: 'matches', column: 'away_corners', type: 'INTEGER' },
      { table: 'teams', column: 'source_team_id', type: 'INTEGER' },
      { table: 'teams', column: 'team_stats_json', type: 'TEXT' },
      { table: 'players', column: 'avg_xg_per_game', type: 'REAL DEFAULT 0.0' },
      { table: 'players', column: 'avg_xgot_per_game', type: 'REAL DEFAULT 0.0' },
      { table: 'players', column: 'total_goals', type: 'INTEGER DEFAULT 0' },
      { table: 'players', column: 'total_shots', type: 'INTEGER DEFAULT 0' },
      { table: 'players', column: 'total_shots_on_target', type: 'INTEGER DEFAULT 0' },
      { table: 'players', column: 'source_player_id', type: 'INTEGER' },
      { table: 'players', column: 'stats_json', type: 'TEXT' },
      { table: 'bets', column: 'home_team_name', type: 'TEXT' },
      { table: 'bets', column: 'away_team_name', type: 'TEXT' },
      { table: 'bets', column: 'competition', type: 'TEXT' },
      { table: 'bets', column: 'match_date', type: 'TEXT' },
      { table: 'teams', column: 'avg_home_corners', type: 'REAL DEFAULT 5.5' },
      { table: 'teams', column: 'avg_away_corners', type: 'REAL DEFAULT 4.5' },
    ];

    for (const c of columns) {
      try {
        await this.execute(`ALTER TABLE ${c.table} ADD COLUMN ${c.column} ${c.type}`, undefined, true);
      } catch {
        // Colonna già presente
      }
    }
  }

  // ==================== MATCHES ====================

  async upsertMatch(match: any): Promise<void> {
    await this.run(
      `
      INSERT OR REPLACE INTO matches (
        match_id, home_team_id, away_team_id, home_team_name, away_team_name,
        date, home_goals, away_goals, home_xg, away_xg,
        home_shots, away_shots, home_shots_on_target, away_shots_on_target,
        home_possession, away_possession, home_fouls, away_fouls,
        home_yellow_cards, away_yellow_cards, home_red_cards, away_red_cards,
        home_corners, away_corners,
        referee, competition, season, source, source_match_id, raw_json
      ) VALUES (
        :matchId, :homeTeamId, :awayTeamId, :homeTeamName, :awayTeamName,
        :date, :homeGoals, :awayGoals, :homeXG, :awayXG,
        :homeShots, :awayShots, :homeShotsOT, :awayShotsOT,
        :homePoss, :awayPoss, :homeFouls, :awayFouls,
        :homeYellow, :awayYellow, :homeRed, :awayRed,
        :homeCorners, :awayCorners,
        :referee, :competition, :season, :source, :sourceMatchId, :rawJson
      )
    `,
      {
        matchId: match.matchId,
        homeTeamId: match.homeTeamId,
        awayTeamId: match.awayTeamId,
        homeTeamName: match.homeTeamName ?? null,
        awayTeamName: match.awayTeamName ?? null,
        date: match.date instanceof Date ? match.date.toISOString() : match.date,
        homeGoals: match.homeGoals ?? null,
        awayGoals: match.awayGoals ?? null,
        homeXG: match.homeXG ?? null,
        awayXG: match.awayXG ?? null,
        homeShots: match.homeTotalShots ?? null,
        awayShots: match.awayTotalShots ?? null,
        homeShotsOT: match.homeShotsOnTarget ?? null,
        awayShotsOT: match.awayShotsOnTarget ?? null,
        homePoss: match.homePossession ?? null,
        awayPoss: match.awayPossession ?? null,
        homeFouls: match.homeFouls ?? null,
        awayFouls: match.awayFouls ?? null,
        homeYellow: match.homeYellowCards ?? null,
        awayYellow: match.awayYellowCards ?? null,
        homeRed: match.homeRedCards ?? null,
        awayRed: match.awayRedCards ?? null,
        homeCorners: match.homeCorners ?? null,
        awayCorners: match.awayCorners ?? null,
        referee: match.referee ?? null,
        competition: match.competition ?? null,
        season: match.season ?? null,
        source: match.source ?? 'manual',
        sourceMatchId: match.sourceMatchId ?? null,
        rawJson: match.rawJson ?? null,
      }
    );
  }

  async getMatches(filters?: { competition?: string; season?: string; fromDate?: string; toDate?: string; includeRawJson?: boolean }): Promise<any[]> {
    const baseColumns = [
      'match_id',
      'home_team_id', 'away_team_id',
      'home_team_name', 'away_team_name',
      'date',
      'home_goals', 'away_goals',
      'home_xg', 'away_xg',
      'home_shots', 'away_shots',
      'home_shots_on_target', 'away_shots_on_target',
      'home_possession', 'away_possession',
      'home_fouls', 'away_fouls',
      'home_yellow_cards', 'away_yellow_cards',
      'home_red_cards', 'away_red_cards',
      'home_corners', 'away_corners',
      'referee',
      'competition', 'season',
      'source', 'source_match_id',
      'created_at',
    ];
    const columns = filters?.includeRawJson ? [...baseColumns, 'raw_json'] : baseColumns;
    let q = `SELECT ${columns.join(', ')} FROM matches WHERE 1=1`;
    const p: any[] = [];

    if (filters?.competition) {
      q += ' AND competition = ?';
      p.push(filters.competition);
    }
    if (filters?.season) {
      const rawSeason = filters.season.trim();
      if (rawSeason.length > 0) {
        const seasonVariants = Array.from(
          new Set([
            rawSeason,
            rawSeason.includes('/') ? rawSeason.replace('/', '-') : rawSeason,
            rawSeason.includes('-') ? rawSeason.replace('-', '/') : rawSeason,
          ])
        );
        if (seasonVariants.length === 1) {
          q += ' AND season = ?';
          p.push(seasonVariants[0]);
        } else {
          q += ` AND season IN (${seasonVariants.map(() => '?').join(', ')})`;
          p.push(...seasonVariants);
        }
      }
    }
    if (filters?.fromDate) {
      q += ' AND date >= ?';
      p.push(filters.fromDate);
    }
    if (filters?.toDate) {
      q += ' AND date <= ?';
      p.push(filters.toDate);
    }
    q += ' ORDER BY datetime(date) DESC';
    return this.all(q, p);
  }

  async countMatches(filters?: { competition?: string; season?: string; fromDate?: string; toDate?: string }): Promise<number> {
    let q = 'SELECT COUNT(*) AS total FROM matches WHERE 1=1';
    const p: any[] = [];

    if (filters?.competition) {
      q += ' AND competition = ?';
      p.push(filters.competition);
    }
    if (filters?.season) {
      const rawSeason = filters.season.trim();
      if (rawSeason.length > 0) {
        const seasonVariants = Array.from(
          new Set([
            rawSeason,
            rawSeason.includes('/') ? rawSeason.replace('/', '-') : rawSeason,
            rawSeason.includes('-') ? rawSeason.replace('-', '/') : rawSeason,
          ])
        );
        if (seasonVariants.length === 1) {
          q += ' AND season = ?';
          p.push(seasonVariants[0]);
        } else {
          q += ` AND season IN (${seasonVariants.map(() => '?').join(', ')})`;
          p.push(...seasonVariants);
        }
      }
    }
    if (filters?.fromDate) {
      q += ' AND date >= ?';
      p.push(filters.fromDate);
    }
    if (filters?.toDate) {
      q += ' AND date <= ?';
      p.push(filters.toDate);
    }

    const row = await this.get(q, p);
    return Number(row?.total ?? 0);
  }

  async getMatchdayRows(filters?: { competition?: string; season?: string }): Promise<Array<{ match_id: string; date: string }>> {
    let q = 'SELECT match_id, date FROM matches WHERE 1=1';
    const p: any[] = [];

    if (filters?.competition) {
      q += ' AND competition = ?';
      p.push(filters.competition);
    }
    if (filters?.season) {
      const rawSeason = filters.season.trim();
      if (rawSeason.length > 0) {
        const seasonVariants = Array.from(
          new Set([
            rawSeason,
            rawSeason.includes('/') ? rawSeason.replace('/', '-') : rawSeason,
            rawSeason.includes('-') ? rawSeason.replace('-', '/') : rawSeason,
          ])
        );
        if (seasonVariants.length === 1) {
          q += ' AND season = ?';
          p.push(seasonVariants[0]);
        } else {
          q += ` AND season IN (${seasonVariants.map(() => '?').join(', ')})`;
          p.push(...seasonVariants);
        }
      }
    }

    q += ' ORDER BY datetime(date) ASC';
    return this.all(q, p);
  }

  async getMatchesCoverageStats(): Promise<{
    totals: {
      totalMatches: number;
      completedMatches: number;
      upcomingMatches: number;
    };
    fields: Record<string, { filled: number; pct: number }>;
    teams: {
      totalTeams: number;
      teamsWithPlayers: number;
      pctWithPlayers: number;
    };
    players: {
      totalPlayers: number;
      avgGamesPlayed: number;
    };
  }> {
    const row = await this.get(
      `
      SELECT
        COUNT(*) AS total_matches,
        SUM(CASE WHEN home_goals IS NOT NULL AND away_goals IS NOT NULL THEN 1 ELSE 0 END) AS completed_matches,
        SUM(CASE WHEN datetime(date) >= datetime('now') THEN 1 ELSE 0 END) AS upcoming_matches,
        SUM(CASE WHEN home_xg IS NOT NULL AND away_xg IS NOT NULL THEN 1 ELSE 0 END) AS with_xg,
        SUM(CASE WHEN home_shots IS NOT NULL AND away_shots IS NOT NULL THEN 1 ELSE 0 END) AS with_shots,
        SUM(CASE WHEN home_shots_on_target IS NOT NULL AND away_shots_on_target IS NOT NULL THEN 1 ELSE 0 END) AS with_shots_ot,
        SUM(CASE WHEN home_fouls IS NOT NULL AND away_fouls IS NOT NULL THEN 1 ELSE 0 END) AS with_fouls,
        SUM(CASE WHEN home_yellow_cards IS NOT NULL AND away_yellow_cards IS NOT NULL THEN 1 ELSE 0 END) AS with_yellow,
        SUM(CASE WHEN home_red_cards IS NOT NULL AND away_red_cards IS NOT NULL THEN 1 ELSE 0 END) AS with_red,
        SUM(CASE WHEN home_possession IS NOT NULL AND away_possession IS NOT NULL THEN 1 ELSE 0 END) AS with_possession,
        SUM(CASE WHEN referee IS NOT NULL AND TRIM(referee) <> '' THEN 1 ELSE 0 END) AS with_referee
      FROM matches
    `
    );

    const teamsRow = await this.get('SELECT COUNT(*) AS total_teams FROM teams');
    const playersRow = await this.get(
      `
      SELECT
        COUNT(*) AS total_players,
        COUNT(DISTINCT team_id) AS teams_with_players,
        AVG(games_played) AS avg_games_played
      FROM players
      WHERE is_available = 1
    `
    );

    const totalMatches = Number(row?.total_matches ?? 0);
    const pct = (filled: number): number =>
      totalMatches > 0 ? Number(((filled / totalMatches) * 100).toFixed(2)) : 0;
    const safeN = (v: unknown): number => Number(v ?? 0);

    const fieldCounts = {
      xg: safeN(row?.with_xg),
      shots: safeN(row?.with_shots),
      shotsOnTarget: safeN(row?.with_shots_ot),
      fouls: safeN(row?.with_fouls),
      yellowCards: safeN(row?.with_yellow),
      redCards: safeN(row?.with_red),
      possession: safeN(row?.with_possession),
      referee: safeN(row?.with_referee),
    };

    const totalTeams = Number(teamsRow?.total_teams ?? 0);
    const teamsWithPlayers = Number(playersRow?.teams_with_players ?? 0);

    return {
      totals: {
        totalMatches,
        completedMatches: Number(row?.completed_matches ?? 0),
        upcomingMatches: Number(row?.upcoming_matches ?? 0),
      },
      fields: Object.fromEntries(
        Object.entries(fieldCounts).map(([k, filled]) => [k, { filled, pct: pct(filled) }])
      ),
      teams: {
        totalTeams,
        teamsWithPlayers,
        pctWithPlayers: totalTeams > 0 ? Number(((teamsWithPlayers / totalTeams) * 100).toFixed(2)) : 0,
      },
      players: {
        totalPlayers: Number(playersRow?.total_players ?? 0),
        avgGamesPlayed: Number(Number(playersRow?.avg_games_played ?? 0).toFixed(2)),
      },
    };
  }

  async getLeagueSummaries(leagues: string[]): Promise<Array<{
    competition: string;
    matches: number;
    completedMatches: number;
    upcomingMatches: number;
    avgGoals: number;
    avgTotalShots: number;
    avgTotalCards: number;
    avgTotalFouls: number;
    xgCoveragePct: number;
    lastMatchDate: string | null;
  }>> {
    if (!Array.isArray(leagues) || leagues.length === 0) return [];
    const placeholders = leagues.map(() => '?').join(', ');

    const rows = await this.all(
      `
      SELECT
        competition,
        COUNT(*) AS matches,
        SUM(CASE WHEN home_goals IS NOT NULL AND away_goals IS NOT NULL THEN 1 ELSE 0 END) AS completed_matches,
        SUM(CASE WHEN datetime(date) >= datetime('now') THEN 1 ELSE 0 END) AS upcoming_matches,
        AVG(CASE WHEN home_goals IS NOT NULL AND away_goals IS NOT NULL THEN (home_goals + away_goals) END) AS avg_goals,
        AVG(CASE WHEN home_shots IS NOT NULL AND away_shots IS NOT NULL THEN (home_shots + away_shots) END) AS avg_total_shots,
        AVG(CASE WHEN home_yellow_cards IS NOT NULL AND away_yellow_cards IS NOT NULL THEN (home_yellow_cards + away_yellow_cards + 2 * (COALESCE(home_red_cards, 0) + COALESCE(away_red_cards, 0))) END) AS avg_total_cards,
        AVG(CASE WHEN home_fouls IS NOT NULL AND away_fouls IS NOT NULL THEN (home_fouls + away_fouls) END) AS avg_total_fouls,
        SUM(CASE WHEN home_xg IS NOT NULL AND away_xg IS NOT NULL THEN 1 ELSE 0 END) AS with_xg,
        MAX(date) AS last_match_date
      FROM matches
      WHERE competition IN (${placeholders})
      GROUP BY competition
    `,
      leagues
    );

    const byCompetition = new Map<string, any>();
    rows.forEach((r: any) => byCompetition.set(String(r.competition), r));

    return leagues.map((league) => {
      const r = byCompetition.get(league);
      if (!r) {
        return {
          competition: league,
          matches: 0,
          completedMatches: 0,
          upcomingMatches: 0,
          avgGoals: 0,
          avgTotalShots: 0,
          avgTotalCards: 0,
          avgTotalFouls: 0,
          xgCoveragePct: 0,
          lastMatchDate: null,
        };
      }

      const matches = Number(r.matches ?? 0);
      const withXg = Number(r.with_xg ?? 0);
      return {
        competition: league,
        matches,
        completedMatches: Number(r.completed_matches ?? 0),
        upcomingMatches: Number(r.upcoming_matches ?? 0),
        avgGoals: Number(Number(r.avg_goals ?? 0).toFixed(2)),
        avgTotalShots: Number(Number(r.avg_total_shots ?? 0).toFixed(2)),
        avgTotalCards: Number(Number(r.avg_total_cards ?? 0).toFixed(2)),
        avgTotalFouls: Number(Number(r.avg_total_fouls ?? 0).toFixed(2)),
        xgCoveragePct: matches > 0 ? Number(((withXg / matches) * 100).toFixed(2)) : 0,
        lastMatchDate: r.last_match_date ? String(r.last_match_date) : null,
      };
    });
  }

  async getPlayerCoverageByLeague(leagues: string[]): Promise<Record<string, {
    players: number;
    teamsWithPlayers: number;
    avgGamesPlayed: number;
  }>> {
    const out: Record<string, { players: number; teamsWithPlayers: number; avgGamesPlayed: number }> = {};
    leagues.forEach((league) => {
      out[league] = { players: 0, teamsWithPlayers: 0, avgGamesPlayed: 0 };
    });
    if (!Array.isArray(leagues) || leagues.length === 0) return out;

    const placeholders = leagues.map(() => '?').join(', ');
    const rows = await this.all(
      `
      SELECT
        t.competition AS competition,
        COUNT(DISTINCT p.player_id) AS players,
        COUNT(DISTINCT p.team_id) AS teams_with_players,
        AVG(p.games_played) AS avg_games_played
      FROM players p
      INNER JOIN teams t ON t.team_id = p.team_id
      WHERE t.competition IN (${placeholders})
        AND p.is_available = 1
      GROUP BY t.competition
    `,
      leagues
    );

    for (const row of rows) {
      const comp = String(row.competition ?? '');
      if (!out[comp]) continue;
      out[comp] = {
        players: Number(row.players ?? 0),
        teamsWithPlayers: Number(row.teams_with_players ?? 0),
        avgGamesPlayed: Number(Number(row.avg_games_played ?? 0).toFixed(2)),
      };
    }

    return out;
  }

  async getMatchById(matchId: string): Promise<any | null> {
    return this.get('SELECT * FROM matches WHERE match_id = ?', [matchId]);
  }

  async findPlayedMatchByTeams(
    homeTeamName: string,
    awayTeamName: string,
    competition?: string,
    matchDate?: string
  ): Promise<any | null> {
    const home = String(homeTeamName ?? '').trim().toLowerCase();
    const away = String(awayTeamName ?? '').trim().toLowerCase();
    if (!home || !away) return null;

    let q = `
      SELECT *
      FROM matches
      WHERE lower(trim(home_team_name)) = ?
        AND lower(trim(away_team_name)) = ?
        AND home_goals IS NOT NULL
        AND away_goals IS NOT NULL
    `;
    const params: any[] = [home, away];

    if (competition && String(competition).trim()) {
      q += ' AND competition = ?';
      params.push(String(competition).trim());
    }

    if (matchDate) {
      q += ' AND ABS(julianday(date) - julianday(?)) <= 3';
      params.push(matchDate);
      q += ' ORDER BY ABS(julianday(date) - julianday(?)) ASC, datetime(date) DESC LIMIT 1';
      params.push(matchDate);
    } else {
      q += ' ORDER BY datetime(date) DESC LIMIT 1';
    }

    return this.get(q, params);
  }

  async getUpcomingMatches(filters?: { competition?: string; season?: string; limit?: number }): Promise<any[]> {
    let q = `
      SELECT *
      FROM matches
      WHERE datetime(date) >= datetime('now')
    `;
    const params: any[] = [];

    if (filters?.competition) {
      q += ' AND competition = ?';
      params.push(filters.competition);
    }

    if (filters?.season) {
      const rawSeason = filters.season.trim();
      if (rawSeason.length > 0) {
        const seasonVariants = Array.from(
          new Set([
            rawSeason,
            rawSeason.includes('/') ? rawSeason.replace('/', '-') : rawSeason,
            rawSeason.includes('-') ? rawSeason.replace('-', '/') : rawSeason,
          ])
        );

        if (seasonVariants.length === 1) {
          q += ' AND season = ?';
          params.push(seasonVariants[0]);
        } else {
          q += ` AND season IN (${seasonVariants.map(() => '?').join(', ')})`;
          params.push(...seasonVariants);
        }
      }
    }

    const requestedLimit = Number(filters?.limit ?? 380);
    const safeLimit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(Math.trunc(requestedLimit), 1000))
      : 380;
    q += ' ORDER BY datetime(date) ASC LIMIT ?';
    params.push(safeLimit);

    return this.all(q, params);
  }

  async getLastMatchDate(competition: string, season: string): Promise<string | null> {
    const row = await this.get(
      `
      SELECT MAX(date) AS last_date
      FROM matches
      WHERE competition = ?
        AND season = ?
        AND home_goals IS NOT NULL
    `,
      [competition, season]
    );

    if (!row || !row.last_date) return null;
    return String(row.last_date).substring(0, 10);
  }

  // ==================== TEAMS ====================

  async upsertTeam(team: any): Promise<void> {
    await this.run(
      `
      INSERT OR REPLACE INTO teams (
        team_id, name, short_name, country, competition,
        attack_strength, defence_strength,
        avg_home_shots, avg_away_shots, avg_home_shots_ot, avg_away_shots_ot,
        avg_home_xg, avg_away_xg,
        avg_yellow_cards, avg_red_cards, avg_fouls,
        avg_home_corners, avg_away_corners,
        shots_suppression,
        source_team_id, team_stats_json,
        last_updated
      ) VALUES (
        :teamId, :name, :shortName, :country, :competition,
        :attack, :defence,
        :homeShots, :awayShots, :homeShotsOT, :awayShotsOT,
        :homeXG, :awayXG,
        :yellowCards, :redCards, :fouls,
        :homeCorners, :awayCorners,
        :shotsSuppression,
        :sourceTeamId, :teamStatsJson,
        datetime('now')
      )
    `,
      {
        teamId: team.teamId,
        name: team.name,
        shortName: team.shortName ?? null,
        country: team.country ?? null,
        competition: team.competition ?? null,
        attack: team.attackStrength ?? 0.0,
        defence: team.defenceStrength ?? 0.0,
        homeShots: team.avgHomeShots ?? 12.1,
        awayShots: team.avgAwayShots ?? 10.4,
        homeShotsOT: team.avgHomeShotsOT ?? 4.8,
        awayShotsOT: team.avgAwayShotsOT ?? 3.9,
        homeXG: team.avgHomeXG ?? null,
        awayXG: team.avgAwayXG ?? null,
        yellowCards: team.avgYellowCards ?? 1.9,
        redCards: team.avgRedCards ?? 0.11,
        fouls: team.avgFouls ?? 11.2,
        homeCorners: team.avgHomeCorners ?? 5.5,
        awayCorners: team.avgAwayCorners ?? 4.5,
        shotsSuppression: team.shotsSuppression ?? 1.0,
        sourceTeamId: team.sourceTeamId ?? null,
        teamStatsJson: team.teamStatsJson ?? null,
      }
    );
  }

  async getTeams(competition?: string): Promise<any[]> {
    if (competition) return this.all('SELECT * FROM teams WHERE competition = ?', [competition]);
    return this.all('SELECT * FROM teams');
  }

  async getTeamsByCompetition(competition: string): Promise<any[]> {
    return this.getTeams(competition);
  }

  async getTeam(teamId: string): Promise<any | null> {
    return this.get('SELECT * FROM teams WHERE team_id = ?', [teamId]);
  }

  async recomputeTeamAverages(teamId: string): Promise<void> {
    const safeAvgOrNull = (v: unknown): number | null => {
      if (v === null || v === undefined || v === '') return null;
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };

    const homeRows = await this.get(
      `SELECT
        SUM(home_shots * EXP(-0.0065 * (julianday('now') - julianday(date)) / 7.0)) / 
        NULLIF(SUM(EXP(-0.0065 * (julianday('now') - julianday(date)) / 7.0)), 0) AS avg_shots,
        SUM(home_shots_on_target * EXP(-0.0065 * (julianday('now') - julianday(date)) / 7.0)) /
        NULLIF(SUM(EXP(-0.0065 * (julianday('now') - julianday(date)) / 7.0)), 0) AS avg_shots_ot,
        SUM(home_xg * EXP(-0.0065 * (julianday('now') - julianday(date)) / 7.0)) /
        NULLIF(SUM(EXP(-0.0065 * (julianday('now') - julianday(date)) / 7.0)), 0) AS avg_xg,
        SUM(away_shots * EXP(-0.0065 * (julianday('now') - julianday(date)) / 7.0)) /
        NULLIF(SUM(EXP(-0.0065 * (julianday('now') - julianday(date)) / 7.0)), 0) AS avg_shots_conceded,
        SUM(home_yellow_cards * EXP(-0.0065 * (julianday('now') - julianday(date)) / 7.0)) /
        NULLIF(SUM(EXP(-0.0065 * (julianday('now') - julianday(date)) / 7.0)), 0) AS avg_yellow,
        SUM(home_red_cards * EXP(-0.0065 * (julianday('now') - julianday(date)) / 7.0)) /
        NULLIF(SUM(EXP(-0.0065 * (julianday('now') - julianday(date)) / 7.0)), 0) AS avg_red,
        SUM(home_fouls * EXP(-0.0065 * (julianday('now') - julianday(date)) / 7.0)) /
        NULLIF(SUM(EXP(-0.0065 * (julianday('now') - julianday(date)) / 7.0)), 0) AS avg_fouls,
        SUM(home_corners * EXP(-0.0065 * (julianday('now') - julianday(date)) / 7.0)) /
        NULLIF(SUM(EXP(-0.0065 * (julianday('now') - julianday(date)) / 7.0)), 0) AS avg_corners,
        SUM(EXP(-0.0065 * (julianday('now') - julianday(date)) / 7.0)) AS total_weight,
        COUNT(*) AS n
      FROM matches
      WHERE home_team_id = ? AND home_goals IS NOT NULL`,
      [teamId]
    );

    const awayRows = await this.get(
      `SELECT
        SUM(away_shots * EXP(-0.0065 * (julianday('now') - julianday(date)) / 7.0)) /
        NULLIF(SUM(EXP(-0.0065 * (julianday('now') - julianday(date)) / 7.0)), 0) AS avg_shots,
        SUM(away_shots_on_target * EXP(-0.0065 * (julianday('now') - julianday(date)) / 7.0)) /
        NULLIF(SUM(EXP(-0.0065 * (julianday('now') - julianday(date)) / 7.0)), 0) AS avg_shots_ot,
        SUM(away_xg * EXP(-0.0065 * (julianday('now') - julianday(date)) / 7.0)) /
        NULLIF(SUM(EXP(-0.0065 * (julianday('now') - julianday(date)) / 7.0)), 0) AS avg_xg,
        SUM(home_shots * EXP(-0.0065 * (julianday('now') - julianday(date)) / 7.0)) /
        NULLIF(SUM(EXP(-0.0065 * (julianday('now') - julianday(date)) / 7.0)), 0) AS avg_shots_conceded,
        SUM(away_yellow_cards * EXP(-0.0065 * (julianday('now') - julianday(date)) / 7.0)) /
        NULLIF(SUM(EXP(-0.0065 * (julianday('now') - julianday(date)) / 7.0)), 0) AS avg_yellow,
        SUM(away_red_cards * EXP(-0.0065 * (julianday('now') - julianday(date)) / 7.0)) /
        NULLIF(SUM(EXP(-0.0065 * (julianday('now') - julianday(date)) / 7.0)), 0) AS avg_red,
        SUM(away_fouls * EXP(-0.0065 * (julianday('now') - julianday(date)) / 7.0)) /
        NULLIF(SUM(EXP(-0.0065 * (julianday('now') - julianday(date)) / 7.0)), 0) AS avg_fouls,
        SUM(away_corners * EXP(-0.0065 * (julianday('now') - julianday(date)) / 7.0)) /
        NULLIF(SUM(EXP(-0.0065 * (julianday('now') - julianday(date)) / 7.0)), 0) AS avg_corners,
        SUM(EXP(-0.0065 * (julianday('now') - julianday(date)) / 7.0)) AS total_weight,
        COUNT(*) AS n
      FROM matches
      WHERE away_team_id = ? AND home_goals IS NOT NULL`,
      [teamId]
    );

    const LEAGUE_AVG_SHOTS_CONCEDED = 12.1;
    const homeN = Number(homeRows?.n ?? 0);
    const awayN = Number(awayRows?.n ?? 0);
    const totalN = homeN + awayN;
    if (totalN === 0) return;

    const homeW = Number(homeRows?.total_weight ?? 0);
    const awayW = Number(awayRows?.total_weight ?? 0);
    const totalW = homeW + awayW;

    const avgConcededAll = totalW > 0
      ? ((Number(homeRows?.avg_shots_conceded ?? LEAGUE_AVG_SHOTS_CONCEDED) * homeW + Number(awayRows?.avg_shots_conceded ?? LEAGUE_AVG_SHOTS_CONCEDED) * awayW) / totalW)
      : LEAGUE_AVG_SHOTS_CONCEDED;
    const shotsSuppression = avgConcededAll / LEAGUE_AVG_SHOTS_CONCEDED;

    const avgYellow = totalW > 0 ? ((Number(homeRows?.avg_yellow ?? 1.9) * homeW + Number(awayRows?.avg_yellow ?? 1.9) * awayW) / totalW) : 1.9;
    const avgRed = totalW > 0 ? ((Number(homeRows?.avg_red ?? 0.11) * homeW + Number(awayRows?.avg_red ?? 0.11) * awayW) / totalW) : 0.11;
    const avgFouls = totalW > 0 ? ((Number(homeRows?.avg_fouls ?? 11.2) * homeW + Number(awayRows?.avg_fouls ?? 11.2) * awayW) / totalW) : 11.2;

    await this.run(
      `UPDATE teams SET
        avg_home_shots     = COALESCE(:homeShots,   avg_home_shots),
        avg_home_shots_ot  = COALESCE(:homeShotsOT, avg_home_shots_ot),
        avg_home_xg        = COALESCE(:homeXG,      avg_home_xg),
        avg_away_shots     = COALESCE(:awayShots,   avg_away_shots),
        avg_away_shots_ot  = COALESCE(:awayShotsOT, avg_away_shots_ot),
        avg_away_xg        = COALESCE(:awayXG,      avg_away_xg),
        avg_yellow_cards   = :yellow,
        avg_red_cards      = :red,
        avg_fouls          = :fouls,
        avg_home_corners   = :homeCorners,
        avg_away_corners   = :awayCorners,
        shots_suppression  = :suppression,
        last_updated       = datetime('now')
      WHERE team_id = :teamId`,
      {
        teamId,
        homeShots: homeN > 0 ? safeAvgOrNull(homeRows?.avg_shots) : null,
        homeShotsOT: homeN > 0 ? safeAvgOrNull(homeRows?.avg_shots_ot) : null,
        homeXG: homeN > 0 ? safeAvgOrNull(homeRows?.avg_xg) : null,
        awayShots: awayN > 0 ? safeAvgOrNull(awayRows?.avg_shots) : null,
        awayShotsOT: awayN > 0 ? safeAvgOrNull(awayRows?.avg_shots_ot) : null,
        awayXG: awayN > 0 ? safeAvgOrNull(awayRows?.avg_xg) : null,
        yellow: avgYellow,
        red: avgRed,
        fouls: avgFouls,
        homeCorners: safeAvgOrNull(homeRows?.avg_corners) ?? 5.5,
        awayCorners: safeAvgOrNull(awayRows?.avg_corners) ?? 4.5,
        suppression: shotsSuppression,
      }
    );
  }

  // ==================== PLAYERS ====================

  async upsertPlayer(player: any): Promise<void> {
    await this.run(
      `INSERT OR REPLACE INTO players (
        player_id, name, team_id, position_code,
        avg_shots_per_game, avg_shots_on_target_per_game,
        avg_xg_per_game, avg_xgot_per_game,
        total_goals, total_shots, total_shots_on_target,
        shot_share_of_team, games_played, is_available,
        source_player_id, stats_json, last_updated
      ) VALUES (
        :playerId, :name, :teamId, :positionCode,
        :avgShots, :avgShotsOT,
        :avgXG, :avgXGOT,
        :totalGoals, :totalShots, :totalShotsOnTarget,
        :shotShare, :games, :available,
        :sourcePlayerId, :statsJson, datetime('now')
      )`,
      {
        playerId: player.playerId,
        name: player.name,
        teamId: player.teamId,
        positionCode: player.positionCode ?? 'MF',
        avgShots: player.avgShotsPerGame ?? 0,
        avgShotsOT: player.avgShotsOnTargetPerGame ?? 0,
        avgXG: player.avgXGPerGame ?? 0,
        avgXGOT: player.avgXGOTPerGame ?? 0,
        totalGoals: player.totalGoals ?? 0,
        totalShots: player.totalShots ?? 0,
        totalShotsOnTarget: player.totalShotsOnTarget ?? 0,
        shotShare: player.shotShareOfTeam ?? 0,
        games: player.gamesPlayed ?? 0,
        available: player.isAvailable !== false ? 1 : 0,
        sourcePlayerId: player.sourcePlayerId ?? null,
        statsJson: player.statsJson ?? null,
      }
    );
  }

  async getPlayersByTeam(teamId: string): Promise<any[]> {
    return this.all(
      'SELECT * FROM players WHERE team_id = ? AND is_available = 1 ORDER BY avg_shots_per_game DESC',
      [teamId]
    );
  }

  async markPlayersUnavailable(competition?: string): Promise<number> {
    const normalizedCompetition = String(competition ?? '').trim();
    if (!normalizedCompetition) {
      const result = await this.execute('UPDATE players SET is_available = 0');
      return Number(result?.rowsAffected ?? 0);
    }
    const result = await this.execute(
      `UPDATE players SET is_available = 0 WHERE team_id IN (SELECT team_id FROM teams WHERE competition = ?)`,
      [normalizedCompetition]
    );
    return Number(result?.rowsAffected ?? 0);
  }

  // ==================== REFEREES ====================

  async upsertReferee(ref: any): Promise<void> {
    await this.run(
      `INSERT OR REPLACE INTO referees (referee_id, name, avg_fouls_per_game, avg_yellow_cards_per_game, avg_red_cards_per_game, total_games, last_updated)
      VALUES (:refId, :name, :fouls, :yellow, :red, :games, datetime('now'))`,
      {
        refId: ref.refId ?? String(ref.name ?? '').toLowerCase().replace(/\s/g, '_'),
        name: ref.name,
        fouls: ref.avgFouls ?? 22.4,
        yellow: ref.avgYellow ?? 3.8,
        red: ref.avgRed ?? 0.22,
        games: ref.games ?? 0,
      }
    );
  }

  async getRefereeByName(name: string): Promise<any | null> {
    return this.get('SELECT * FROM referees WHERE name LIKE ?', [`%${name}%`]);
  }

  // ==================== MODEL PARAMS ====================

  async saveModelParams(competition: string, season: string, params: object, trainingMatches: number, logLikelihood?: number): Promise<void> {
    await this.run(
      'INSERT INTO model_params (competition, season, params_json, training_matches, log_likelihood) VALUES (?, ?, ?, ?, ?)',
      [competition, season, JSON.stringify(params), trainingMatches, logLikelihood ?? null]
    );
  }

  async getLatestModelParams(competition: string): Promise<any | null> {
    const row = await this.get('SELECT * FROM model_params WHERE competition = ? ORDER BY fitted_at DESC LIMIT 1', [competition]);
    if (!row) return null;
    let parsedParams: any = {};
    try { parsedParams = JSON.parse(String(row.params_json ?? '{}')); } catch { parsedParams = {}; }
    return { ...row, params: parsedParams };
  }

  // ==================== BUDGET & BETS ====================

  async getBudget(userId: string): Promise<any | null> {
    return this.get('SELECT * FROM budgets WHERE user_id = ?', [userId]);
  }

  async createOrResetBudget(userId: string, amount: number): Promise<void> {
    await this.run(
      `INSERT OR REPLACE INTO budgets (user_id, total_budget, available_budget, total_bets, total_staked, total_won, total_lost, roi, win_rate, updated_at)
      VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, datetime('now'))`,
      [userId, amount, amount]
    );
  }

  async deleteMatchesByCompetitionAndSeasons(competition: string, seasons: string[]): Promise<number> {
    const normalizedCompetition = String(competition ?? '').trim();
    if (!normalizedCompetition) return 0;
    const seasonVariants = Array.from(new Set((seasons ?? []).map((s) => String(s ?? '').trim()).filter(Boolean).flatMap((rawSeason) => [
      rawSeason,
      rawSeason.includes('/') ? rawSeason.replace('/', '-') : rawSeason,
      rawSeason.includes('-') ? rawSeason.replace('-', '/') : rawSeason,
    ])));
    const params: any[] = [normalizedCompetition];
    let sql = 'DELETE FROM matches WHERE competition = ?';
    if (seasonVariants.length > 0) {
      sql += ` AND season IN (${seasonVariants.map(() => '?').join(', ')})`;
      params.push(...seasonVariants);
    }
    const result = await this.execute(sql, params);
    return Number(result?.rowsAffected ?? 0);
  }

  async deleteBetsByUser(userId: string): Promise<void> {
    await this.run('DELETE FROM bets WHERE user_id = ?', [userId]);
  }

  async updateBudget(budget: any): Promise<void> {
    await this.run(
      `UPDATE budgets SET
        total_budget = :totalBudget, available_budget = :availableBudget,
        total_bets = :totalBets, total_staked = :totalStaked,
        total_won = :totalWon, total_lost = :totalLost,
        roi = :roi, win_rate = :winRate, updated_at = datetime('now')
      WHERE user_id = :userId`,
      budget
    );
  }

  async saveBet(bet: any): Promise<void> {
    await this.run(
      `INSERT OR REPLACE INTO bets (
        bet_id, user_id, match_id, home_team_name, away_team_name, competition, match_date, market_name, selection,
        odds, stake, our_probability, expected_value,
        status, return_amount, profit, placed_at, settled_at, notes
      ) VALUES (
        :betId, :userId, :matchId, :homeTeamName, :awayTeamName, :competition, :matchDate, :marketName, :selection,
        :odds, :stake, :ourProbability, :expectedValue,
        :status, :returnAmount, :profit, :placedAt, :settledAt, :notes
      )`,
      {
        betId: bet.betId,
        userId: bet.userId,
        matchId: bet.matchId,
        homeTeamName: bet.homeTeamName ?? null,
        awayTeamName: bet.awayTeamName ?? null,
        competition: bet.competition ?? null,
        matchDate: bet.matchDate ? (bet.matchDate instanceof Date ? bet.matchDate.toISOString() : bet.matchDate) : null,
        marketName: bet.marketName,
        selection: bet.selection,
        odds: bet.odds,
        stake: bet.stake,
        ourProbability: bet.ourProbability,
        expectedValue: bet.expectedValue,
        status: bet.status,
        returnAmount: bet.returnAmount ?? null,
        profit: bet.profit ?? null,
        placedAt: bet.placedAt instanceof Date ? bet.placedAt.toISOString() : bet.placedAt,
        settledAt: bet.settledAt ? (bet.settledAt instanceof Date ? bet.settledAt.toISOString() : bet.settledAt) : null,
        notes: bet.notes ?? null,
      }
    );
  }

  async getBets(userId: string, status?: string): Promise<any[]> {
    if (status) return this.all('SELECT * FROM bets WHERE user_id = ? AND status = ? ORDER BY placed_at DESC', [userId, status]);
    return this.all('SELECT * FROM bets WHERE user_id = ? ORDER BY placed_at DESC', [userId]);
  }

  async getBet(betId: string): Promise<any | null> {
    return this.get('SELECT * FROM bets WHERE bet_id = ?', [betId]);
  }

  // ==================== BACKTEST ====================

  async saveBacktestResult(competition: string, seasonRange: string, result: object): Promise<void> {
    await this.run('INSERT INTO backtest_results (competition, season_range, result_json) VALUES (?, ?, ?)', [
      competition,
      seasonRange,
      JSON.stringify(result),
    ]);
  }

  async getBacktestResults(competition?: string): Promise<any[]> {
    if (competition) {
      return this.all('SELECT id, competition, season_range, run_at FROM backtest_results WHERE competition = ? ORDER BY run_at DESC', [competition]);
    }
    return this.all('SELECT id, competition, season_range, run_at FROM backtest_results ORDER BY run_at DESC LIMIT 50');
  }

  async getBacktestResult(id: number): Promise<any | null> {
    const row = await this.get('SELECT * FROM backtest_results WHERE id = ?', [id]);
    if (!row) return null;
    let parsed: any = {};
    try { parsed = JSON.parse(String(row.result_json ?? '{}')); } catch { parsed = {}; }
    return { ...row, result: parsed };
  }

  async close(): Promise<void> {
    await this.initPromise.catch(() => undefined);
    if (typeof (this.db as any).close === 'function') {
      await (this.db as any).close();
    }
  }
}
