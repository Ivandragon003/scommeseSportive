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
  homeCorners: number | null;
  awayCorners: number | null;
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

export interface FotmobTeamSeasonStats {
  competition: string;
  season: string;
  teamId: string;
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
  source: 'fotmob_season_stats';
}

interface CompetitionConfig {
  name: string;
  id: number;
}

export class FotmobScraper {
  private static readonly COMPETITIONS: Record<string, CompetitionConfig> = {
    'Serie A': { name: 'Serie A', id: 55 },
    'Premier League': { name: 'Premier League', id: 47 },
    'La Liga': { name: 'La Liga', id: 87 },
    'Bundesliga': { name: 'Bundesliga', id: 54 },
    'Ligue 1': { name: 'Ligue 1', id: 53 },
  };

  private readonly BASE_URL = 'https://www.fotmob.com';
  private readonly REQUEST_DELAY_MS = 120;
  private readonly DETAILS_MAX_RETRIES = 2;
  private readonly DETAILS_RETRY_WAIT_MS = 1500;
  private readonly DETAILS_PAGE_FALLBACK_MAX_ATTEMPTS = 6;
  private readonly DETAILS_CIRCUIT_MIN_ATTEMPTS = 12;
  private readonly DETAILS_CIRCUIT_BLOCK_RATIO = 0.65;
  private readonly FETCH_TIMEOUT_MS = 45000;
  private readonly FETCH_MAX_RETRIES = 2;
  private readonly FETCH_RETRY_WAIT_MS = 1200;
  private readonly SEASON_STATS_CACHE_TTL_MS = 10 * 60 * 1000;
  private seasonStatsCache = new Map<string, { at: number; data: Record<string, FotmobTeamSeasonStats> }>();
  private browser: Browser | null = null;
  private page: Page | null = null;

  static getSupportedCompetitions(): string[] {
    return Object.keys(FotmobScraper.COMPETITIONS);
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

  private async withRetry<T>(fn: () => Promise<T>, maxRetries = this.FETCH_MAX_RETRIES): Promise<T> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error;
        if (attempt >= maxRetries) break;
        const waitMs = this.FETCH_RETRY_WAIT_MS * (attempt + 1);
        await this.sleep(waitMs);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  private async fetchJson<T>(apiPath: string): Promise<T> {
    return this.withRetry(async () => {
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
    });
  }

  private async fetchAbsoluteJson<T>(url: string): Promise<T> {
    return this.withRetry(async () => {
      const page = await this.ensurePage();
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
        throw new Error(`FotMob API absolute ${url} returned ${fallback.status}`);
      }

      return JSON.parse(fallback.text) as T;
    });
  }

  private detailsApiBlocked(message: string): boolean {
    const msg = String(message ?? '').toLowerCase();
    const blockedStatus =
      msg.includes('returned 403') ||
      msg.includes('returned 401') ||
      msg.includes('returned 429');
    return (msg.includes('/api/matchdetails') || msg.includes('/api/data/matchdetails')) && blockedStatus;
  }

