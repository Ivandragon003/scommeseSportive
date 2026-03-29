import axios from 'axios';

export interface UnderstatPlayerMatchStat {
  playerId: string;
  sourcePlayerId: number | null;
  playerName: string;
  teamId: string;
  positionCode: string;
  minutes: number | null;
  shots: number;
  shotsOnTarget: number;
  goals: number;
  xg: number;
  xgot: number;
  raw: Record<string, unknown>;
}

export interface UnderstatMatch {
  matchId: string;
  sourceMatchId: number;
  date: string;
  homeTeamId: string;
  awayTeamId: string;
  homeTeamName: string;
  awayTeamName: string;
  homeGoals: number | null;
  awayGoals: number | null;
  homeXG: number | null;
  awayXG: number | null;
  homeTotalShots: number | null;
  awayTotalShots: number | null;
  homeShotsOnTarget: number | null;
  awayShotsOnTarget: number | null;
  homePossession: number | null;
  awayPossession: number | null;
  homeYellowCards: number | null;
  awayYellowCards: number | null;
  homeRedCards: number | null;
  awayRedCards: number | null;
  homeFouls: number | null;
  awayFouls: number | null;
  homeCorners: number | null;
  awayCorners: number | null;
  referee: string | null;
  competition: string;
  season: string;
  rawJson: string;
  playerStats: UnderstatPlayerMatchStat[];
}

export interface UnderstatTeamSeasonStats {
  competition: string;
  season: string;
  teamName: string;
  played: number;
  wins: number;
  draws: number;
  losses: number;
  points: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDiff: number;
  xgForTotal: number | null;
  xgAgainstTotal: number | null;
  xgForPerMatch: number | null;
  xgAgainstPerMatch: number | null;
  possessionAvg: number | null;
  foulsPerMatch: number | null;
  yellowTotal: number | null;
  redTotal: number | null;
  yellowPerMatch: number | null;
  redPerMatch: number | null;
  shotsOnTargetPerMatch: number | null;
  cleanSheetsTotal: number | null;
  source: 'understat_season_stats';
}

type CompetitionConfig = {
  name: string;
  slug: string;
};

type UnderstatLeaguePayload = {
  teams?: Record<string, any>;
  players?: any[];
  dates?: any[];
};

type UnderstatTeamPayload = {
  players?: any[];
  dates?: any[];
  statistics?: Record<string, any>;
};

type UnderstatMatchPayload = {
  rosters?: {
    h?: Record<string, any>;
    a?: Record<string, any>;
  };
  shots?: {
    h?: any[];
    a?: any[];
  };
};

const TEAM_ALIASES: Record<string, string> = {
  internazionale: 'inter',
  inter_milan: 'inter',
  manchester_utd: 'manchester_united',
  man_utd: 'manchester_united',
  man_city: 'manchester_city',
  paris_saint_germain: 'psg',
  psg: 'psg',
  athletic_club: 'athletic_bilbao',
  borussia_monchengladbach: 'monchengladbach',
  gladbach: 'monchengladbach',
  olympique_marseille: 'marseille',
  olympique_lyonnais: 'lyon',
};

const ON_TARGET_RESULTS = new Set(['Goal', 'SavedShot']);

export class UnderstatScraper {
  private static readonly COMPETITIONS: Record<string, CompetitionConfig> = {
    'Serie A': { name: 'Serie A', slug: 'serie_a' },
    'Premier League': { name: 'Premier League', slug: 'epl' },
    'La Liga': { name: 'La Liga', slug: 'la_liga' },
    'Bundesliga': { name: 'Bundesliga', slug: 'bundesliga' },
    'Ligue 1': { name: 'Ligue 1', slug: 'ligue_1' },
  };

  private readonly client = axios.create({
    baseURL: 'https://understat.com',
    timeout: 30000,
    headers: {
      'X-Requested-With': 'XMLHttpRequest',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
      Accept: 'application/json, text/plain, */*',
    },
  });

  static getSupportedCompetitions(): string[] {
    return Object.keys(UnderstatScraper.COMPETITIONS);
  }

  static getTop5Competitions(): string[] {
    return ['Serie A', 'Premier League', 'La Liga', 'Bundesliga', 'Ligue 1'];
  }

  static generateSeasons(yearsBack = 2): string[] {
    const seasons: string[] = [];
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = now.getMonth() + 1;
    const currentSeasonStart = currentMonth >= 7 ? currentYear : currentYear - 1;
    for (let i = 0; i < yearsBack; i++) {
      const start = currentSeasonStart - i;
      seasons.unshift(`${start}/${start + 1}`);
    }
    return seasons;
  }

