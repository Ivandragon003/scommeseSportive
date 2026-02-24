import { Browser, Page, chromium } from 'playwright';

export interface FotmobMatch {
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
  referee: string | null;
  competition: string;
  season: string;
  rawJson: string;
  playerStats: FotmobPlayerMatchStat[];
}

export interface FotmobPlayerMatchStat {
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

interface CompetitionConfig {
  name: string;
  id: number;
}

const COMPETITIONS: Record<string, CompetitionConfig> = {
  'Serie A': { name: 'Serie A', id: 55 },
  'Premier League': { name: 'Premier League', id: 47 },
  'La Liga': { name: 'La Liga', id: 87 },
  'Bundesliga': { name: 'Bundesliga', id: 54 },
  'Ligue 1': { name: 'Ligue 1', id: 53 },
};

export class FotmobScraper {
  private readonly BASE_URL = 'https://www.fotmob.com';
  private readonly REQUEST_DELAY_MS = 220;
  private readonly DETAILS_MAX_RETRIES = 3;
  private readonly DETAILS_RETRY_WAIT_MS = 5000;
  private readonly FETCH_TIMEOUT_MS = 45000;
  private browser: Browser | null = null;
  private page: Page | null = null;

  static getSupportedCompetitions(): string[] {
    return Object.keys(COMPETITIONS);
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

  normalizeTeamName(name: string): string {
    return name.toLowerCase().trim().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '');
  }

  private async ensurePage(): Promise<Page> {
    if (!this.browser) {
      this.browser = await chromium.launch({
        headless: true,
        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
      });
    }
    if (!this.page) {
      this.page = await this.browser.newPage();
      await this.page.goto(this.BASE_URL, { waitUntil: 'domcontentloaded', timeout: 60000 });
    }
    return this.page;
  }

