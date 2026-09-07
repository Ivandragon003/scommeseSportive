import { createHash } from 'node:crypto';

export type ApiFootballLineupPlayer = {
  id: number | null;
  name: string;
  starter: boolean;
  position?: string | null;
};

export type ApiFootballLineup = {
  teamId: number | null;
  teamName: string;
  formation: string | null;
  players: ApiFootballLineupPlayer[];
};

export type ApiFootballFixture = {
  id: number;
  date: string;
  homeName: string;
  awayName: string;
  homeProviderTeamId: number | null;
  awayProviderTeamId: number | null;
  referee: string | null;
};

export function mapApiFootballFixture(row: any): ApiFootballFixture {
  return {
    id: Number(row?.fixture?.id),
    date: String(row?.fixture?.date ?? ''),
    homeName: String(row?.teams?.home?.name ?? '').trim(),
    awayName: String(row?.teams?.away?.name ?? '').trim(),
    homeProviderTeamId: Number.isFinite(Number(row?.teams?.home?.id)) ? Number(row.teams.home.id) : null,
    awayProviderTeamId: Number.isFinite(Number(row?.teams?.away?.id)) ? Number(row.teams.away.id) : null,
    referee: String(row?.fixture?.referee ?? '').split(',')[0].trim() || null,
  };
}

type ApiFootballResponse<T> = { response?: T[]; errors?: Record<string, string> };

export class ApiFootballService {
  private static readonly authCooldowns = new Map<string, { until: number; message: string }>();
  private readonly apiKey = String(process.env.API_FOOTBALL_KEY ?? '').trim();
  private readonly baseUrl = String(process.env.API_FOOTBALL_BASE_URL ?? 'https://v3.football.api-sports.io').replace(/\/$/, '');
  private readonly timeoutMs = Number(process.env.API_FOOTBALL_TIMEOUT_MS ?? 15000);
  private readonly accountScope = createHash('sha256').update(`${this.baseUrl}\n${this.apiKey}`).digest('hex');

  private blockAccount(message: string): Error {
    const seconds = Math.max(30, Math.min(3600, Number(process.env.API_FOOTBALL_AUTH_COOLDOWN_SECONDS ?? 900) || 900));
    const until = Date.now() + seconds * 1000;
    const detail = `${message}; retry paused until ${new Date(until).toISOString()}`;
    if (ApiFootballService.authCooldowns.size >= 100) {
      ApiFootballService.authCooldowns.delete(ApiFootballService.authCooldowns.keys().next().value!);
    }
    ApiFootballService.authCooldowns.set(this.accountScope, { until, message: detail });
    return new Error(detail);
  }

  get enabled(): boolean {
    return String(process.env.API_FOOTBALL_ENABLED ?? 'false').toLowerCase() === 'true' && this.apiKey.length > 0;
  }

  private async get<T>(path: string, params: Record<string, string | number>): Promise<T[]> {
    if (!this.enabled) return [];
    const cooldown = ApiFootballService.authCooldowns.get(this.accountScope);
    if (cooldown && cooldown.until > Date.now()) throw new Error(cooldown.message);
    ApiFootballService.authCooldowns.delete(this.accountScope);
    const url = new URL(`${this.baseUrl}${path}`);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, String(value)));
    const response = await fetch(url, {
      headers: { 'x-apisports-key': this.apiKey },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (response.status === 401 || response.status === 403) {
      throw this.blockAccount(`API-Football HTTP ${response.status}`);
    }
    if (!response.ok) throw new Error(`API-Football HTTP ${response.status}`);
    const payload = await response.json() as ApiFootballResponse<T>;
    if (payload.errors && Object.keys(payload.errors).length > 0) {
      const message = `API-Football: ${Object.values(payload.errors).join(', ')}`;
      if (/suspend|invalid.*(?:key|token)|(?:key|token).*invalid|unauthoriz|account.*(?:inactive|disabled)/i.test(message)) {
        throw this.blockAccount(message);
      }
      throw new Error(message);
    }
    return Array.isArray(payload.response) ? payload.response : [];
  }

  async getConfirmedLineups(fixtureId: string | number): Promise<ApiFootballLineup[]> {
    const rows = await this.get<any>('/fixtures/lineups', { fixture: fixtureId });
    return rows.map((row) => ({
      teamId: Number.isFinite(Number(row?.team?.id)) ? Number(row.team.id) : null,
      teamName: String(row?.team?.name ?? '').trim(),
      formation: row?.formation ?? null,
      players: [
        ...(Array.isArray(row?.startXI) ? row.startXI : []).map((entry: any) => ({
          id: Number.isFinite(Number(entry?.player?.id)) ? Number(entry.player.id) : null,
          name: String(entry?.player?.name ?? '').trim(),
          starter: true,
          position: entry?.player?.pos ?? null,
        })),
        ...(Array.isArray(row?.substitutes) ? row.substitutes : []).map((entry: any) => ({
          id: Number.isFinite(Number(entry?.player?.id)) ? Number(entry.player.id) : null,
          name: String(entry?.player?.name ?? '').trim(),
          starter: false,
          position: entry?.player?.pos ?? null,
        })),
      ],
    }));
  }

  async getFixturesByDate(date: string): Promise<ApiFootballFixture[]> {
    const rows = await this.get<any>('/fixtures', { date });
    return rows.map(mapApiFootballFixture)
      .filter((row) => Number.isFinite(row.id) && row.homeName && row.awayName);
  }

  async getSquad(providerTeamId: string | number): Promise<Array<{ id: number | null; name: string; position: string | null }>> {
    const rows = await this.get<any>('/players/squads', { team: providerTeamId });
    const players = Array.isArray(rows[0]?.players) ? rows[0].players : [];
    return players.map((entry: any) => ({
      id: Number.isFinite(Number(entry?.id)) ? Number(entry.id) : null,
      name: String(entry?.name ?? '').trim(),
      position: String(entry?.position ?? '').trim() || null,
    })).filter((entry) => entry.name);
  }

  async getInjuries(params: { fixture?: string | number; league?: string | number; season?: string | number; team?: string | number }): Promise<any[]> {
    return this.get<any>('/injuries', params as Record<string, string | number>);
  }
}
