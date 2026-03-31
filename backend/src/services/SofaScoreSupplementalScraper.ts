import { chromium, type Browser, type Page } from 'playwright';
import { UnderstatScraper } from './UnderstatScraper';

type MatchLikeRow = {
  match_id: string;
  home_team_id: string;
  away_team_id: string;
  home_team_name: string | null;
  away_team_name: string | null;
  date: string;
  home_goals?: number | null;
  away_goals?: number | null;
  home_possession?: number | null;
  away_possession?: number | null;
  home_fouls?: number | null;
  away_fouls?: number | null;
  home_corners?: number | null;
  away_corners?: number | null;
  referee?: string | null;
  competition?: string | null;
  season?: string | null;
  source?: string | null;
  source_match_id?: number | null;
};

type SofaScoreEventSummary = {
  id: number;
  startTimestamp: number;
  competition: string | null;
  homeTeamName: string;
  awayTeamName: string;
};

type SofaScoreRefereeStats = {
  refId: string;
  name: string;
  avgYellow: number | null;
  avgRed: number | null;
  avgFouls: number | null;
  games: number | null;
};

type SofaScoreSupplementalStats = {
  eventId: number;
  homePossession: number | null;
  awayPossession: number | null;
  homeFouls: number | null;
  awayFouls: number | null;
  homeCorners: number | null;
  awayCorners: number | null;
  referee: string | null;
  refereeStats: SofaScoreRefereeStats | null;
};

type SofaScoreSyncSummary = {
  considered: number;
  matchedEvents: number;
  updatedMatches: number;
  updatedReferees: number;
  skippedNoEvent: number;
  skippedNoStats: number;
  errors: number;
  updatedMatchIds: string[];
  errorSamples: string[];
};

type SofaScoreAppliedUpdate = {
  row: MatchLikeRow;
  refereeStats: SofaScoreRefereeStats | null;
};

const SOFASCORE_BOOTSTRAP_URL = 'https://www.sofascore.com/football';
const SOFASCORE_BASE_URL = 'https://www.sofascore.com';
const SOFASCORE_REQUEST_TIMEOUT_MS = Math.max(
  5_000,
  Math.min(Number(process.env.SOFASCORE_REQUEST_TIMEOUT_MS ?? 15_000) || 15_000, 60_000)
);

const TEAM_ALIASES: Record<string, string> = {
  ac_milan: 'milan',
  milan: 'milan',
  hellas_verona: 'verona',
  verona: 'verona',
  parma_calcio_1913: 'parma',
  parma: 'parma',
  internazionale: 'inter',
  inter_milan: 'inter',
  inter: 'inter',
  paris_saint_germain: 'psg',
  psg: 'psg',
  athletic_club: 'athletic_bilbao',
  borussia_monchengladbach: 'monchengladbach',
  gladbach: 'monchengladbach',
};

export class SofaScoreSupplementalScraper {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private readonly scheduledEventsCache = new Map<string, SofaScoreEventSummary[]>();

  static normalizeTeamName(name: string): string {
    const normalized = UnderstatScraper.normalizeTeamName(name);
    return TEAM_ALIASES[normalized] ?? normalized;
  }

  private static normalizeCompetitionName(name: string | null | undefined): string {
    return String(name ?? '').trim().toLowerCase();
  }

  private static toNumber(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    const normalized = String(value).replace('%', '').replace(',', '.').trim();
    if (!normalized) return null;
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  private static buildRefereeStats(referee: any): SofaScoreRefereeStats | null {
    const name = String(referee?.name ?? '').trim();
    if (!name) return null;

    const games = SofaScoreSupplementalScraper.toNumber(referee?.games);
    const yellowCards = SofaScoreSupplementalScraper.toNumber(referee?.yellowCards);
    const redCards = SofaScoreSupplementalScraper.toNumber(referee?.redCards);
    const yellowRedCards = SofaScoreSupplementalScraper.toNumber(referee?.yellowRedCards);
    const totalRedDismissals = (redCards ?? 0) + (yellowRedCards ?? 0);

    return {
      refId: String(referee?.id ?? name.toLowerCase().replace(/\s+/g, '_')).trim(),
      name,
      avgYellow: games && games > 0 && yellowCards !== null ? yellowCards / games : null,
      avgRed: games && games > 0 ? totalRedDismissals / games : null,
      avgFouls: null,
      games,
    };
  }

  private static extractStatisticValue(items: Array<Record<string, any>>, key: string, side: 'homeValue' | 'awayValue'): number | null {
    const item = items.find((entry) => String(entry?.key ?? '') === key)
      ?? items.find((entry) => String(entry?.name ?? '').trim().toLowerCase() === key.toLowerCase());
    return SofaScoreSupplementalScraper.toNumber(item?.[side]);
  }

  private async ensurePage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) return this.page;