  static normalizeTeamName(name: string): string {
    const normalized = String(name ?? '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/&/g, ' and ')
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\b(fc|cf|ac|as|ssc|sc|club|calcio|1919)\b/g, ' ')
      .replace(/\s+/g, '_')
      .replace(/^_+|_+$/g, '');
    return TEAM_ALIASES[normalized] ?? normalized;
  }

  private toNumber(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const parsed = typeof value === 'number' ? value : Number(String(value).replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
  }

  private parseSeasonStart(season: string): string {
    const raw = String(season ?? '').trim();
    const match = raw.match(/^(\d{4})/);
    if (match) return match[1];
    const year = Number(raw);
    if (Number.isFinite(year) && year > 2000) return String(Math.trunc(year));
    throw new Error(`Stagione Understat non valida: ${season}`);
  }

  private resolveCompetition(competition: string): CompetitionConfig {
    const cfg = UnderstatScraper.COMPETITIONS[String(competition ?? '').trim()];
    if (!cfg) throw new Error(`Competizione Understat non supportata: ${competition}`);
    return cfg;
  }

  private async fetchJson<T>(path: string): Promise<T> {
    const response = await this.client.get(path);
    return response.data as T;
  }

  private async fetchLeagueData(competition: string, season: string): Promise<UnderstatLeaguePayload> {
    const cfg = this.resolveCompetition(competition);
    const seasonStart = this.parseSeasonStart(season);
    return this.fetchJson<UnderstatLeaguePayload>(`/getLeagueData/${cfg.slug}/${seasonStart}`);
  }

  private async fetchTeamData(teamName: string, season: string): Promise<UnderstatTeamPayload> {
    const seasonStart = this.parseSeasonStart(season);
    const encodedName = encodeURIComponent(String(teamName).trim().replace(/\s+/g, '_'));
    return this.fetchJson<UnderstatTeamPayload>(`/getTeamData/${encodedName}/${seasonStart}`);
  }

  private async fetchMatchData(matchId: number): Promise<UnderstatMatchPayload> {
    return this.fetchJson<UnderstatMatchPayload>(`/getMatchData/${matchId}`);
  }

  private async mapLimit<T, R>(items: T[], limit: number, mapper: (item: T, index: number) => Promise<R>): Promise<R[]> {
    const out = new Array<R>(items.length);
    let cursor = 0;
    const worker = async () => {
      while (cursor < items.length) {
        const index = cursor++;
        out[index] = await mapper(items[index], index);
      }
    };
    const concurrency = Math.max(1, Math.min(limit, items.length || 1));
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return out;
  }

  private buildShotsOnTargetMap(shots: any[]): Map<string, { count: number; xgot: number }> {
    const out = new Map<string, { count: number; xgot: number }>();
    for (const shot of shots) {
      const playerId = String(shot?.player_id ?? '').trim();
      if (!playerId || !ON_TARGET_RESULTS.has(String(shot?.result ?? '').trim())) continue;
      const current = out.get(playerId) ?? { count: 0, xgot: 0 };
      current.count += 1;
      current.xgot += Number(this.toNumber(shot?.xG) ?? 0);
      out.set(playerId, current);
    }
    return out;
  }

  private buildPlayerStats(side: 'h' | 'a', rosters: Record<string, any>, shots: any[]): UnderstatPlayerMatchStat[] {
    const onTargetByPlayer = this.buildShotsOnTargetMap(shots);
    return Object.values(rosters ?? {}).map((entry: any) => {
      const sourcePlayerId = this.toNumber(entry?.player_id ?? entry?.id);
      const playerId = sourcePlayerId !== null
        ? `understat_player_${sourcePlayerId}`
        : `understat_player_${String(entry?.player ?? 'unknown').toLowerCase().replace(/\s+/g, '_')}`;
      const playerOnTarget = onTargetByPlayer.get(String(entry?.player_id ?? '')) ?? { count: 0, xgot: 0 };
      const rawPosition = String(entry?.position ?? 'MF').trim();
      return {
        playerId,
        sourcePlayerId,
        playerName: String(entry?.player ?? 'Unknown'),
        teamId: String(entry?.team_id ?? ''),
        positionCode: rawPosition.split(/\s+/)[0] || 'MF',
        minutes: this.toNumber(entry?.time),
        shots: Number(this.toNumber(entry?.shots) ?? 0),
        shotsOnTarget: playerOnTarget.count,
        goals: Number(this.toNumber(entry?.goals) ?? 0),
        xg: Number(this.toNumber(entry?.xG) ?? 0),
        xgot: Number(playerOnTarget.xgot ?? 0),
        raw: entry && typeof entry === 'object' ? entry : {},
      };
    });
  }

  private enrichMatch(match: UnderstatMatch, payload: UnderstatMatchPayload): UnderstatMatch {
    const homeShots = Array.isArray(payload?.shots?.h) ? payload.shots.h : [];
    const awayShots = Array.isArray(payload?.shots?.a) ? payload.shots.a : [];
    const homeRosters = payload?.rosters?.h ?? {};
    const awayRosters = payload?.rosters?.a ?? {};
    const homePlayers = this.buildPlayerStats('h', homeRosters, homeShots);
    const awayPlayers = this.buildPlayerStats('a', awayRosters, awayShots);

    return {
      ...match,
      homeTotalShots: homeShots.length,
      awayTotalShots: awayShots.length,
      homeShotsOnTarget: homeShots.filter((shot) => ON_TARGET_RESULTS.has(String(shot?.result ?? '').trim())).length,
      awayShotsOnTarget: awayShots.filter((shot) => ON_TARGET_RESULTS.has(String(shot?.result ?? '').trim())).length,
      homeYellowCards: homePlayers.reduce((sum, player) => sum + Number(this.toNumber((player.raw as any)?.yellow_card) ?? 0), 0),
      awayYellowCards: awayPlayers.reduce((sum, player) => sum + Number(this.toNumber((player.raw as any)?.yellow_card) ?? 0), 0),
      homeRedCards: homePlayers.reduce((sum, player) => sum + Number(this.toNumber((player.raw as any)?.red_card) ?? 0), 0),
      awayRedCards: awayPlayers.reduce((sum, player) => sum + Number(this.toNumber((player.raw as any)?.red_card) ?? 0), 0),
      playerStats: [...homePlayers, ...awayPlayers],
      rawJson: JSON.stringify({
        match: JSON.parse(match.rawJson),
        details: payload,
      }),
    };
  }

  async scrapeSeason(
    competition: string,
    season: string,
    options?: { includeDetails?: boolean; detailConcurrency?: number }
  ): Promise<UnderstatMatch[]> {
    const payload = await this.fetchLeagueData(competition, season);
    const dates = Array.isArray(payload?.dates) ? payload.dates : [];
    const matches: UnderstatMatch[] = dates.map((entry: any) => ({
      matchId: `understat_${String(entry?.id ?? '').trim()}`,
      sourceMatchId: Number(this.toNumber(entry?.id) ?? 0),
      date: String(entry?.datetime ?? '').trim(),
      homeTeamId: String(entry?.h?.id ?? ''),
      awayTeamId: String(entry?.a?.id ?? ''),
      homeTeamName: String(entry?.h?.title ?? ''),
      awayTeamName: String(entry?.a?.title ?? ''),
      homeGoals: this.toNumber(entry?.goals?.h),
      awayGoals: this.toNumber(entry?.goals?.a),
      homeXG: this.toNumber(entry?.xG?.h),
      awayXG: this.toNumber(entry?.xG?.a),
      homeTotalShots: null,
      awayTotalShots: null,
      homeShotsOnTarget: null,
      awayShotsOnTarget: null,
      homePossession: null,
      awayPossession: null,
      homeYellowCards: null,
      awayYellowCards: null,
      homeRedCards: null,
      awayRedCards: null,
      homeFouls: null,
      awayFouls: null,
      homeCorners: null,
      awayCorners: null,
      referee: null,
      competition,
      season,
      rawJson: JSON.stringify(entry ?? {}),
      playerStats: [],
    }));

    if (!options?.includeDetails) return matches;

    const completedMatches = matches
      .map((match, index) => ({ match, index }))
      .filter(({ match }) => match.homeGoals !== null && match.awayGoals !== null && match.sourceMatchId > 0);

    const details = await this.mapLimit(
      completedMatches,
      options?.detailConcurrency ?? 6,
      async ({ match }) => {
        try {
          return await this.fetchMatchData(match.sourceMatchId);
        } catch {
          return null;
        }
      }
    );

    details.forEach((detail, idx) => {
      if (!detail) return;
      const targetIndex = completedMatches[idx].index;
      matches[targetIndex] = this.enrichMatch(matches[targetIndex], detail);
    });

    return matches;
  }

  async getTeamSeasonStats(competition: string, season: string, teamName: string): Promise<UnderstatTeamSeasonStats | null> {
    const leaguePayload = await this.fetchLeagueData(competition, season);
    const teams = Object.values(leaguePayload?.teams ?? {});
    const normalizedTarget = UnderstatScraper.normalizeTeamName(teamName);
    const teamEntry = teams.find((entry: any) =>
      UnderstatScraper.normalizeTeamName(String(entry?.title ?? '')) === normalizedTarget
    );
    if (!teamEntry) return null;

    const history = Array.isArray(teamEntry?.history) ? teamEntry.history : [];
    const played = history.length;
    const wins = history.filter((item: any) => String(item?.result ?? '') === 'w').length;
    const draws = history.filter((item: any) => String(item?.result ?? '') === 'd').length;
    const losses = history.filter((item: any) => String(item?.result ?? '') === 'l').length;
    const goalsFor = history.reduce((sum: number, item: any) => sum + Number(this.toNumber(item?.scored) ?? 0), 0);
    const goalsAgainst = history.reduce((sum: number, item: any) => sum + Number(this.toNumber(item?.missed) ?? 0), 0);
    const xgForTotal = history.reduce((sum: number, item: any) => sum + Number(this.toNumber(item?.xG) ?? 0), 0);
    const xgAgainstTotal = history.reduce((sum: number, item: any) => sum + Number(this.toNumber(item?.xGA) ?? 0), 0);
    const points = history.reduce((sum: number, item: any) => sum + Number(this.toNumber(item?.pts) ?? 0), 0);
    const cleanSheetsTotal = history.filter((item: any) => Number(this.toNumber(item?.missed) ?? -1) === 0).length;

    let teamPayload: UnderstatTeamPayload | null = null;
    try {
      teamPayload = await this.fetchTeamData(String(teamEntry?.title ?? teamName), season);
    } catch {
      teamPayload = null;
    }

    const players = Array.isArray(teamPayload?.players) ? teamPayload!.players! : [];
    const yellowTotal = players.reduce((sum: number, player: any) => sum + Number(this.toNumber(player?.yellow_cards) ?? 0), 0);
    const redTotal = players.reduce((sum: number, player: any) => sum + Number(this.toNumber(player?.red_cards) ?? 0), 0);

    return {
      competition,
      season,
      teamName: String(teamEntry?.title ?? teamName),
      played,
      wins,
      draws,
      losses,
      points,
      goalsFor,
      goalsAgainst,
      goalDiff: goalsFor - goalsAgainst,
      xgForTotal: played > 0 ? xgForTotal : null,
      xgAgainstTotal: played > 0 ? xgAgainstTotal : null,
      xgForPerMatch: played > 0 ? xgForTotal / played : null,
      xgAgainstPerMatch: played > 0 ? xgAgainstTotal / played : null,
      possessionAvg: null,
      foulsPerMatch: null,
      yellowTotal: played > 0 ? yellowTotal : null,
      redTotal: played > 0 ? redTotal : null,
      yellowPerMatch: played > 0 ? yellowTotal / played : null,
      redPerMatch: played > 0 ? redTotal / played : null,
      shotsOnTargetPerMatch: null,
      cleanSheetsTotal,
      source: 'understat_season_stats',
    };
  }

  toDbFormat(match: UnderstatMatch): Record<string, unknown> {
    return {
      matchId: match.matchId,
      homeTeamId: match.homeTeamId,
      awayTeamId: match.awayTeamId,
      homeTeamName: match.homeTeamName,
      awayTeamName: match.awayTeamName,
      date: new Date(match.date),
      homeGoals: match.homeGoals,
      awayGoals: match.awayGoals,
      homeXG: match.homeXG,
      awayXG: match.awayXG,
      homeTotalShots: match.homeTotalShots,
      awayTotalShots: match.awayTotalShots,
      homeShotsOnTarget: match.homeShotsOnTarget,
      awayShotsOnTarget: match.awayShotsOnTarget,
      homePossession: match.homePossession,
      awayPossession: match.awayPossession,
      homeYellowCards: match.homeYellowCards,
      awayYellowCards: match.awayYellowCards,
      homeRedCards: match.homeRedCards,
      awayRedCards: match.awayRedCards,
      homeFouls: match.homeFouls,
      awayFouls: match.awayFouls,
      homeCorners: match.homeCorners,
      awayCorners: match.awayCorners,
      referee: match.referee,
      competition: match.competition,
      season: match.season,
      source: 'understat',
      sourceMatchId: match.sourceMatchId,
      rawJson: match.rawJson,
    };
  }

  async close(): Promise<void> {
    return Promise.resolve();
  }
}