  private hasUsableSummaryStats(summary: any): boolean {
    const toNum = (v: unknown): number | null => this.toNumber(v);

    const xgHome = toNum(summary?.home?.xg);
    const xgAway = toNum(summary?.away?.xg);
    const shotsHome = toNum(summary?.home?.shots);
    const shotsAway = toNum(summary?.away?.shots);
    const sotHome = toNum(summary?.home?.shotsOnTarget);
    const sotAway = toNum(summary?.away?.shotsOnTarget);
    const possRawHome = toNum(summary?.home?.possession);
    const possRawAway = toNum(summary?.away?.possession);
    const possHome = possRawHome !== null && possRawHome >= 0 && possRawHome <= 1 ? possRawHome * 100 : possRawHome;
    const possAway = possRawAway !== null && possRawAway >= 0 && possRawAway <= 1 ? possRawAway * 100 : possRawAway;

    const core = [xgHome, xgAway, shotsHome, shotsAway, sotHome, sotAway, possHome, possAway];
    if (core.some(v => v === null || !Number.isFinite(v))) return false;
    const vals = core as number[];
    const allZeroLike = vals.every(v => Math.abs(v) < 1e-9);
    if (allZeroLike) return false;

    // Possesso deve essere plausibile.
    if (possHome === null || possAway === null) return false;
    if (possHome < 0 || possHome > 100 || possAway < 0 || possAway > 100) return false;

    return true;
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

  private cleanRenderedStatText(value: string): string {
    return String(value ?? '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;|\u00a0/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&#39;|&apos;/g, '\'')
      .replace(/&quot;/g, '"')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private extractDetailsFromRenderedHtml(html: string, matchId: number): any | null {
    const rows: Array<{ title: string; stats: [string, string] }> = [];
    const seen = new Set<string>();
    const push = (label: string, home: string, away: string) => {
      const title = this.cleanRenderedStatText(label);
      const left = this.cleanRenderedStatText(home);
      const right = this.cleanRenderedStatText(away);
      if (!title || (!left && !right)) return;
      const key = `${title}|${left}|${right}`;
      if (seen.has(key)) return;
      seen.add(key);
      rows.push({ title, stats: [left, right] });
    };

    const topStatRegex = /<li[^>]*>\s*<div[^>]*>[\s\S]*?<span[^>]*><span>([\s\S]*?)<\/span><\/span>[\s\S]*?<\/div>\s*<span[^>]*class="[^"]*title[^"]*"[^>]*>([\s\S]*?)<\/span>\s*<div[^>]*>[\s\S]*?<span[^>]*><span>([\s\S]*?)<\/span><\/span>[\s\S]*?<\/div>\s*<\/li>/gi;
    let match: RegExpExecArray | null;
    while ((match = topStatRegex.exec(html))) {
      push(match[2], match[1], match[3]);
    }

    const possessionRegex = /Ball possession<\/span><\/span><div[^>]*>[\s\S]*?<span>([^<]+)<\/span>[\s\S]*?<span>([^<]+)<\/span>/i;
    const possessionMatch = possessionRegex.exec(html);
    if (possessionMatch) {
      push('Ball possession', possessionMatch[1], possessionMatch[2]);
    }

    const tableRowRegex = /<tr[^>]*>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<td[^>]*>([\s\S]*?)<\/td>\s*<\/tr>/gi;
    while ((match = tableRowRegex.exec(html))) {
      push(match[2], match[1], match[3]);
    }

    if (rows.length === 0) return null;

    return {
      general: { matchId: String(Math.trunc(matchId)) },
      content: { stats: rows },
    };
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
        try {
          await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: this.FETCH_TIMEOUT_MS,
          });
        } catch {
          // continua e prova comunque a leggere il DOM renderizzato
        }

        try {
          await page.waitForFunction(
            "document.body.innerText.includes('Total shots') || document.body.innerText.includes('Top stats')",
            { timeout: Math.min(15000, this.FETCH_TIMEOUT_MS) }
          );
        } catch {
          // il DOM puo essere gia sufficiente anche senza il marker atteso
        }

        const html = await page.content();
        const details = this.extractDetailsFromRenderedHtml(html, matchId);
        if (details && this.extractDetailsMatchId(details) === Math.trunc(matchId)) return details;
      } catch {
        // prova successiva
      }
    }

    return null;
  }

  private findStatPairs(payload: unknown, searchTerms: string[]): Array<{ home: number | null; away: number | null }> {
    // confronto fuzzy: lowercase + rimozione separatori/simboli comuni
    const normalize = (s: string) => s.toLowerCase().replace(/[\s_\-()]/g, '');
    const targets = searchTerms.map(normalize);

    const isMatch = (rawLabel: string): boolean => {
      const label = normalize(rawLabel);
      if (!label) return false;
      return targets.some(t => label === t || label.includes(t));
    };

    const out: Array<{ home: number | null; away: number | null }> = [];

    const walk = (node: unknown): void => {
      if (!node || typeof node !== 'object') return;
      if (Array.isArray(node)) {
        for (const item of node) {
          walk(item);
        }
        return;
      }

      const obj = node as Record<string, unknown>;
      const rawKey = String(obj.title ?? obj.key ?? obj.name ?? obj.localizedKey ?? obj.header ?? '');
      if (rawKey && isMatch(rawKey)) {
        const stats = obj.stats;
        if (Array.isArray(stats) && stats.length >= 2) {
          out.push({ home: this.toNumber(stats[0]), away: this.toNumber(stats[1]) });
        }
        const values = obj.value;
        if (Array.isArray(values) && values.length >= 2) {
          out.push({ home: this.toNumber(values[0]), away: this.toNumber(values[1]) });
        }
        if (obj.home !== undefined && obj.away !== undefined) {
          out.push({ home: this.toNumber(obj.home), away: this.toNumber(obj.away) });
        }
      }

      for (const value of Object.values(obj)) {
        walk(value);
      }
    };

    walk(payload);
    return out;
  }

  private sanitizePair(
    pair: { home: number | null; away: number | null },
    domain: 'xg' | 'shots' | 'sot' | 'possession' | 'fouls' | 'yellow' | 'red' | 'corners'
  ): { home: number | null; away: number | null } {
    const fix = (raw: number | null): number | null => {
      if (raw === null || !Number.isFinite(raw)) return null;
      const v = Number(raw);
      if (domain === 'possession' && v >= 0 && v <= 1) return v * 100;
      return v;
    };

    const inRange = (v: number, min: number, max: number) => v >= min && v <= max;
    const ranges: Record<typeof domain, [number, number]> = {
      xg: [0, 8],
      shots: [0, 60],
      sot: [0, 30],
      possession: [0, 100],
      fouls: [0, 60],
      yellow: [0, 20],
      red: [0, 6],
      corners: [0, 30],
    };

    const [min, max] = ranges[domain];
    const h = fix(pair.home);
    const a = fix(pair.away);

    return {
      home: h !== null && inRange(h, min, max) ? h : null,
      away: a !== null && inRange(a, min, max) ? a : null,
    };
  }

  private extractStatPair(
    details: any,
    searchTerms: string[],
    domain: 'xg' | 'shots' | 'sot' | 'possession' | 'fouls' | 'yellow' | 'red' | 'corners'
  ): { home: number | null; away: number | null } {
    const scorePair = (pair: { home: number | null; away: number | null }): number => {
      const h = pair.home;
      const a = pair.away;
      if (h === null && a === null) return Number.NEGATIVE_INFINITY;
      // Possesso: scegli la coppia piu plausibile (somma vicina a 100).
      if (domain === 'possession') {
        if (h !== null && a !== null) return -Math.abs((h + a) - 100);
        return Number.NEGATIVE_INFINITY;
      }
      // xG/tiri/falli/cartellini: full-match tende ad avere la somma maggiore
      // rispetto a periodi parziali.
      return (h ?? 0) + (a ?? 0);
    };

    const sources: unknown[] = [
      details?.content?.stats,
      details?.stats,
      details?.content,
      details,
    ];
    for (const source of sources) {
      if (!source) continue;
      const candidates = this.findStatPairs(source, searchTerms)
        .map(raw => this.sanitizePair(raw, domain))
        .filter(pair => pair.home !== null || pair.away !== null);

      if (candidates.length === 0) continue;

      let best = candidates[0];
      let bestScore = scorePair(best);
      for (let i = 1; i < candidates.length; i++) {
        const score = scorePair(candidates[i]);
        if (score > bestScore) {
          best = candidates[i];
          bestScore = score;
        }
      }
      if (best.home !== null || best.away !== null) return best;
    }
    return { home: null, away: null };
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
    const isFutureFixture = date.getTime() > Date.now();

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
      ? this.extractStatPair(details, ['expected goals', 'expectedgoals', 'xg'], 'xg')
      : { home: this.toNumber(summary?.home?.xg), away: this.toNumber(summary?.away?.xg) };
    let shots = details
      ? this.extractStatPair(details, ['totalshots', 'total shots'], 'shots')
      : { home: this.toNumber(summary?.home?.shots), away: this.toNumber(summary?.away?.shots) };
    let sot = details
      ? this.extractStatPair(details, ['shotsontarget', 'shots on target', 'on target shots'], 'sot')
      : { home: this.toNumber(summary?.home?.shotsOnTarget), away: this.toNumber(summary?.away?.shotsOnTarget) };
    let poss = details
      ? this.extractStatPair(details, ['possession', 'ball possession'], 'possession')
      : { home: this.toNumber(summary?.home?.possession), away: this.toNumber(summary?.away?.possession) };
    let fouls = details
      ? this.extractStatPair(details, ['fouls', 'fouls committed'], 'fouls')
      : { home: null, away: null };
    let corners = details
      ? this.extractStatPair(details, ['corners', 'corner kicks'], 'corners')
      : { home: this.toNumber(summary?.home?.corners), away: this.toNumber(summary?.away?.corners) };
    let yellow = details
      ? this.extractStatPair(details, ['yellow cards', 'yellowcards', 'bookings'], 'yellow')
      : { home: null, away: null };
    let red = details
      ? this.extractStatPair(details, ['red cards', 'redcards'], 'red')
      : { home: null, away: null };

    xg = this.sanitizePair(xg, 'xg');
    shots = this.sanitizePair(shots, 'shots');
    sot = this.sanitizePair(sot, 'sot');
    poss = this.sanitizePair(poss, 'possession');
    fouls = this.sanitizePair(fouls, 'fouls');
    corners = this.sanitizePair(corners, 'corners');
    yellow = this.sanitizePair(yellow, 'yellow');
    red = this.sanitizePair(red, 'red');

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
        corners = { home: null, away: null };
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

    const playerStats = !isFutureFixture && details
      ? this.parsePlayerStatsFromMatch(details, homeTeamId, awayTeamId)
      : [];
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
      homeXG: isFutureFixture ? null : xg.home,
      awayXG: isFutureFixture ? null : xg.away,
      homeTotalShots: isFutureFixture ? null : shots.home,
      awayTotalShots: isFutureFixture ? null : shots.away,
      homeShotsOnTarget: isFutureFixture ? null : sot.home,
      awayShotsOnTarget: isFutureFixture ? null : sot.away,
      homePossession: isFutureFixture ? null : poss.home,
      awayPossession: isFutureFixture ? null : poss.away,
      homeYellowCards: isFutureFixture ? null : yellow.home,
      awayYellowCards: isFutureFixture ? null : yellow.away,
      homeRedCards: isFutureFixture ? null : red.home,
      awayRedCards: isFutureFixture ? null : red.away,
      homeFouls: isFutureFixture ? null : fouls.home,
      awayFouls: isFutureFixture ? null : fouls.away,
      homeCorners: isFutureFixture ? null : corners.home,
      awayCorners: isFutureFixture ? null : corners.away,
      referee: isFutureFixture ? null : referee,
      competition: leagueName,
      season,
      rawJson: JSON.stringify((isFutureFixture ? summary : (details ?? summary)) ?? {}),
      playerStats,
    };
  }

  async scrapeSeason(
    competition: string,
    season: string,
    options?: { includeDetails?: boolean }
  ): Promise<FotmobMatch[]> {
    const cfg = FotmobScraper.COMPETITIONS[competition];
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
    let missingDetailsCount = 0;
    let missingDetailsLogged = 0;

    for (const summary of allMatches) {
      const sourceMatchId = this.toNumber(summary?.id ?? summary?.matchId);
      if (sourceMatchId === null) continue;

      let details: any | null = null;
      // Per partite future/non concluse non servono dettagli avanzati.
      // Per quelle giocate, il path SEO del match carica ancora api/data/matchDetails.
      if (includeDetails && this.isLikelyFinished(summary) && !this.hasUsableSummaryStats(summary)) {
        let detailsError: string | null = null;
        try {
          details = await this.fetchDetailsFromMatchPage(
            Math.trunc(sourceMatchId),
            summary?.pageUrl
          );
        } catch (error) {
          detailsError = error instanceof Error ? error.message : String(error);
        }

        if (!details) {
          missingDetailsCount++;
          if (missingDetailsLogged < 8) {
            console.warn(`[FotmobScraper] Dettagli non disponibili per match ${sourceMatchId}${detailsError ? `: ${detailsError}` : ''}`);
            missingDetailsLogged++;
          } else if (missingDetailsLogged === 8) {
            console.warn('[FotmobScraper] Altri match senza dettagli omessi nei log per evitare spam.');
            missingDetailsLogged++;
          }
        }
      }

      const parsed = this.parseMatch(cfg.name, season, summary, details);
      if (parsed) {
        results.push(parsed);
      }

      await this.sleep(this.REQUEST_DELAY_MS);
    }

    if (missingDetailsCount > 0) {
      console.warn(
        `[FotmobScraper] Statistiche avanzate non disponibili per ${missingDetailsCount} match in ${cfg.name} ${season}.`
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

  private parseTableRows(payload: any): any[] {
    const candidates = [
      payload?.table?.[0]?.data?.table?.all,
      payload?.table?.[0]?.table?.all,
      payload?.overview?.table?.[0]?.data?.table?.all,
      payload?.overview?.table?.all,
    ];
    for (const c of candidates) {
      if (Array.isArray(c) && c.length > 0) return c;
    }
    return [];
  }

  private parseScores(scoresStr: unknown): { gf: number; ga: number } {
    const raw = String(scoresStr ?? '').trim();
    const m = raw.match(/(\d+)\s*[-:]\s*(\d+)/);
    if (!m) return { gf: 0, ga: 0 };
    return {
      gf: Number(m[1]) || 0,
      ga: Number(m[2]) || 0,
    };
  }

  private parseTeamStatList(statPayload: any): Array<{ teamName: string; value: number | null }> {
    const list = statPayload?.TopLists?.[0]?.StatList;
    if (!Array.isArray(list)) return [];
    return list.map((row: any) => ({
      teamName: String(row?.ParticipantName ?? '').trim(),
      value: this.toNumber(row?.StatValue),
    })).filter((row: { teamName: string; value: number | null }) => Boolean(row.teamName));
  }

  private async loadSeasonTeamStatsMap(competition: string, season: string): Promise<Record<string, FotmobTeamSeasonStats>> {
    const cacheKey = `${competition}::${season}`;
    const cached = this.seasonStatsCache.get(cacheKey);
    if (cached && Date.now() - cached.at <= this.SEASON_STATS_CACHE_TTL_MS) {
      return cached.data;
    }

    const cfg = FotmobScraper.COMPETITIONS[competition];
    if (!cfg) throw new Error(`Competizione non supportata: ${competition}`);

    const trySeasonValues = [season];
    if (season.includes('/')) trySeasonValues.push(season.replace('/', '-'));
    if (season.includes('-')) trySeasonValues.push(season.replace('-', '/'));

    let payload: any = null;
    let lastError: Error | null = null;
    for (const seasonValue of [...new Set(trySeasonValues)]) {
      try {
        payload = await this.fetchJson<any>(`/api/leagues?id=${cfg.id}&season=${encodeURIComponent(seasonValue)}`);
        if (payload) break;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
      }
    }

    if (!payload) {
      if (lastError) throw lastError;
      throw new Error(`Nessun payload leagues per ${competition} ${season}`);
    }

    const tableRows = this.parseTableRows(payload);
    const baseByTeam = new Map<string, FotmobTeamSeasonStats>();

    for (const row of tableRows) {
      const teamName = String(row?.name ?? '').trim();
      if (!teamName) continue;
      const teamId = this.normalizeTeamName(teamName);
      const played = Number(row?.played ?? 0) || 0;
      const wins = Number(row?.wins ?? 0) || 0;
      const draws = Number(row?.draws ?? 0) || 0;
      const losses = Number(row?.losses ?? 0) || 0;
      const points = Number(row?.pts ?? 0) || 0;
      const parsedScores = this.parseScores(row?.scoresStr);
      const goalDiff = Number(row?.goalConDiff ?? parsedScores.gf - parsedScores.ga) || 0;

      baseByTeam.set(teamId, {
        competition,
        season,
        teamId,
        teamName,
        played,
        wins,
        draws,
        losses,
        points,
        goalsFor: parsedScores.gf,
        goalsAgainst: parsedScores.ga,
        goalDiff,
        xgForTotal: null,
        xgAgainstTotal: null,
        xgForPerMatch: null,
        xgAgainstPerMatch: null,
        possessionAvg: null,
        foulsPerMatch: null,
        yellowTotal: null,
        redTotal: null,
        yellowPerMatch: null,
        redPerMatch: null,
        shotsOnTargetPerMatch: null,
        cleanSheetsTotal: null,
        source: 'fotmob_season_stats',
      });
    }

    const neededStats = [
      'possession_percentage_team',
      'fk_foul_lost_team',
      'total_yel_card_team',
      'total_red_card_team',
      'expected_goals_team',
      'expected_goals_conceded_team',
      'ontarget_scoring_att_team',
      'clean_sheet_team',
    ];
    const teamStatEntries = Array.isArray(payload?.stats?.teams) ? payload.stats.teams : [];

    const listsByStat = new Map<string, Array<{ teamName: string; value: number | null }>>();
    await Promise.all(neededStats.map(async (statName) => {
      const entry = teamStatEntries.find((s: any) => String(s?.name ?? '') === statName);
      const fetchAllRaw = String(entry?.fetchAllUrl ?? '').trim();
      if (!fetchAllRaw) return;
      const fetchAllUrl = fetchAllRaw.startsWith('http') ? fetchAllRaw : `${this.BASE_URL}${fetchAllRaw}`;
      try {
        const statPayload = await this.fetchAbsoluteJson<any>(fetchAllUrl);
        const list = this.parseTeamStatList(statPayload);
        if (list.length > 0) listsByStat.set(statName, list);
      } catch {
        // fallback silenzioso: il caller usera solo i campi disponibili
      }
    }));

    const applyStat = (statName: string, assign: (row: FotmobTeamSeasonStats, value: number) => void) => {
      const list = listsByStat.get(statName) ?? [];
      for (const item of list) {
        const key = this.normalizeTeamName(item.teamName);
        const row = baseByTeam.get(key);
        if (!row) continue;
        if (item.value === null || !Number.isFinite(item.value)) continue;
        assign(row, item.value);
      }
    };

    applyStat('possession_percentage_team', (row, value) => { row.possessionAvg = value; });
    applyStat('fk_foul_lost_team', (row, value) => { row.foulsPerMatch = value; });
    applyStat('total_yel_card_team', (row, value) => { row.yellowTotal = value; });
    applyStat('total_red_card_team', (row, value) => { row.redTotal = value; });
    applyStat('expected_goals_team', (row, value) => { row.xgForTotal = value; });
    applyStat('expected_goals_conceded_team', (row, value) => { row.xgAgainstTotal = value; });
    applyStat('ontarget_scoring_att_team', (row, value) => { row.shotsOnTargetPerMatch = value; });
    applyStat('clean_sheet_team', (row, value) => { row.cleanSheetsTotal = value; });

    const out: Record<string, FotmobTeamSeasonStats> = {};
    for (const [key, row] of baseByTeam.entries()) {
      const playedSafe = Math.max(1, row.played || 0);
      row.xgForPerMatch = row.xgForTotal === null ? null : row.xgForTotal / playedSafe;
      row.xgAgainstPerMatch = row.xgAgainstTotal === null ? null : row.xgAgainstTotal / playedSafe;
      row.yellowPerMatch = row.yellowTotal === null ? null : row.yellowTotal / playedSafe;
      row.redPerMatch = row.redTotal === null ? null : row.redTotal / playedSafe;
      out[key] = row;
    }

    this.seasonStatsCache.set(cacheKey, { at: Date.now(), data: out });
    return out;
  }

  async getTeamSeasonStats(competition: string, season: string, teamIdOrName: string): Promise<FotmobTeamSeasonStats | null> {
    const normalizedTeam = this.normalizeTeamName(teamIdOrName);
    if (!normalizedTeam) return null;
    const map = await this.loadSeasonTeamStatsMap(competition, season);
    return map[normalizedTeam] ?? null;
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
      homeTotalShots: null, // Removed to avoid duplication with Transfermarkt
      awayTotalShots: null, // Removed to avoid duplication with Transfermarkt
      homeShotsOnTarget: null, // Removed to avoid duplication with Transfermarkt
      awayShotsOnTarget: null, // Removed to avoid duplication with Transfermarkt
      homePossession: match.homePossession,
      awayPossession: match.awayPossession,
      homeFouls: match.homeFouls,
      awayFouls: match.awayFouls,
      homeYellowCards: match.homeYellowCards,
      awayYellowCards: match.awayYellowCards,
      homeRedCards: match.homeRedCards,
      awayRedCards: match.awayRedCards,
      homeCorners: match.homeCorners,
      awayCorners: match.awayCorners,
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