  private toNumber(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const parsed = typeof value === 'number' ? value : parseFloat(String(value).replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : null;
  }

  private isLikelyFinished(summary: any): boolean {
    const finishedFlag = String(summary?.status?.finished ?? '').toLowerCase();
    if (finishedFlag === 'true') return true;

    const reason = String(summary?.status?.reason?.short ?? summary?.status?.reason?.long ?? '').toLowerCase();
    if (!reason) return false;
    return reason.includes('ft') || reason.includes('aet') || reason.includes('pen');
  }

  private extractGoalsFromSummary(summary: any): { home: number | null; away: number | null } {
    const homeDirect = this.toNumber(summary?.home?.score ?? summary?.result?.home ?? summary?.homeTeam?.score);
    const awayDirect = this.toNumber(summary?.away?.score ?? summary?.result?.away ?? summary?.awayTeam?.score);
    if (homeDirect !== null && awayDirect !== null) {
      return { home: homeDirect, away: awayDirect };
    }

    const scoreStrRaw = String(
      summary?.status?.scoreStr ??
      summary?.status?.score ??
      summary?.scoreStr ??
      summary?.score ??
      ''
    ).trim();

    const match = scoreStrRaw.match(/(\d+)\s*[-:]\s*(\d+)/);
    if (match) {
      return { home: this.toNumber(match[1]), away: this.toNumber(match[2]) };
    }

    return { home: null, away: null };
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private async fetchJson<T>(apiPath: string): Promise<T> {
    const page = await this.ensurePage();
    const url = `${this.BASE_URL}${apiPath}`;
    const response = await page.request.get(url, {
      headers: {
        'Accept': 'application/json, text/plain, */*',
        'Referer': this.BASE_URL,
        'Origin': this.BASE_URL,
        'X-Requested-With': 'XMLHttpRequest',
      },
      timeout: this.FETCH_TIMEOUT_MS,
    });
    if (response.ok()) {
      return response.json() as Promise<T>;
    }

    // Fallback: fetch eseguito dentro il browser context con cookie/sessione attiva.
    const fallback = await page.evaluate(async (fullUrl: string) => {
      const r = await fetch(fullUrl, {
        method: 'GET',
        credentials: 'include',
        headers: {
          'Accept': 'application/json, text/plain, */*',
        },
      });
      const text = await r.text();
      return { ok: r.ok, status: r.status, text };
    }, url);

    if (!fallback.ok) {
      throw new Error(`FotMob API ${apiPath} returned ${fallback.status}`);
    }

    return JSON.parse(fallback.text) as T;
  }

  private detailsApiBlocked(message: string): boolean {
    const msg = String(message ?? '').toLowerCase();
    const blockedStatus =
      msg.includes('returned 403') ||
      msg.includes('returned 401') ||
      msg.includes('returned 429');
    return msg.includes('/api/matchdetails') && blockedStatus;
  }

  private extractNextDataPageProps(html: string): any | null {
    const scriptMatch = html.match(
      /<script[^>]*id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i
    );
    if (!scriptMatch?.[1]) return null;
    try {
      const parsed = JSON.parse(scriptMatch[1]);
      return parsed?.props?.pageProps ?? null;
    } catch {
      return null;
    }
  }

  private extractMatchDetailsFromPageProps(pageProps: any): any | null {
    if (!pageProps || typeof pageProps !== 'object') return null;

    const direct = [
      pageProps?.matchDetails,
      pageProps?.data?.matchDetails,
      pageProps?.initialMatch?.matchDetails,
      pageProps?.fallbackData?.matchDetails,
      pageProps?.match?.matchDetails,
    ];
    for (const candidate of direct) {
      if (candidate && typeof candidate === 'object') return candidate;
    }

    // FotMob cambia spesso la shape: cerca ricorsivamente un oggetto "simile" a matchDetails.
    const stack: unknown[] = [pageProps];
    const seen = new Set<unknown>();
    while (stack.length > 0) {
      const node = stack.pop();
      if (!node || typeof node !== 'object' || seen.has(node)) continue;
      seen.add(node);

      if (!Array.isArray(node)) {
        const obj = node as Record<string, unknown>;
        const hasGeneral = Object.prototype.hasOwnProperty.call(obj, 'general');
        const hasPayload =
          Object.prototype.hasOwnProperty.call(obj, 'content') ||
          Object.prototype.hasOwnProperty.call(obj, 'header') ||
          Object.prototype.hasOwnProperty.call(obj, 'stats');
        if (hasGeneral && hasPayload) return obj;

        const maybeDetails = obj.matchDetails;
        if (maybeDetails && typeof maybeDetails === 'object') return maybeDetails;

        for (const value of Object.values(obj)) stack.push(value);
      } else {
        for (const value of node) stack.push(value);
      }
    }

    return null;
  }

  private extractDetailsMatchId(details: any): number | null {
    const candidate = this.toNumber(
      details?.general?.matchId ??
      details?.matchId ??
      details?.header?.matchId ??
      details?.header?.status?.matchId
    );
    return candidate === null ? null : Math.trunc(candidate);
  }

  private async fetchDetailsFromMatchPage(matchId: number, rawPageUrl?: unknown): Promise<any | null> {
    const page = await this.ensurePage();
    const normalizePagePath = (value: unknown): string | null => {
      const raw = String(value ?? '').trim();
      if (!raw) return null;
      try {
        const candidate = raw.startsWith('http') ? new URL(raw).pathname : raw;
        if (!candidate.startsWith('/')) return null;
        const noHash = candidate.split('#')[0];
        const noQuery = noHash.split('?')[0];
        return noQuery.length > 1 ? noQuery : null;
      } catch {
        return null;
      }
    };

    const paths = Array.from(new Set([
      normalizePagePath(rawPageUrl),
      `/matches/${matchId}`,
      `/matches/${matchId}/matchfacts`,
    ].filter((p): p is string => Boolean(p))));

    for (const path of paths) {
      const url = `${this.BASE_URL}${path}`;

      try {
        const response = await page.request.get(url, {
          headers: {
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Referer': this.BASE_URL,
          },
          timeout: this.FETCH_TIMEOUT_MS,
        });
        if (response.ok()) {
          const html = await response.text();
          const pageProps = this.extractNextDataPageProps(html);
          const details = this.extractMatchDetailsFromPageProps(pageProps);
          if (details && this.extractDetailsMatchId(details) === Math.trunc(matchId)) return details;
        }
      } catch {
        // prova successiva
      }

      try {
        const fallback = await page.evaluate(async (fullUrl: string) => {
          const r = await fetch(fullUrl, {
            method: 'GET',
            credentials: 'include',
            headers: {
              'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
          });
          const text = await r.text();
          return { ok: r.ok, text };
        }, url);
        if (fallback.ok) {
          const pageProps = this.extractNextDataPageProps(fallback.text);
          const details = this.extractMatchDetailsFromPageProps(pageProps);
          if (details && this.extractDetailsMatchId(details) === Math.trunc(matchId)) return details;
        }
      } catch {
        // prova successiva
      }
    }

    return null;
  }

  private findStatPair(payload: unknown, searchTerms: string[]): { home: number | null; away: number | null } {
    // confronto fuzzy: lowercase + rimozione separatori/simboli comuni
    const normalize = (s: string) => s.toLowerCase().replace(/[\s_\-()]/g, '');
    const targets = searchTerms.map(normalize);

    const isMatch = (rawLabel: string): boolean => {
      const label = normalize(rawLabel);
      if (!label) return false;
      return targets.some(t => label === t || label.includes(t));
    };

    const walk = (node: unknown): { home: number | null; away: number | null } | null => {
      if (!node || typeof node !== 'object') return null;
      if (Array.isArray(node)) {
        for (const item of node) {
          const found = walk(item);
          if (found) return found;
        }
        return null;
      }

      const obj = node as Record<string, unknown>;
      const rawKey = String(obj.title ?? obj.key ?? obj.name ?? obj.localizedKey ?? obj.header ?? '');
      if (rawKey && isMatch(rawKey)) {
        const stats = obj.stats;
        if (Array.isArray(stats) && stats.length >= 2) {
          return { home: this.toNumber(stats[0]), away: this.toNumber(stats[1]) };
        }
        const values = obj.value;
        if (Array.isArray(values) && values.length >= 2) {
          return { home: this.toNumber(values[0]), away: this.toNumber(values[1]) };
        }
        if (obj.home !== undefined && obj.away !== undefined) {
          return { home: this.toNumber(obj.home), away: this.toNumber(obj.away) };
        }
      }

      for (const value of Object.values(obj)) {
        const found = walk(value);
        if (found) return found;
      }
      return null;
    };

    return walk(payload) ?? { home: null, away: null };
  }

  private parsePlayerStatsFromMatch(matchDetails: any, homeTeamId: string, awayTeamId: string): FotmobPlayerMatchStat[] {
    const byPlayer = new Map<string, FotmobPlayerMatchStat>();
    const shotMap = matchDetails?.content?.shotmap?.shots;
    if (!Array.isArray(shotMap)) return [];

    for (const shot of shotMap) {
      const playerName = String(shot?.playerName ?? shot?.player ?? '').trim();
      if (!playerName) continue;
      const rawPlayerId = this.toNumber(shot?.playerId);
      const sourcePlayerId = rawPlayerId === null ? null : Math.trunc(rawPlayerId);
      const playerId = sourcePlayerId !== null
        ? `fotmob_player_${sourcePlayerId}`
        : `fotmob_player_${playerName.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')}`;

      const teamName = String(shot?.teamName ?? '');
      const teamId = teamName
        ? this.normalizeTeamName(teamName)
        : (String(shot?.isHome) === 'true' ? homeTeamId : awayTeamId);

      const existing = byPlayer.get(playerId) ?? {
        playerId,
        sourcePlayerId,
        playerName,
        teamId,
        positionCode: 'MF',
        minutes: null,
        shots: 0,
        shotsOnTarget: 0,
        goals: 0,
        xg: 0,
        xgot: 0,
        raw: {},
      };

      existing.shots += 1;
      const isOnTarget = Boolean(shot?.isOnTarget) || String(shot?.eventType ?? '').toLowerCase().includes('on_target');
      if (isOnTarget) existing.shotsOnTarget += 1;
      const isGoal = Boolean(shot?.isGoal) || String(shot?.eventType ?? '').toLowerCase().includes('goal');
      if (isGoal) existing.goals += 1;
      existing.xg += this.toNumber(shot?.expectedGoals) ?? 0;
      existing.xgot += this.toNumber(shot?.expectedGoalsOnTarget) ?? 0;
      existing.raw = {
        ...(existing.raw ?? {}),
        lastEventType: shot?.eventType ?? null,
      };

      byPlayer.set(playerId, existing);
    }

    return Array.from(byPlayer.values());
  }

  private parseMatch(leagueName: string, season: string, summary: any, details: any | null): FotmobMatch | null {
    const sourceMatchId = this.toNumber(summary?.id ?? summary?.matchId);
    if (sourceMatchId === null) return null;
    const normalizedSourceMatchId = Math.trunc(sourceMatchId);
    if (details) {
      const detailsMatchId = this.extractDetailsMatchId(details);
      if (detailsMatchId !== null && detailsMatchId !== normalizedSourceMatchId) {
        details = null;
      }
    }
    const rawDate = summary?.utcTime ?? summary?.time?.utcTime ?? summary?.status?.utcTime;
    if (!rawDate) return null;
    const date = new Date(rawDate);
    if (Number.isNaN(date.getTime())) return null;

    const homeTeamName = String(summary?.home?.name ?? summary?.homeTeam?.name ?? '').trim();
    const awayTeamName = String(summary?.away?.name ?? summary?.awayTeam?.name ?? '').trim();
    if (!homeTeamName || !awayTeamName) return null;

    const goals = this.extractGoalsFromSummary(summary);
    const finished = this.isLikelyFinished(summary);
    const homeGoals = finished ? goals.home : null;
    const awayGoals = finished ? goals.away : null;

    const homeTeamId = this.normalizeTeamName(homeTeamName);
    const awayTeamId = this.normalizeTeamName(awayTeamName);

    let xg = details
      ? this.findStatPair(details, ['expected goals', 'expectedgoals', 'xg'])
      : { home: this.toNumber(summary?.home?.xg), away: this.toNumber(summary?.away?.xg) };
    let shots = details
      ? this.findStatPair(details, ['totalshots', 'total shots'])
      : { home: this.toNumber(summary?.home?.shots), away: this.toNumber(summary?.away?.shots) };
    let sot = details
      ? this.findStatPair(details, ['shotsontarget', 'shots on target'])
      : { home: this.toNumber(summary?.home?.shotsOnTarget), away: this.toNumber(summary?.away?.shotsOnTarget) };
    let poss = details
      ? this.findStatPair(details, ['possession', 'ball possession'])
      : { home: this.toNumber(summary?.home?.possession), away: this.toNumber(summary?.away?.possession) };
    let fouls = details
      ? this.findStatPair(details, ['fouls', 'fouls committed'])
      : { home: null, away: null };
    let yellow = details
      ? this.findStatPair(details, ['yellow cards', 'yellowcards'])
      : { home: null, away: null };
    let red = details
      ? this.findStatPair(details, ['red cards', 'redcards'])
      : { home: null, away: null };

    if (!details) {
      // Se API dettagli è bloccata, alcuni summary tornano tutti 0: non inquinare le medie.
      const metricValues = [
        xg.home, xg.away,
        shots.home, shots.away,
        sot.home, sot.away,
        poss.home, poss.away,
      ].filter(v => v !== null) as number[];
      const allZeroLike = metricValues.length > 0 && metricValues.every(v => Math.abs(v) < 1e-9);
      if (allZeroLike) {
        xg = { home: null, away: null };
        shots = { home: null, away: null };
        sot = { home: null, away: null };
        poss = { home: null, away: null };
        fouls = { home: null, away: null };
        yellow = { home: null, away: null };
        red = { home: null, away: null };
      }
    }

    const referee = details
      ? (String(
          details?.general?.referee?.text ??
          details?.general?.referee ??
          details?.header?.referee?.name ??
          ''
        ).trim() || null)
      : null;

    const playerStats = details ? this.parsePlayerStatsFromMatch(details, homeTeamId, awayTeamId) : [];
    const matchId = `fotmob_${sourceMatchId}`;

    return {
      matchId,
      sourceMatchId: normalizedSourceMatchId,
      date: date.toISOString(),
      homeTeamId,
      awayTeamId,
      homeTeamName,
      awayTeamName,
      homeGoals,
      awayGoals,
      homeXG: xg.home,
      awayXG: xg.away,
      homeTotalShots: shots.home,
      awayTotalShots: shots.away,
      homeShotsOnTarget: sot.home,
      awayShotsOnTarget: sot.away,
      homePossession: poss.home,
      awayPossession: poss.away,
      homeYellowCards: yellow.home,
      awayYellowCards: yellow.away,
      homeRedCards: red.home,
      awayRedCards: red.away,
      homeFouls: fouls.home,
      awayFouls: fouls.away,
      referee,
      competition: leagueName,
      season,
      rawJson: JSON.stringify(details ?? summary ?? {}),
      playerStats,
    };
  }

  async scrapeSeason(
    competition: string,
    season: string,
    options?: { includeDetails?: boolean }
  ): Promise<FotmobMatch[]> {
    const cfg = COMPETITIONS[competition];
    if (!cfg) throw new Error(`Competizione non supportata: ${competition}`);

    const trySeasonValues = [season];
    if (season.includes('/')) trySeasonValues.push(season.replace('/', '-'));
    if (season.includes('-')) trySeasonValues.push(season.replace('-', '/'));

    let allMatches: any[] = [];
    let lastError: Error | null = null;
    for (const seasonValue of [...new Set(trySeasonValues)]) {
      try {
        const league = await this.fetchJson<any>(`/api/leagues?id=${cfg.id}&season=${encodeURIComponent(seasonValue)}`);
        allMatches = league?.overview?.leagueOverviewMatches ?? league?.matches?.allMatches ?? [];
        if (Array.isArray(allMatches) && allMatches.length > 0) {
          break;
        }
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    if ((!Array.isArray(allMatches) || allMatches.length === 0) && lastError) {
      throw lastError;
    }

    if (!Array.isArray(allMatches)) return [];

    const results: FotmobMatch[] = [];

    const includeDetails = options?.includeDetails !== false;
    let blockedDetailsCount = 0;
    let blockedDetailsLogged = 0;

    for (const summary of allMatches) {
      const sourceMatchId = this.toNumber(summary?.id ?? summary?.matchId);
      if (sourceMatchId === null) continue;

      let details: any | null = null;
      // Per partite future/non concluse non servono dettagli avanzati:
      // evita molte richieste 403 e riduce drasticamente la durata dell'import.
      if (includeDetails && this.isLikelyFinished(summary)) {
        for (let attempt = 1; attempt <= this.DETAILS_MAX_RETRIES; attempt++) {
          try {
            details = await this.fetchJson<any>(`/api/matchDetails?matchId=${Math.trunc(sourceMatchId)}`);
            break;
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const isTooManyRequests = message.includes('returned 429');
            const canRetry = isTooManyRequests && attempt < this.DETAILS_MAX_RETRIES;

            if (this.detailsApiBlocked(message)) {
              try {
                const detailsFromPage = await this.fetchDetailsFromMatchPage(
                  Math.trunc(sourceMatchId),
                  summary?.pageUrl
                );
                if (detailsFromPage) {
                  details = detailsFromPage;
                  break;
                }
              } catch {
                // segue log fallback sotto
              }
            }

            if (canRetry) {
              console.warn(`[FotmobScraper] ${message} su match ${sourceMatchId}, retry ${attempt}/${this.DETAILS_MAX_RETRIES} tra ${this.DETAILS_RETRY_WAIT_MS / 1000}s...`);
              await this.sleep(this.DETAILS_RETRY_WAIT_MS);
              continue;
            }

            if (this.detailsApiBlocked(message)) {
              blockedDetailsCount++;
              if (blockedDetailsLogged < 8) {
                console.warn(`[FotmobScraper] Fallback su match ${sourceMatchId}: ${message}`);
                blockedDetailsLogged++;
              } else if (blockedDetailsLogged === 8) {
                console.warn('[FotmobScraper] Altri 403 su /api/matchDetails omessi nei log per evitare spam.');
                blockedDetailsLogged++;
              }
              break;
            }

            console.warn(`[FotmobScraper] Fallback su match ${sourceMatchId}: ${message}`);
            break;
          }
        }
      }

      const parsed = this.parseMatch(cfg.name, season, summary, details);
      if (parsed) {
        results.push(parsed);
      }

      await this.sleep(this.REQUEST_DELAY_MS);
    }

    if (blockedDetailsCount > 0) {
      console.warn(
        `[FotmobScraper] /api/matchDetails bloccata su ${blockedDetailsCount} match in ${cfg.name} ${season}. Statistiche avanzate non disponibili per questi match.`
      );
    }

    return results;
  }

  async scrapeMultipleSeasons(
    competition: string,
    seasons: string[],
    options?: { includeDetails?: boolean }
  ): Promise<FotmobMatch[]> {
    const out: FotmobMatch[] = [];
    for (const season of seasons) {
      const matches = await this.scrapeSeason(competition, season, options);
      out.push(...matches);
      await this.sleep(1000);
    }
    return out;
  }

  toDbFormat(match: FotmobMatch): Record<string, unknown> {
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
      homeFouls: match.homeFouls,
      awayFouls: match.awayFouls,
      homeYellowCards: match.homeYellowCards,
      awayYellowCards: match.awayYellowCards,
      homeRedCards: match.homeRedCards,
      awayRedCards: match.awayRedCards,
      referee: match.referee,
      competition: match.competition,
      season: match.season,
      source: 'fotmob',
      sourceMatchId: match.sourceMatchId,
      rawJson: match.rawJson,
    };
  }

  async close(): Promise<void> {
    if (this.page) {
      await this.page.close();
      this.page = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
  }
}