    this.browser = await chromium.launch({
      headless: String(process.env.SOFASCORE_BROWSER_HEADLESS ?? 'true').trim().toLowerCase() !== 'false',
      slowMo: Math.max(0, Math.min(Number(process.env.SOFASCORE_BROWSER_SLOW_MO ?? 0) || 0, 1_000)),
    });

    this.page = await this.browser.newPage({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36',
      locale: 'it-IT',
      timezoneId: 'Europe/Rome',
    });
    this.page.setDefaultNavigationTimeout(60_000);
    this.page.setDefaultTimeout(SOFASCORE_REQUEST_TIMEOUT_MS);
    await this.page.goto(SOFASCORE_BOOTSTRAP_URL, { waitUntil: 'domcontentloaded' });
    await this.page.waitForTimeout(1_500);
    return this.page;
  }

  private async fetchJson<T>(path: string, attempt = 1): Promise<T> {
    const page = await this.ensurePage();
    try {
      return await page.evaluate(async ({ url, timeoutMs }) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const response = await fetch(url, {
            credentials: 'include',
            headers: { Accept: 'application/json, text/plain, */*' },
            signal: controller.signal,
          });
          const text = await response.text();
          if (!response.ok) {
            throw new Error(`SofaScore ${response.status} ${url}: ${text.slice(0, 200)}`);
          }
          return JSON.parse(text);
        } finally {
          clearTimeout(timer);
        }
      }, { url: `${SOFASCORE_BASE_URL}${path}`, timeoutMs: SOFASCORE_REQUEST_TIMEOUT_MS });
    } catch (error: any) {
      if (attempt >= 2) throw error;
      await this.resetPage();
      return this.fetchJson<T>(path, attempt + 1);
    }
  }

  private async resetPage(): Promise<void> {
    if (this.page && !this.page.isClosed()) {
      await this.page.close().catch(() => undefined);
    }
    this.page = null;
  }

  private async getScheduledEvents(dateIso: string): Promise<SofaScoreEventSummary[]> {
    const key = String(dateIso ?? '').slice(0, 10);
    if (!key) return [];
    const cached = this.scheduledEventsCache.get(key);
    if (cached) return cached;

    const payload = await this.fetchJson<any>(`/api/v1/sport/football/scheduled-events/${key}`);
    const events = Array.isArray(payload?.events) ? payload.events : [];
    const mapped = events
      .map((event: any) => ({
        id: Number(event?.id ?? 0),
        startTimestamp: Number(event?.startTimestamp ?? 0),
        competition: String(
          event?.tournament?.uniqueTournament?.name
          ?? event?.tournament?.name
          ?? ''
        ).trim() || null,
        homeTeamName: String(event?.homeTeam?.name ?? '').trim(),
        awayTeamName: String(event?.awayTeam?.name ?? '').trim(),
      }))
      .filter((event: SofaScoreEventSummary) => event.id > 0 && event.homeTeamName && event.awayTeamName);

    this.scheduledEventsCache.set(key, mapped);
    return mapped;
  }

  private findMatchingEvent(row: MatchLikeRow, events: SofaScoreEventSummary[]): SofaScoreEventSummary | null {
    const targetHome = SofaScoreSupplementalScraper.normalizeTeamName(String(row.home_team_name ?? row.home_team_id ?? ''));
    const targetAway = SofaScoreSupplementalScraper.normalizeTeamName(String(row.away_team_name ?? row.away_team_id ?? ''));
    const targetCompetition = SofaScoreSupplementalScraper.normalizeCompetitionName(row.competition);
    const targetDateMs = new Date(String(row.date ?? '')).getTime();

    const candidates = events.filter((event) =>
      SofaScoreSupplementalScraper.normalizeTeamName(event.homeTeamName) === targetHome
      && SofaScoreSupplementalScraper.normalizeTeamName(event.awayTeamName) === targetAway
    );
    if (candidates.length === 0) return null;

    const sameCompetition = candidates.filter((event) =>
      SofaScoreSupplementalScraper.normalizeCompetitionName(event.competition) === targetCompetition
    );
    const pool = sameCompetition.length > 0 ? sameCompetition : candidates;

    return pool
      .slice()
      .sort((a, b) => {
        const aDiff = Math.abs((a.startTimestamp * 1_000) - targetDateMs);
        const bDiff = Math.abs((b.startTimestamp * 1_000) - targetDateMs);
        return aDiff - bDiff;
      })[0] ?? null;
  }

  private async fetchSupplementalForMatch(row: MatchLikeRow): Promise<SofaScoreSupplementalStats | null> {
    const events = await this.getScheduledEvents(row.date);
    const eventSummary = this.findMatchingEvent(row, events);
    if (!eventSummary) return null;

    const isPlayed = row.home_goals !== null && row.home_goals !== undefined
      && row.away_goals !== null && row.away_goals !== undefined;

    const [eventPayload, statisticsPayload] = await Promise.all([
      this.fetchJson<any>(`/api/v1/event/${eventSummary.id}`),
      isPlayed ? this.fetchJson<any>(`/api/v1/event/${eventSummary.id}/statistics`) : Promise.resolve(null),
    ]);

    const referee = eventPayload?.event?.referee ?? null;
    const periods = Array.isArray(statisticsPayload?.statistics) ? statisticsPayload.statistics : [];
    const allPeriod = periods.find((period: any) => String(period?.period ?? '').toUpperCase() === 'ALL') ?? periods[0] ?? null;
    const groups = Array.isArray(allPeriod?.groups) ? allPeriod.groups : [];
    const items = groups.flatMap((group: any) => Array.isArray(group?.statisticsItems) ? group.statisticsItems : []);

    const homePossession = SofaScoreSupplementalScraper.extractStatisticValue(items, 'ballPossession', 'homeValue');
    const awayPossession = SofaScoreSupplementalScraper.extractStatisticValue(items, 'ballPossession', 'awayValue');
    const homeFouls = SofaScoreSupplementalScraper.extractStatisticValue(items, 'fouls', 'homeValue');
    const awayFouls = SofaScoreSupplementalScraper.extractStatisticValue(items, 'fouls', 'awayValue');
    const homeCorners = SofaScoreSupplementalScraper.extractStatisticValue(items, 'cornerKicks', 'homeValue');
    const awayCorners = SofaScoreSupplementalScraper.extractStatisticValue(items, 'cornerKicks', 'awayValue');

    return {
      eventId: eventSummary.id,
      homePossession,
      awayPossession,
      homeFouls,
      awayFouls,
      homeCorners,
      awayCorners,
      referee: typeof referee?.name === 'string' ? referee.name.trim() || null : null,
      refereeStats: SofaScoreSupplementalScraper.buildRefereeStats(referee),
    };
  }

  private async collectUpdates(rows: MatchLikeRow[]): Promise<{
    summary: SofaScoreSyncSummary;
    updates: SofaScoreAppliedUpdate[];
  }> {
    const summary: SofaScoreSyncSummary = {
      considered: 0,
      matchedEvents: 0,
      updatedMatches: 0,
      updatedReferees: 0,
      skippedNoEvent: 0,
      skippedNoStats: 0,
      errors: 0,
      updatedMatchIds: [],
      errorSamples: [],
    };
    const updates: SofaScoreAppliedUpdate[] = [];

    const dedupedRows = Array.from(
      new Map(rows.map((row) => [String(row.match_id), row])).values()
    );

    for (const row of dedupedRows) {
      summary.considered += 1;
      try {
        const supplemental = await this.fetchSupplementalForMatch(row);
        if (!supplemental) {
          summary.skippedNoEvent += 1;
          continue;
        }
        summary.matchedEvents += 1;

        const hasMatchStats = [
          supplemental.homePossession,
          supplemental.awayPossession,
          supplemental.homeFouls,
          supplemental.awayFouls,
          supplemental.homeCorners,
          supplemental.awayCorners,
        ].some((value) => value !== null);

        const refereeChanged = supplemental.referee && supplemental.referee !== String(row.referee ?? '').trim();
        const statsChanged = (
          (supplemental.homePossession !== null && supplemental.homePossession !== Number(row.home_possession ?? NaN))
          || (supplemental.awayPossession !== null && supplemental.awayPossession !== Number(row.away_possession ?? NaN))
          || (supplemental.homeFouls !== null && supplemental.homeFouls !== Number(row.home_fouls ?? NaN))
          || (supplemental.awayFouls !== null && supplemental.awayFouls !== Number(row.away_fouls ?? NaN))
          || (supplemental.homeCorners !== null && supplemental.homeCorners !== Number(row.home_corners ?? NaN))
          || (supplemental.awayCorners !== null && supplemental.awayCorners !== Number(row.away_corners ?? NaN))
        );

        if (!refereeChanged && !statsChanged) {
          if (!hasMatchStats && !supplemental.referee) summary.skippedNoStats += 1;
          continue;
        }

        summary.updatedMatches += 1;
        summary.updatedMatchIds.push(String(row.match_id));

        const updatedRow: MatchLikeRow = {
          ...row,
          home_possession: supplemental.homePossession ?? row.home_possession ?? null,
          away_possession: supplemental.awayPossession ?? row.away_possession ?? null,
          home_fouls: supplemental.homeFouls ?? row.home_fouls ?? null,
          away_fouls: supplemental.awayFouls ?? row.away_fouls ?? null,
          home_corners: supplemental.homeCorners ?? row.home_corners ?? null,
          away_corners: supplemental.awayCorners ?? row.away_corners ?? null,
          referee: supplemental.referee ?? row.referee ?? null,
        };
        updates.push({ row: updatedRow, refereeStats: supplemental.refereeStats });
        if (supplemental.refereeStats?.name) summary.updatedReferees += 1;
      } catch (error: any) {
        summary.errors += 1;
        if (summary.errorSamples.length < 5) {
          summary.errorSamples.push(`${row.match_id}: ${error?.message ?? 'errore sconosciuto'}`);
        }
      }
    }

    return { summary, updates };
  }

  async syncMatches(rows: MatchLikeRow[]): Promise<SofaScoreSyncSummary> {
    const { summary } = await this.collectUpdates(rows);
    return summary;
  }

  async applyToDatabase(
    db: {
      upsertMatch: (match: any) => Promise<void>;
      upsertReferee: (referee: any) => Promise<void>;
    },
    rows: MatchLikeRow[]
  ): Promise<SofaScoreSyncSummary> {
    const { summary, updates } = await this.collectUpdates(rows.map((row) => ({ ...row })));

    for (const update of updates) {
      const row = update.row;
      await db.upsertMatch({
        matchId: row.match_id,
        homeTeamId: row.home_team_id,
        awayTeamId: row.away_team_id,
        homeTeamName: row.home_team_name ?? null,
        awayTeamName: row.away_team_name ?? null,
        date: row.date,
        homeGoals: row.home_goals ?? null,
        awayGoals: row.away_goals ?? null,
        homePossession: row.home_possession ?? null,
        awayPossession: row.away_possession ?? null,
        homeFouls: row.home_fouls ?? null,
        awayFouls: row.away_fouls ?? null,
        homeCorners: row.home_corners ?? null,
        awayCorners: row.away_corners ?? null,
        referee: row.referee ?? null,
        competition: row.competition ?? null,
        season: row.season ?? null,
        source: row.source ?? null,
        sourceMatchId: row.source_match_id ?? null,
      });

      if (!update.refereeStats?.name) continue;
      await db.upsertReferee({
        refId: update.refereeStats.refId,
        name: update.refereeStats.name,
        avgYellow: update.refereeStats.avgYellow ?? undefined,
        avgRed: update.refereeStats.avgRed ?? undefined,
        avgFouls: update.refereeStats.avgFouls ?? undefined,
        games: update.refereeStats.games ?? undefined,
      });
    }

    return summary;
  }

  async close(): Promise<void> {
    await this.resetPage();
    if (this.browser) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
    }
  }
}
