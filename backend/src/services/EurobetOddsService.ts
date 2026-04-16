import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Browser, BrowserContext, Page } from 'playwright';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { BookmakerOdds, MarketOdds, OddsMatch, OutcomeOdds } from './OddsApiService';

chromium.use(StealthPlugin());

type EurobetTreeNode = {
  description?: string;
  aliasUrl?: string;
  type?: string;
  itemList?: EurobetTreeNode[];
};

type EurobetEventInfo = {
  eventDescription?: string;
  aliasUrl?: string;
  eventData?: number;
  teamHome?: { description?: string };
  teamAway?: { description?: string };
};

type EurobetOdd = {
  oddValue?: number;
  boxTitle?: string;
  oddDescription?: string;
  additionalInfo?: number[];
};

type EurobetOddGroup = {
  oddGroupDescription?: string;
  alternativeDescription?: string;
  oddList?: EurobetOdd[];
};

type EurobetBetGroup = {
  betDescription?: string;
  oddGroupList?: EurobetOddGroup[];
};

type EurobetMeetingItem = {
  eventInfo?: EurobetEventInfo;
  betGroupList?: EurobetBetGroup[];
};

type EurobetMeetingResponse = {
  result?: {
    groupData?: { groupList?: Array<{ aliasUrl?: string }> };
    dataGroupList?: Array<{ itemList?: EurobetMeetingItem[] }>;
  };
};

type EurobetEventResponse = {
  result?: {
    eventInfo?: EurobetEventInfo;
    betGroupList?: EurobetBetGroup[];
    groupData?: { groupList?: Array<{ aliasUrl?: string }> };
  };
};

export interface EurobetOddsMatch extends OddsMatch {
  meetingAlias: string;
  eventAlias: string;
  availableGroupAliases: string[];
  loadedGroupAliases: string[];
  unavailableGroupAliases: string[];
}

type GetOddsOptions = {
  includeExtendedGroups?: boolean;
};

type FixtureCandidate = {
  homeTeam: string;
  awayTeam: string;
  commenceTime?: string | null;
};

export type EurobetSmokeSourceUsed = 'meeting-json' | 'dom-fallback' | 'event-detail';

export type EurobetSmokeErrorCategory =
  | 'resolve_meeting_alias_failed'
  | 'meeting_json_failed'
  | 'non_json_response'
  | 'html_or_captcha'
  | 'cookie_or_spa_dom_issue'
  | 'parsing_zero_markets'
  | 'fixture_matching_failed'
  | 'extended_groups_failed';

export type EurobetSmokeIssue = {
  category: EurobetSmokeErrorCategory;
  message: string;
  recoverable: boolean;
  context?: Record<string, unknown>;
};

export type EurobetSmokeOptions = {
  fixtures?: FixtureCandidate[];
  includeExtendedGroups?: boolean;
};

export type EurobetSmokeReport = {
  competition: string;
  meetingAlias: string | null;
  sourceUsed: EurobetSmokeSourceUsed | null;
  matchesFound: number;
  matchesWithBaseOdds: number;
  matchesWithExtendedGroups: number;
  durationMs: number;
  errorCategory: EurobetSmokeErrorCategory | null;
  warnings: string[];
  success: boolean;
  severity: 'healthy' | 'degraded' | 'failed';
  fixtureCount: number;
  includeExtendedGroups: boolean;
  issues: EurobetSmokeIssue[];
};

type EurobetSmokeTracker = {
  meetingAlias: string | null;
  sourceUsed: EurobetSmokeSourceUsed | null;
  issues: EurobetSmokeIssue[];
};

export class EurobetOddsService {
  private static readonly BASE_URL = 'https://www.eurobet.it';
  private static readonly USER_AGENT =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36';
  private static readonly COMPETITION_SCROLL_ATTEMPTS = 10;
  private static readonly NAVIGATION_RETRIES = 3;
  private static readonly DEFAULT_EVENT_CONCURRENCY = 2;
  private static readonly DEFAULT_PROFILE_EVENT_CONCURRENCY = 1;
  private static readonly PERSISTENT_BOOT_TIMEOUT_MS = 120_000;
  private static persistentContextPromise: Promise<BrowserContext> | null = null;
  private static persistentWarmupPromise: Promise<void> | null = null;
  private static processHooksRegistered = false;

  private static readonly SUPPORTED_COMPETITIONS = [
    'Serie A',
    'Premier League',
    'La Liga',
    'Bundesliga',
    'Ligue 1',
    'Champions League',
  ];

  private static readonly FALLBACK_MEETING_ALIASES: Record<string, string> = {
    'Serie A': 'it-serie-a',
    'Premier League': 'ing-premier-league',
    'La Liga': 'spagna-liga',
    'Bundesliga': 'germania-bundesliga',
    'Ligue 1': 'francia-ligue-1',
    'Champions League': 'eu-champions-league',
  };

  private static readonly EXTENDED_GROUP_ALIASES = ['statistiche-partita', 'speciali-partita'];
  private static readonly TEAM_SLUG_OVERRIDES: Record<string, string[]> = {
    'ac milan': ['milan'],
    'internazionale': ['inter'],
    'inter milan': ['inter'],
    'paris saint germain': ['psg', 'paris-saint-germain'],
    'paris sg': ['psg', 'paris-saint-germain'],
    'manchester united': ['manchester-united', 'man-utd'],
    'manchester city': ['manchester-city', 'man-city'],
    'tottenham hotspur': ['tottenham', 'tottenham-hotspur'],
    'borussia monchengladbach': ['borussia-monchengladbach', 'gladbach'],
    'bayern munchen': ['bayern-monaco', 'bayern-munchen'],
    '1 fc koln': ['colonia', 'fc-koln'],
  };
  private static readonly X_EB_HEADERS = {
    accept: 'application/json, text/plain, */*',
    'x-eb-marketid': '5',
    'x-eb-platformid': '1',
    'x-eb-accept-language': 'it_IT',
  };

  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private ownsBrowser = false;
  private ownsContext = false;
  private competitionAliasCache = new Map<string, string>();
  private smokeTracker: EurobetSmokeTracker | null = null;

  static getSupportedCompetitions(): string[] {
    return [...EurobetOddsService.SUPPORTED_COMPETITIONS];
  }

  async close(): Promise<void> {
    if (this.context && this.ownsContext) {
      await this.context.close().catch(() => undefined);
      this.context = null;
    }
    if (this.browser && this.ownsBrowser) {
      await this.browser.close().catch(() => undefined);
      this.browser = null;
    }
    this.ownsBrowser = false;
    this.ownsContext = false;
  }

  async getOdds(competition: string, options: GetOddsOptions = {}): Promise<EurobetOddsMatch[]> {
    const meetingAlias = await this.resolveMeetingAlias(competition);
    let baseMatches = await this.loadCompetitionMatchesFromMeetingJson(competition, meetingAlias);

    if (baseMatches.length === 0) {
      this.logEurobet('warn', 'Meeting JSON non ha prodotto match validi, attivo fallback DOM/network', {
        competition,
        meetingAlias,
      });
      baseMatches = await this.loadCompetitionMatchesFromDomFallback(competition, meetingAlias);
    }

    if (baseMatches.length === 0) {
      throw new Error(`Eurobet non ha restituito quote valide per ${competition}`);
    }

    if (!options.includeExtendedGroups) return baseMatches;

    const enriched = await this.mapWithConcurrency(
      baseMatches,
      this.getEventConcurrency(),
      async (match) => this.enrichMatchWithExtendedGroups(match)
    );
    return enriched;
  }

  async getOddsForFixtures(
    competition: string,
    fixtures: FixtureCandidate[],
    options: GetOddsOptions = {}
  ): Promise<EurobetOddsMatch[]> {
    if (fixtures.length === 0) return [];

    const meetingAlias = await this.resolveMeetingAlias(competition);
    const meetingMatches = await this.loadCompetitionMatchesFromMeetingJson(competition, meetingAlias);
    const { matchedMatches, missingFixtures } = this.matchFixturesToCompetitionMatches(fixtures, meetingMatches);

    if (missingFixtures.length > 0) {
      this.recordSmokeIssue('fixture_matching_failed', 'Alcune fixture non sono presenti nel meeting JSON', true, {
        competition,
        meetingAlias,
        requested: fixtures.length,
        missing: missingFixtures.length,
      });
      this.logEurobet('warn', 'Alcune fixture non sono state trovate nel meeting JSON, attivo fallback per alias evento', {
        competition,
        meetingAlias,
        matched: matchedMatches.length,
        missing: missingFixtures.length,
        requested: fixtures.length,
      });
    }

    const fallbackMatches = await this.mapWithConcurrency(
      missingFixtures,
      this.getEventConcurrency(),
      async (fixture) => this.fetchFixtureOdds(competition, meetingAlias, fixture)
    );

    const mergedMatches = this.dedupeMatchesById([
      ...matchedMatches,
      ...fallbackMatches.filter((match): match is EurobetOddsMatch => Boolean(match)),
    ]);

    if (fixtures.length > 0 && mergedMatches.length === 0) {
      this.recordSmokeIssue('fixture_matching_failed', 'Nessuna fixture richiesta ha prodotto un match Eurobet valido', false, {
        competition,
        meetingAlias,
        requested: fixtures.length,
      });
    }

    if (!options.includeExtendedGroups) return mergedMatches;

    return this.mapWithConcurrency(
      mergedMatches,
      this.getEventConcurrency(),
      async (match) => this.enrichMatchWithExtendedGroups(match)
    );
  }

  async runSmokeReport(
    competition: string,
    options: EurobetSmokeOptions = {}
  ): Promise<EurobetSmokeReport> {
    const startedAt = Date.now();
    const fixtures = options.fixtures ?? [];
    const includeExtendedGroups = Boolean(options.includeExtendedGroups);
    this.startSmokeTracker();

    try {
      const matches = fixtures.length > 0
        ? await this.getOddsForFixtures(competition, fixtures, { includeExtendedGroups })
        : await this.getOdds(competition, { includeExtendedGroups });
      return this.buildSmokeReport(competition, matches, startedAt, fixtures.length, includeExtendedGroups);
    } catch (error) {
      const category = this.classifyErrorFromMessage(this.describeEurobetError(error));
      if (category) {
        this.recordSmokeIssue(category, this.describeEurobetError(error), false);
      }
      return this.buildSmokeReport(competition, [], startedAt, fixtures.length, includeExtendedGroups);
    } finally {
      await this.close().catch(() => undefined);
      this.smokeTracker = null;
    }
  }

  private async loadCompetitionMatchesFromMeetingJson(
    competition: string,
    meetingAlias: string
  ): Promise<EurobetOddsMatch[]> {
    this.setSmokeMeetingAlias(meetingAlias);
    let meetingDetail: EurobetMeetingResponse;
    try {
      meetingDetail = await this.fetchMeetingDetail(meetingAlias, { competition, meetingAlias });
    } catch (error) {
      this.recordSmokeIssue('meeting_json_failed', 'Meeting JSON non disponibile', true, {
        competition,
        meetingAlias,
      });
      this.recordDerivedSmokeIssue(error, true, { competition, meetingAlias });
      this.logEurobet('warn', 'Fetch meeting JSON fallito', { competition, meetingAlias }, error);
      return [];
    }

    const availableGroupAliases = this.extractGroupAliases(meetingDetail?.result?.groupData?.groupList);
    const meetingItems = this.extractMeetingItems(meetingDetail);

    if (meetingItems.length === 0) {
      this.recordSmokeIssue('meeting_json_failed', 'Meeting JSON vuoto o senza eventi', true, {
        competition,
        meetingAlias,
      });
      this.logEurobet('warn', 'Meeting JSON vuoto o senza eventi', { competition, meetingAlias });
      return [];
    }

    const matches = meetingItems
      .map((item) => this.tryBuildMatchFromMeetingItem(competition, meetingAlias, item, availableGroupAliases))
      .filter((match): match is EurobetOddsMatch => Boolean(match));

    if (matches.length === 0) {
      this.recordSmokeIssue('parsing_zero_markets', 'Meeting JSON presente ma nessun mercato base valido', true, {
        competition,
        meetingAlias,
      });
      this.logEurobet('warn', 'Meeting JSON presente ma parsing quote base vuoto', {
        competition,
        meetingAlias,
        events: meetingItems.length,
      });
    } else {
      this.markSmokeSource('meeting-json');
    }

    return matches;
  }

  private async loadCompetitionMatchesFromDomFallback(
    competition: string,
    meetingAlias: string
  ): Promise<EurobetOddsMatch[]> {
    let metadata: { eventAliases: string[]; groupAliases: string[] };
    try {
      metadata = await this.withPage(async (page) => this.collectMeetingPageMetadata(page, meetingAlias));
    } catch (error) {
      this.recordSmokeIssue('cookie_or_spa_dom_issue', 'Fallback DOM non disponibile', true, {
        competition,
        meetingAlias,
      });
      this.recordDerivedSmokeIssue(error, true, { competition, meetingAlias });
      this.logEurobet('warn', 'Fallback DOM non disponibile', { competition, meetingAlias }, error);
      return [];
    }

    if (metadata.eventAliases.length === 0) {
      this.recordSmokeIssue('cookie_or_spa_dom_issue', 'Fallback DOM senza anchor evento utili', true, {
        competition,
        meetingAlias,
      });
      this.logEurobet('warn', 'Fallback DOM senza anchor evento', {
        competition,
        meetingAlias,
        reason: 'cookie-banner, lazy loading SPA o DOM cambiato',
      });
      return [];
    }

    const rawMatches = await this.mapWithConcurrency(
      metadata.eventAliases,
      this.getEventConcurrency(),
      async (eventAlias) => {
        try {
          const eventDetail = await this.fetchEventDetail(meetingAlias, eventAlias, {
            competition,
            meetingAlias,
            eventAlias,
          });
          return this.tryBuildMatchFromEventResponse(
            competition,
            meetingAlias,
            eventAlias,
            eventDetail,
            this.mergeAliases(metadata.groupAliases, this.extractGroupAliases(eventDetail?.result?.groupData?.groupList))
          );
        } catch (error) {
          this.recordDerivedSmokeIssue(error, true, {
            competition,
            meetingAlias,
            eventAlias,
          });
          this.logEurobet('warn', 'Fallback event detail fallito', {
            competition,
            meetingAlias,
            eventAlias,
          }, error);
          return null;
        }
      }
    );

    const matches = rawMatches.filter((match): match is EurobetOddsMatch => Boolean(match));
    if (matches.length === 0) {
      this.recordSmokeIssue('parsing_zero_markets', 'Fallback DOM ha trovato eventi ma nessun mercato valido', true, {
        competition,
        meetingAlias,
      });
      this.logEurobet('warn', 'Fallback DOM ha trovato eventi ma nessuna quota valida', {
        competition,
        meetingAlias,
        events: metadata.eventAliases.length,
      });
    } else {
      this.markSmokeSource('dom-fallback');
    }

    return matches;
  }

  private extractMeetingItems(meetingDetail: EurobetMeetingResponse): EurobetMeetingItem[] {
    return (meetingDetail?.result?.dataGroupList ?? []).flatMap((group) =>
      Array.isArray(group?.itemList) ? group.itemList : []
    );
  }

  private tryBuildMatchFromMeetingItem(
    competition: string,
    meetingAlias: string,
    item: EurobetMeetingItem,
    availableGroupAliases: string[]
  ): EurobetOddsMatch | null {
    const eventAlias = String(item?.eventInfo?.aliasUrl ?? '').trim();
    const match = this.buildMatchFromMeetingItem(meetingAlias, item, availableGroupAliases);
    return this.validateBaseMatch(match, {
      competition,
      meetingAlias,
      eventAlias,
      source: 'meeting-json',
    });
  }

  private tryBuildMatchFromEventResponse(
    competition: string,
    meetingAlias: string,
    eventAlias: string,
    response: EurobetEventResponse,
    availableGroupAliases: string[]
  ): EurobetOddsMatch | null {
    const match = this.buildMatchFromEventResponse(meetingAlias, eventAlias, response, availableGroupAliases);
    return this.validateBaseMatch(match, {
      competition,
      meetingAlias,
      eventAlias,
      source: 'event-detail',
    });
  }

  private validateBaseMatch(
    match: EurobetOddsMatch,
    context: Record<string, unknown>
  ): EurobetOddsMatch | null {
    if (!match.eventAlias || !match.homeTeam || !match.awayTeam) {
      this.recordSmokeIssue('parsing_zero_markets', 'Payload match incompleto', true, context);
      this.logEurobet('warn', 'Match Eurobet incompleto nel payload', context);
      return null;
    }

    if (!this.hasQuoteMarkets(match)) {
      this.recordSmokeIssue('parsing_zero_markets', 'Parsing quote vuoto per il match', true, context);
      this.logEurobet('warn', 'Parsing quote vuoto per il match', context);
      return null;
    }

    return match;
  }

  private startSmokeTracker(): void {
    this.smokeTracker = {
      meetingAlias: null,
      sourceUsed: null,
      issues: [],
    };
  }

  private setSmokeMeetingAlias(meetingAlias: string): void {
    if (!this.smokeTracker) return;
    this.smokeTracker.meetingAlias = meetingAlias;
  }

  private markSmokeSource(source: EurobetSmokeSourceUsed): void {
    if (!this.smokeTracker) return;

    const priority: Record<EurobetSmokeSourceUsed, number> = {
      'meeting-json': 1,
      'dom-fallback': 2,
      'event-detail': 3,
    };

    if (!this.smokeTracker.sourceUsed || priority[source] >= priority[this.smokeTracker.sourceUsed]) {
      this.smokeTracker.sourceUsed = source;
    }
  }

  private recordSmokeIssue(
    category: EurobetSmokeErrorCategory,
    message: string,
    recoverable: boolean,
    context: Record<string, unknown> = {}
  ): void {
    if (!this.smokeTracker) return;
    const filteredContext = Object.fromEntries(
      Object.entries(context).filter(([, value]) => value !== undefined && value !== null && value !== '')
    );

    this.smokeTracker.issues.push({
      category,
      message,
      recoverable,
      context: Object.keys(filteredContext).length > 0 ? filteredContext : undefined,
    });
  }

  private buildSmokeReport(
    competition: string,
    matches: EurobetOddsMatch[],
    startedAt: number,
    fixtureCount: number,
    includeExtendedGroups: boolean
  ): EurobetSmokeReport {
    const tracker = this.smokeTracker ?? { meetingAlias: null, sourceUsed: null, issues: [] };
    const issues = this.dedupeSmokeIssues(tracker.issues);
    const fatalIssues = issues.filter((issue) => !issue.recoverable);
    const warnings = issues
      .filter((issue) => issue.recoverable)
      .map((issue) => `${issue.category}: ${issue.message}`);

    const baseOddsCount = matches.filter((match) => this.hasQuoteMarkets(match)).length;
    const extendedGroupsCount = matches.filter((match) =>
      match.loadedGroupAliases.some((alias) => alias !== 'base')
    ).length;

    const errorCategory = fatalIssues.length > 0
      ? fatalIssues[0].category
      : matches.length === 0
        ? this.deriveFatalCategoryFromIssues(issues, fixtureCount)
        : null;

    const success = errorCategory === null && matches.length > 0;
    const severity: EurobetSmokeReport['severity'] = errorCategory
      ? 'failed'
      : warnings.length > 0
        ? 'degraded'
        : 'healthy';

    return {
      competition,
      meetingAlias: tracker.meetingAlias,
      sourceUsed: tracker.sourceUsed,
      matchesFound: matches.length,
      matchesWithBaseOdds: baseOddsCount,
      matchesWithExtendedGroups: extendedGroupsCount,
      durationMs: Date.now() - startedAt,
      errorCategory,
      warnings,
      success,
      severity,
      fixtureCount,
      includeExtendedGroups,
      issues,
    };
  }

  private dedupeSmokeIssues(issues: EurobetSmokeIssue[]): EurobetSmokeIssue[] {
    const seen = new Set<string>();
    return issues.filter((issue) => {
      const key = `${issue.category}|${issue.message}|${JSON.stringify(issue.context ?? {})}|${issue.recoverable}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  private deriveFatalCategoryFromIssues(
    issues: EurobetSmokeIssue[],
    fixtureCount: number
  ): EurobetSmokeErrorCategory | null {
    const priority: EurobetSmokeErrorCategory[] = [
      'resolve_meeting_alias_failed',
      'html_or_captcha',
      'non_json_response',
      'meeting_json_failed',
      'cookie_or_spa_dom_issue',
      'parsing_zero_markets',
      'fixture_matching_failed',
      'extended_groups_failed',
    ];

    for (const category of priority) {
      if (issues.some((issue) => issue.category === category)) return category;
    }

    return fixtureCount > 0 ? 'fixture_matching_failed' : null;
  }

  private hasQuoteMarkets(match: EurobetOddsMatch): boolean {
    return match.bookmakers.some((bookmaker) =>
      (bookmaker.markets ?? []).some((market) => (market.outcomes ?? []).length > 0)
    );
  }

  private matchFixturesToCompetitionMatches(
    fixtures: FixtureCandidate[],
    matches: EurobetOddsMatch[]
  ): { matchedMatches: EurobetOddsMatch[]; missingFixtures: FixtureCandidate[] } {
    const available = [...matches];
    const matchedMatches: EurobetOddsMatch[] = [];
    const missingFixtures: FixtureCandidate[] = [];

    for (const fixture of fixtures) {
      const bestIndex = this.findBestFixtureMatchIndex(fixture, available);
      if (bestIndex === -1) {
        missingFixtures.push(fixture);
        continue;
      }

      matchedMatches.push(available[bestIndex]);
      available.splice(bestIndex, 1);
    }

    return { matchedMatches, missingFixtures };
  }

  private findBestFixtureMatchIndex(fixture: FixtureCandidate, matches: EurobetOddsMatch[]): number {
    let bestIndex = -1;
    let bestScore = -1;

    matches.forEach((match, index) => {
      const score = this.scoreFixtureMatch(fixture, match);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });

    return bestIndex;
  }

  private scoreFixtureMatch(fixture: FixtureCandidate, match: EurobetOddsMatch): number {
    const homeScore = this.scoreTeamNameMatch(fixture.homeTeam, match.homeTeam);
    const awayScore = this.scoreTeamNameMatch(fixture.awayTeam, match.awayTeam);
    if (homeScore < 0.55 || awayScore < 0.55) return -1;

    const timeDistanceMinutes = this.getTimeDistanceMinutes(fixture.commenceTime, match.commenceTime);
    const nameScore = Math.round(((homeScore + awayScore) / 2) * 1000);
    if (timeDistanceMinutes === null) return nameScore;
    if (timeDistanceMinutes > 180) return -1;

    return nameScore + Math.max(0, 240 - timeDistanceMinutes);
  }

  private getTimeDistanceMinutes(left?: string | null, right?: string | null): number | null {
    const leftTime = left ? new Date(left).getTime() : Number.NaN;
    const rightTime = right ? new Date(right).getTime() : Number.NaN;
    if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return null;
    return Math.round(Math.abs(leftTime - rightTime) / 60_000);
  }

  private teamNamesMatch(left: string, right: string): boolean {
    return this.scoreTeamNameMatch(left, right) >= 0.55;
  }

  private buildTeamIdentityCandidates(teamName: string): Set<string> {
    const compact = this.normalizeWords(teamName).replace(/\s+/g, '');
    const slugCandidates = this.buildTeamSlugCandidates(teamName)
      .map((value) => value.replace(/[^a-z0-9]+/g, ''));

    return new Set([compact, ...slugCandidates].filter(Boolean));
  }

  private scoreTeamNameMatch(left: string, right: string): number {
    const leftCandidates = this.buildTeamIdentityCandidates(left);
    const rightCandidates = this.buildTeamIdentityCandidates(right);

    for (const candidate of leftCandidates) {
      if (rightCandidates.has(candidate)) return 1;
    }

    const leftNorm = this.normalizeWords(left);
    const rightNorm = this.normalizeWords(right);
    if (!leftNorm || !rightNorm) return 0;
    if (leftNorm === rightNorm) return 1;

    const leftTokens = new Set(leftNorm.split(' ').filter(Boolean));
    const rightTokens = new Set(rightNorm.split(' ').filter(Boolean));
    const intersection = Array.from(leftTokens).filter((token) => rightTokens.has(token)).length;
    const union = new Set([...leftTokens, ...rightTokens]).size;
    const jaccard = union > 0 ? intersection / union : 0;

    const leftCompact = leftNorm.replace(/\s+/g, '');
    const rightCompact = rightNorm.replace(/\s+/g, '');
    const containment = leftCompact.includes(rightCompact) || rightCompact.includes(leftCompact) ? 0.8 : 0;

    return Math.max(jaccard, containment);
  }

  private dedupeMatchesById(matches: EurobetOddsMatch[]): EurobetOddsMatch[] {
    const seen = new Set<string>();
    return matches.filter((match) => {
      if (seen.has(match.matchId)) return false;
      seen.add(match.matchId);
      return true;
    });
  }

  async enrichMatchWithExtendedGroups(match: EurobetOddsMatch): Promise<EurobetOddsMatch> {
    const loaded = new Set(match.loadedGroupAliases);
    const unavailable = new Set(match.unavailableGroupAliases);
    let bookmakers = [...match.bookmakers];

    for (const alias of EurobetOddsService.EXTENDED_GROUP_ALIASES) {
      if (loaded.has(alias) || unavailable.has(alias)) continue;
      try {
        const groupDetail = await this.fetchEventGroupDetail(match.meetingAlias, match.eventAlias, alias);
        const extraMarkets = this.parseBetGroupMarkets(
          match.homeTeam,
          match.awayTeam,
          groupDetail?.result?.betGroupList ?? []
        );
        if (extraMarkets.length === 0) {
          this.recordSmokeIssue('extended_groups_failed', `Gruppo esteso ${alias} vuoto`, true, {
            meetingAlias: match.meetingAlias,
            eventAlias: match.eventAlias,
            groupAlias: alias,
          });
          unavailable.add(alias);
          continue;
        }
        bookmakers = this.mergeMarkets(bookmakers, extraMarkets);
        loaded.add(alias);
      } catch (error) {
        this.recordSmokeIssue('extended_groups_failed', `Fetch gruppo esteso ${alias} fallito`, true, {
          meetingAlias: match.meetingAlias,
          eventAlias: match.eventAlias,
          groupAlias: alias,
        });
        this.recordDerivedSmokeIssue(error, true, {
          meetingAlias: match.meetingAlias,
          eventAlias: match.eventAlias,
          groupAlias: alias,
        });
        this.logEurobet('warn', 'Fetch gruppo esteso fallito', {
          meetingAlias: match.meetingAlias,
          eventAlias: match.eventAlias,
          groupAlias: alias,
        }, error);
        unavailable.add(alias);
      }
    }

    return {
      ...match,
      bookmakers,
      loadedGroupAliases: Array.from(loaded),
      unavailableGroupAliases: Array.from(unavailable),
    };
  }

  extractBestOdds(match: OddsMatch, preferredBookmaker = 'eurobet'): Record<string, number> {
    const odds: Record<string, number> = {};
    const primary = match.bookmakers.find((bookmaker) => bookmaker.bookmakerKey === preferredBookmaker)
      ?? match.bookmakers[0];

    if (!primary) return odds;

    const bookmakerOdds = this.extractBookmakerOdds(match, primary);
    for (const [key, price] of Object.entries(bookmakerOdds)) {
      odds[key] = price;
    }

    return odds;
  }

  compareBookmakers(match: OddsMatch): Record<string, Record<string, number>> {
    const comparison: Record<string, Record<string, number>> = {};
    for (const bookmaker of match.bookmakers) {
      const bookmakerOdds = this.extractBookmakerOdds(match, bookmaker);
      if (Object.keys(bookmakerOdds).length > 0) {
        comparison[bookmaker.bookmakerName] = bookmakerOdds;
      }
    }
    return comparison;
  }

  calculateMargin(match: OddsMatch, bookmakerKey: string): number | null {
    const bookmaker = match.bookmakers.find((entry) => entry.bookmakerKey === bookmakerKey);
    if (!bookmaker) return null;

    const h2h = bookmaker.markets.find((market) => market.marketKey === 'h2h');
    if (!h2h || h2h.outcomes.length < 2) return null;

    const impliedProbSum = h2h.outcomes.reduce((sum, outcome) => sum + (1 / outcome.price), 0);
    return Number((((impliedProbSum - 1) * 100)).toFixed(2));
  }

  private async ensureContext(): Promise<BrowserContext> {
    if (this.isPersistentProfileEnabled()) {
      let lastError: unknown = null;

      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          if (!EurobetOddsService.persistentContextPromise) {
            EurobetOddsService.persistentContextPromise = this.createPersistentContext().catch((error) => {
              this.resetPersistentContextState();
              throw error;
            });
          }

          this.context = await this.awaitWithTimeout(
            EurobetOddsService.persistentContextPromise,
            EurobetOddsService.PERSISTENT_BOOT_TIMEOUT_MS,
            'inizializzazione context persistente'
          );
          this.ownsContext = false;
          this.ownsBrowser = false;

          if (!EurobetOddsService.persistentWarmupPromise) {
            EurobetOddsService.persistentWarmupPromise = this.warmPersistentContext(this.context).catch((error) => {
              this.resetPersistentContextState();
              throw error;
            });
          }
          await this.awaitWithTimeout(
            EurobetOddsService.persistentWarmupPromise,
            EurobetOddsService.PERSISTENT_BOOT_TIMEOUT_MS,
            'warmup context persistente'
          );

          return this.context;
        } catch (error) {
          lastError = error;
          this.resetPersistentContextState();
          if (attempt < 2) {
            console.warn('[Eurobet] Context persistente non disponibile, nuovo tentativo in corso...');
          }
        }
      }

      throw lastError instanceof Error
        ? lastError
        : new Error('Impossibile inizializzare il context persistente Eurobet');
    }

    if (!this.browser) {
      this.browser = await this.launchBrowser();
      this.ownsBrowser = true;
    }

    if (!this.context) {
      this.context = await this.createContext(this.browser);
      this.ownsContext = true;
    }

    return this.context;
  }

  private resetPersistentContextState(): void {
    const stalePromise = EurobetOddsService.persistentContextPromise;
    EurobetOddsService.persistentWarmupPromise = null;
    EurobetOddsService.persistentContextPromise = null;
    if (stalePromise) {
      void stalePromise
        .then((context) => context.close().catch(() => undefined))
        .catch(() => undefined);
    }
  }

  private async awaitWithTimeout<T>(
    promise: Promise<T>,
    timeoutMs: number,
    operation: string
  ): Promise<T> {
    return await new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`[Eurobet] Timeout durante ${operation}`));
      }, timeoutMs);

      promise
        .then((value) => {
          clearTimeout(timer);
          resolve(value);
        })
        .catch((error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  private async withPage<T>(task: (page: Page) => Promise<T>): Promise<T> {
    const context = await this.ensureContext();
    const page = await context.newPage();
    try {
      await this.tryDismissCookieBanner(page, { scope: 'withPage' });
      return await task(page);
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  private async withIsolatedPage<T>(task: (page: Page) => Promise<T>): Promise<T> {
    const browser = await this.launchBrowser();
    const context = await this.createContext(browser);
    const page = await context.newPage();
    try {
      await this.tryDismissCookieBanner(page, { scope: 'withIsolatedPage' });
      return await task(page);
    } finally {
      await page.close().catch(() => undefined);
      await context.close().catch(() => undefined);
      await browser.close().catch(() => undefined);
    }
  }

  private async launchBrowser(): Promise<Browser> {
    const options = this.buildLaunchOptions();
    try {
      return await chromium.launch(options);
    } catch {
      if (options.executablePath || options.channel) {
        throw new Error('Eurobet browser launch fallito con la configurazione esplicita richiesta.');
      }

      return chromium.launch({
        ...options,
        channel: 'chrome',
      });
    }
  }

  private async createPersistentContext(): Promise<BrowserContext> {
    const profileDir = this.getPersistentProfileDir();
    await fs.mkdir(profileDir, { recursive: true });
    const options = this.buildPersistentContextOptions();
    let context: BrowserContext;
    try {
      context = await chromium.launchPersistentContext(profileDir, options);
    } catch {
      if (options.executablePath || options.channel) {
        throw new Error('Eurobet persistent browser fallito con la configurazione esplicita richiesta.');
      }

      context = await chromium.launchPersistentContext(profileDir, {
        ...options,
        channel: 'chrome',
      });
    }

    await this.applyContextStealth(context);
    this.registerPersistentCleanupHooks();
    console.info(
      `[Eurobet] Persistent profile ready | headless=${this.isHeadlessBrowser()} | channel=${this.getBrowserChannel() ?? 'default'} | profile=${profileDir}`
    );
    return context;
  }

  private async createContext(browser: Browser): Promise<BrowserContext> {
    const context = await browser.newContext(this.buildContextOptions());

    await this.applyContextStealth(context);
    return context;
  }

  private async applyContextStealth(context: BrowserContext): Promise<void> {
    await context.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
      const pluginArrayProto = Object.getPrototypeOf(navigator.plugins);
      const plugins = [
        { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' },
        { name: 'Chrome PDF Viewer', filename: 'mhjfbmdgcfjbbpaeojofohoefgiehjai' },
        { name: 'Native Client', filename: 'internal-nacl-plugin' },
      ];
      Object.setPrototypeOf(plugins, pluginArrayProto);

      Object.defineProperty(navigator, 'plugins', { get: () => plugins });
      Object.defineProperty(navigator, 'platform', { get: () => 'Win32' });
      Object.defineProperty(navigator, 'languages', { get: () => ['it-IT', 'it', 'en-US', 'en'] });
      Object.defineProperty(navigator, 'hardwareConcurrency', { get: () => 8 });
      Object.defineProperty(navigator, 'deviceMemory', { get: () => 8 });

      const originalQuery = window.navigator.permissions.query.bind(window.navigator.permissions);
      window.navigator.permissions.query = ((parameters: { name?: string }) =>
        parameters?.name === 'notifications'
          ? Promise.resolve({ state: (globalThis as any).Notification?.permission ?? 'default' })
          : originalQuery(parameters as Parameters<typeof originalQuery>[0])) as typeof window.navigator.permissions.query;

      (window as any).chrome = {
        runtime: {
          onMessage: { addListener: () => undefined },
          connect: () => undefined,
        },
        loadTimes: () => ({}),
        csi: () => ({}),
      };
    });
  }

  private async warmPersistentContext(context: BrowserContext): Promise<void> {
    const page = await context.newPage();
    try {
      try {
        await page.goto(`${EurobetOddsService.BASE_URL}/it/scommesse`, {
          waitUntil: 'domcontentloaded',
          timeout: 90000,
        });
      } catch (error) {
        this.logEurobet('warn', 'Warmup home page fallita', {
          pageUrl: `${EurobetOddsService.BASE_URL}/it/scommesse`,
          scope: 'warmPersistentContext',
        }, error);
      }
      await this.tryDismissCookieBanner(page, {
        pageUrl: `${EurobetOddsService.BASE_URL}/it/scommesse`,
        scope: 'warmPersistentContext',
      });
      await page.mouse.move(400 + Math.random() * 200, 300 + Math.random() * 200);
      await page.waitForTimeout(2000 + Math.random() * 2000);
      await page.mouse.move(600 + Math.random() * 100, 400 + Math.random() * 100);
      await page.waitForTimeout(1500 + Math.random() * 1500);

      try {
        await page.goto(`${EurobetOddsService.BASE_URL}/it/scommesse/calcio/it-serie-a`, {
          waitUntil: 'networkidle',
          timeout: 90000,
        });
      } catch (error) {
        this.logEurobet('warn', 'Warmup Serie A fallita', {
          pageUrl: `${EurobetOddsService.BASE_URL}/it/scommesse/calcio/it-serie-a`,
          scope: 'warmPersistentContext',
        }, error);
      }
      await this.tryDismissCookieBanner(page, {
        pageUrl: `${EurobetOddsService.BASE_URL}/it/scommesse/calcio/it-serie-a`,
        scope: 'warmPersistentContext',
      });
      await page.waitForTimeout(4000 + Math.random() * 3000);

      for (let i = 0; i < 3; i += 1) {
        await page.mouse.wheel(0, 300 + Math.random() * 200);
        await page.waitForTimeout(800 + Math.random() * 600);
      }

      const firstEventLink = page.locator('a[href*="/calcio/it-serie-a/"]').first();
      if (await firstEventLink.isVisible({ timeout: 5000 }).catch(() => false)) {
        try {
          await firstEventLink.click({ timeout: 5000 });
        } catch (error) {
          this.logEurobet('warn', 'Warmup click primo evento fallito', {
            pageUrl: `${EurobetOddsService.BASE_URL}/it/scommesse/calcio/it-serie-a`,
            scope: 'warmPersistentContext',
          }, error);
        }
        await page.waitForTimeout(3000 + Math.random() * 2000);
      }
    } finally {
      await page.close().catch(() => undefined);
    }
  }

  private registerPersistentCleanupHooks(): void {
    if (EurobetOddsService.processHooksRegistered) return;
    EurobetOddsService.processHooksRegistered = true;

    const cleanup = async () => {
      const promise = EurobetOddsService.persistentContextPromise;
      EurobetOddsService.persistentWarmupPromise = null;
      EurobetOddsService.persistentContextPromise = null;
      if (!promise) return;
      const context = await promise.catch(() => null);
      if (context) {
        await context.close().catch(() => undefined);
      }
    };

    process.once('exit', () => {
      void cleanup();
    });
    process.once('SIGINT', () => {
      void cleanup().finally(() => process.exit(130));
    });
    process.once('SIGTERM', () => {
      void cleanup().finally(() => process.exit(143));
    });
  }

  private async fetchSameOriginJson<T>(
    page: Page,
    path: string,
    context: Record<string, unknown> = {}
  ): Promise<T> {
    const response = await page.evaluate(
      async ({ requestPath, headers }) => {
        const result = await fetch(requestPath, {
          credentials: 'include',
          headers,
        });
        const text = await result.text();
        return {
          ok: result.ok,
          status: result.status,
          contentType: result.headers.get('content-type') ?? '',
          text,
        };
      },
      { requestPath: path, headers: EurobetOddsService.X_EB_HEADERS }
    );

    if (!response.ok) {
      this.logEurobet('warn', 'Fetch same-origin Eurobet con status non valido', {
        path,
        status: response.status,
        contentType: response.contentType,
        snippet: this.buildPayloadSnippet(response.text),
        ...context,
      });
      throw new Error(`Eurobet ${path} returned ${response.status}`);
    }

    return this.parseJsonPayload<T>(
      response.text,
      `Fetch same-origin ${path} (${response.contentType || 'content-type sconosciuto'})`,
      {
        path,
        status: response.status,
        contentType: response.contentType,
        ...context,
      }
    );
  }

  private async resolveMeetingAlias(competition: string): Promise<string> {
    const normalizedCompetition = this.normalizeWords(competition);
    const cached = this.competitionAliasCache.get(normalizedCompetition);
    if (cached) return cached;

    try {
      const sportList = await this.fetchSportList();
      const flatMeetings = this.flattenMeetings(sportList?.result?.itemList ?? []);
      const match = flatMeetings.find((node) => this.isCompetitionMatch(String(node.description ?? ''), competition));
      if (match?.aliasUrl) {
        this.competitionAliasCache.set(normalizedCompetition, match.aliasUrl);
        this.setSmokeMeetingAlias(match.aliasUrl);
        return match.aliasUrl;
      }
    } catch (error) {
      this.recordDerivedSmokeIssue(error, true, { competition });
      this.logEurobet('warn', 'Fetch sport-list fallito, uso fallback statico se disponibile', {
        competition,
      }, error);
    }

    const fallback = EurobetOddsService.FALLBACK_MEETING_ALIASES[competition];
    if (fallback) {
      this.competitionAliasCache.set(normalizedCompetition, fallback);
      this.setSmokeMeetingAlias(fallback);
      return fallback;
    }

    this.recordSmokeIssue('resolve_meeting_alias_failed', 'Impossibile risolvere il meeting alias per la competizione richiesta', false, {
      competition,
    });
    throw new Error(`Eurobet non supporta o non espone la competizione: ${competition}`);
  }

  private async fetchSportList(): Promise<{ result?: EurobetTreeNode }> {
    return this.withPage(async (page) => {
      return this.gotoAndFetchOnPage(
        page,
        `${EurobetOddsService.BASE_URL}/it/scommesse/calcio/it-serie-a`,
        '/prematch-menu-service/api/v2/sport-schedule/services/sport-list/calcio'
      );
    });
  }

  private async fetchMeetingDetail(
    meetingAlias: string,
    context: Record<string, unknown> = {}
  ): Promise<EurobetMeetingResponse> {
    return this.captureNavigatedJson(
      `${EurobetOddsService.BASE_URL}/it/scommesse/calcio/${meetingAlias}`,
      `${EurobetOddsService.BASE_URL}/detail-service/sport-schedule/services/meeting/calcio/${meetingAlias}?prematch=1&live=0`,
      context
    );
  }

  private async fetchEventDetail(
    meetingAlias: string,
    eventAlias: string,
    context: Record<string, unknown> = {}
  ): Promise<EurobetEventResponse> {
    return this.captureNavigatedJson(
      `${EurobetOddsService.BASE_URL}/it/scommesse/calcio/${meetingAlias}/${eventAlias}`,
      `${EurobetOddsService.BASE_URL}/detail-service/sport-schedule/services/event/calcio/${meetingAlias}/${eventAlias}?prematch=1&live=0`,
      context
    );
  }

  private async fetchEventGroupDetail(
    meetingAlias: string,
    eventAlias: string,
    groupAlias: string,
    context: Record<string, unknown> = {}
  ): Promise<EurobetEventResponse> {
    const encodedGroup = encodeURIComponent(groupAlias);
    return this.captureNavigatedJson(
      `${EurobetOddsService.BASE_URL}/it/scommesse/calcio/${meetingAlias}/${eventAlias}/group/${encodedGroup}`,
      `${EurobetOddsService.BASE_URL}/detail-service/sport-schedule/services/event/calcio/${meetingAlias}/${eventAlias}/${groupAlias}?prematch=1&live=0`,
      context
    );
  }

  private async captureNavigatedJson<T>(
    pageUrl: string,
    responseUrl: string,
    context: Record<string, unknown> = {}
  ): Promise<T> {
    if (this.isPersistentProfileEnabled()) {
      try {
        return await this.withPage(async (page) => {
          return this.captureNavigatedJsonOnPage(page, pageUrl, responseUrl, context);
        });
      } catch (error) {
        this.logEurobet('warn', 'Context persistente fallito, riprovo con browser isolato', context, error);
      }
    }

    return this.withIsolatedPage(async (page) => {
      return this.captureNavigatedJsonOnPage(page, pageUrl, responseUrl, context);
    });
  }

  private async fetchEventDetailOnPage(
    page: Page,
    meetingAlias: string,
    eventAlias: string,
    context: Record<string, unknown> = {}
  ): Promise<EurobetEventResponse> {
    return this.captureNavigatedJsonOnPage(
      page,
      `${EurobetOddsService.BASE_URL}/it/scommesse/calcio/${meetingAlias}/${eventAlias}`,
      `${EurobetOddsService.BASE_URL}/detail-service/sport-schedule/services/event/calcio/${meetingAlias}/${eventAlias}?prematch=1&live=0`,
      context
    );
  }

  /**
   * Naviga verso pageUrl e intercetta la risposta API corrispondente a responseUrl.
   *
   * STRATEGIA (v2):
   * ---------------
   * 1. Usa waitForResponse() avviato IN PARALLELO con page.goto — elimina la
   *    race condition del vecchio listener page.on('response') che poteva
   *    perdere risposte arrivate prima che il listener fosse attaccato.
   * 2. Match parziale sull'URL (includes) anziché uguaglianza stretta, per
   *    resistere a variazioni di query string o path minori introdotte da
   *    aggiornamenti lato Eurobet.
   * 3. In caso di timeout/errore: refresh sessione e retry.
   * 4. Fallback finale: tenta fetchSameOriginJson direttamente nel browser,
   *    utile se la SPA ha già caricato la pagina e la risposta non viene più
   *    emessa dal network (es. cache browser).
   */
  private async captureNavigatedJsonOnPage<T>(
    page: Page,
    pageUrl: string,
    responseUrl: string,
    context: Record<string, unknown> = {}
  ): Promise<T> {
    // Estrae la parte di path significativa per il match parziale
    // (es. "/services/event/calcio/it-serie-a/milan-inter-...") ignorando
    // la base URL e i parametri query che possono variare.
    const urlMatchFragment = (() => {
      try {
        const parsed = new URL(responseUrl);
        return parsed.pathname;
      } catch {
        return responseUrl;
      }
    })();

    let lastError: unknown = null;

    for (let attempt = 0; attempt < EurobetOddsService.NAVIGATION_RETRIES; attempt++) {
      try {
        // Promise per la risposta API: avviata PRIMA di goto per non perdere
        // risposte che arrivano durante il caricamento della pagina.
        const responsePromise = page.waitForResponse(
          (res) => res.url().includes(urlMatchFragment),
          { timeout: 35000 + attempt * 5000 }
        );

        // Naviga in parallelo
        await Promise.all([
          page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 90000 }).catch((error) => {
            this.logEurobet('warn', 'Navigazione Eurobet ha restituito errore non fatale', {
              pageUrl,
              expectedResponseUrl: responseUrl,
              attempt: attempt + 1,
              ...context,
            }, error);
            return null;
          }),
          // Cookie banner: non bloccare se fallisce
          page.waitForTimeout(400).then(() => this.tryDismissCookieBanner(page, {
            pageUrl,
            expectedResponseUrl: responseUrl,
            attempt: attempt + 1,
            scope: 'captureNavigatedJsonOnPage',
            ...context,
          })),
        ]).catch(() => undefined); // goto può lanciare su redirect; non è fatale

        const matchedResponse = await responsePromise;
        const text = await matchedResponse.text();
        const interceptedUrl = matchedResponse.url();
        const status = matchedResponse.status();
        const contentType = await matchedResponse.headerValue('content-type') ?? '';
        const responseContext = {
          pageUrl,
          expectedResponseUrl: responseUrl,
          interceptedUrl,
          status,
          contentType,
          attempt: attempt + 1,
          ...context,
        };

        if (status < 200 || status >= 300) {
          this.logEurobet('warn', 'Risposta network Eurobet con status non valido', {
            ...responseContext,
            snippet: this.buildPayloadSnippet(text),
          });
          throw new Error(`Eurobet ${urlMatchFragment} returned status ${status}`);
        }

        if (!this.looksLikeJson(text)) {
          this.logEurobet('warn', 'Risposta network Eurobet non JSON', {
            ...responseContext,
            snippet: this.buildPayloadSnippet(text),
          });
        }

        return this.parseJsonPayload<T>(
          text,
          `Risposta network ${urlMatchFragment} (status ${status})`,
          responseContext
        );
      } catch (err) {
        lastError = err;
        this.logEurobet('warn', 'Navigazione/attesa risposta Eurobet fallita', {
          pageUrl,
          expectedResponseUrl: responseUrl,
          urlMatchFragment,
          attempt: attempt + 1,
          ...context,
        }, err);

        // Fallback: tenta di chiamare l'API direttamente dal contesto browser.
        // Funziona se la SPA ha già impostato i cookie di sessione corretti.
        try {
          return await this.fetchSameOriginJson<T>(page, responseUrl, context);
        } catch (fallbackError) {
          lastError = fallbackError;
          this.logEurobet('warn', 'Fallback fetch same-origin fallito', {
            pageUrl,
            expectedResponseUrl: responseUrl,
            attempt: attempt + 1,
            ...context,
          }, fallbackError);
        }

        if (attempt < EurobetOddsService.NAVIGATION_RETRIES - 1) {
          await this.refreshEurobetSession(page);
          // Backoff esponenziale: 2s, 4s, 6s
          await page.waitForTimeout(2000 + attempt * 2000);
        }
      }
    }

    const errorMessage = lastError instanceof Error
      ? lastError.message
      : `Eurobet ${urlMatchFragment} non ha risposto dopo ${EurobetOddsService.NAVIGATION_RETRIES} tentativi`;
    throw new Error(errorMessage);
  }

  private async gotoAndFetchOnPage<T>(page: Page, pageUrl: string, requestPath: string): Promise<T> {
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await this.tryDismissCookieBanner(page, {
        pageUrl,
        expectedResponseUrl: requestPath,
        attempt: attempt + 1,
        scope: 'gotoAndFetchOnPage',
      });
      // Backoff progressivo: 1.5s → 3.0s → 5.4s
      await page.waitForTimeout(1500 + attempt * 1200 * (attempt + 1));
      try {
        return await this.fetchSameOriginJson<T>(page, requestPath);
      } catch (error) {
        lastError = error;
        if (attempt < 2) {
          await this.refreshEurobetSession(page);
        }
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`Eurobet ${requestPath} non disponibile`);
  }

  private buildMatchFromEventResponse(
    meetingAlias: string,
    eventAlias: string,
    response: EurobetEventResponse,
    availableGroupAliases: string[]
  ): EurobetOddsMatch {
    const eventInfo = response?.result?.eventInfo ?? {};
    const homeTeam = String(eventInfo.teamHome?.description ?? '').trim();
    const awayTeam = String(eventInfo.teamAway?.description ?? '').trim();
    const commenceTime = Number.isFinite(Number(eventInfo.eventData))
      ? new Date(Number(eventInfo.eventData)).toISOString()
      : new Date().toISOString();
    const bookmakers = this.buildBookmakers(homeTeam, awayTeam, response?.result?.betGroupList ?? []);

    return {
      matchId: `eurobet_${meetingAlias}__${eventAlias}`,
      meetingAlias,
      eventAlias,
      homeTeam,
      awayTeam,
      commenceTime,
      bookmakers,
      availableGroupAliases,
      loadedGroupAliases: ['base'],
      unavailableGroupAliases: [],
    };
  }

  private buildMatchFromMeetingItem(
    meetingAlias: string,
    item: EurobetMeetingItem,
    availableGroupAliases: string[]
  ): EurobetOddsMatch {
    const eventInfo = item.eventInfo ?? {};
    const eventAlias = String(eventInfo.aliasUrl ?? '').trim();
    const homeTeam = String(eventInfo.teamHome?.description ?? '').trim();
    const awayTeam = String(eventInfo.teamAway?.description ?? '').trim();
    const commenceTime = Number.isFinite(Number(eventInfo.eventData))
      ? new Date(Number(eventInfo.eventData)).toISOString()
      : new Date().toISOString();
    const bookmakers = this.buildBookmakers(homeTeam, awayTeam, item.betGroupList ?? []);

    return {
      matchId: `eurobet_${meetingAlias}__${eventAlias}`,
      meetingAlias,
      eventAlias,
      homeTeam,
      awayTeam,
      commenceTime,
      bookmakers,
      availableGroupAliases,
      loadedGroupAliases: ['base'],
      unavailableGroupAliases: [],
    };
  }

  private async fetchFixtureOdds(
    competition: string,
    meetingAlias: string,
    fixture: FixtureCandidate
  ): Promise<EurobetOddsMatch | null> {
    const candidateAliases = this.buildEventAliasCandidates(fixture);
    let bestMatch: EurobetOddsMatch | null = null;
    let bestScore = -1;

    for (const eventAlias of candidateAliases) {
      try {
        const eventDetail = await this.fetchEventDetail(meetingAlias, eventAlias, {
          competition,
          meetingAlias,
          eventAlias,
          fixtureHomeTeam: fixture.homeTeam,
          fixtureAwayTeam: fixture.awayTeam,
          source: 'fixture-fallback',
        });
        const match = this.tryBuildMatchFromEventResponse(
          competition,
          meetingAlias,
          eventAlias,
          eventDetail,
          this.extractGroupAliases(eventDetail?.result?.groupData?.groupList)
        );

        if (!match) {
          continue;
        }

        const score = this.scoreFixtureMatch(fixture, match);
        if (!this.fixtureMatches(fixture, match)) {
          this.logEurobet('info', 'Alias evento fallback non corrisponde alla fixture richiesta', {
            competition,
            meetingAlias,
            eventAlias,
            fixtureHomeTeam: fixture.homeTeam,
            fixtureAwayTeam: fixture.awayTeam,
            score,
          });
          continue;
        }

        if (score > bestScore) {
          bestScore = score;
          bestMatch = match;
        }
      } catch (error) {
        this.recordDerivedSmokeIssue(error, true, {
          competition,
          meetingAlias,
          eventAlias,
        });
        this.logEurobet('warn', 'Fetch fallback per fixture fallito', {
          competition,
          meetingAlias,
          eventAlias,
          fixtureHomeTeam: fixture.homeTeam,
          fixtureAwayTeam: fixture.awayTeam,
        }, error);
        continue;
      }
    }

    if (bestMatch) {
      this.markSmokeSource('event-detail');
      return bestMatch;
    }

    this.recordSmokeIssue('fixture_matching_failed', 'Nessun alias evento fallback corrisponde alla fixture richiesta', true, {
      competition,
      meetingAlias,
      fixtureHomeTeam: fixture.homeTeam,
      fixtureAwayTeam: fixture.awayTeam,
    });
    this.logEurobet('warn', 'Nessun alias evento fallback ha prodotto una quota valida per la fixture', {
      competition,
      meetingAlias,
      fixtureHomeTeam: fixture.homeTeam,
      fixtureAwayTeam: fixture.awayTeam,
    });
    return null;
  }

  private async collectMeetingPageMetadata(page: Page, meetingAlias: string): Promise<{
    eventAliases: string[];
    groupAliases: string[];
  }> {
    const pageUrl = `${EurobetOddsService.BASE_URL}/it/scommesse/calcio/${meetingAlias}`;
    await page.goto(pageUrl, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await this.tryDismissCookieBanner(page, {
      pageUrl: `${EurobetOddsService.BASE_URL}/it/scommesse/calcio/${meetingAlias}`,
      meetingAlias,
      scope: 'collectMeetingPageMetadata',
    });

    for (let attempt = 0; attempt < EurobetOddsService.COMPETITION_SCROLL_ATTEMPTS; attempt++) {
      const extracted = await page.evaluate((alias) => {
        const eventAliases = new Set<string>();
        const groupAliases = new Set<string>();
        const baseEventPath = `/it/scommesse/calcio/${alias}/`;
        const baseGroupPath = `${baseEventPath}group/`;

        for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
          const href = String(anchor.getAttribute('href') ?? '').trim();
          if (!href) continue;
          if (href.startsWith(baseGroupPath)) {
            const raw = href.slice(baseGroupPath.length).split(/[?#]/)[0];
            if (raw) groupAliases.add(decodeURIComponent(raw));
            continue;
          }
          if (!href.startsWith(baseEventPath)) continue;
          const raw = href.slice(baseEventPath.length).split(/[?#]/)[0];
          if (!raw || raw.startsWith('group/')) continue;
          eventAliases.add(decodeURIComponent(raw));
        }

        return {
          eventAliases: Array.from(eventAliases),
          groupAliases: Array.from(groupAliases),
        };
      }, meetingAlias);

      if (extracted.eventAliases.length > 0) {
        return extracted;
      }

      await page.mouse.wheel(0, 1500);
      await page.waitForTimeout(1200 + attempt * 150);
    }

    return { eventAliases: [], groupAliases: [] };
  }

  private async dismissCookieBanner(page: Page): Promise<void> {
    const bannerSelectors = [
      '#onetrust-banner-sdk',
      '#CybotCookiebotDialog',
      '[data-testid*="cookie" i]',
      '[id*="cookie" i]',
      '[class*="cookie" i]',
      '[aria-label*="cookie" i]',
      '[role="dialog"][aria-label*="cookie" i]',
      '[role="dialog"][id*="consent" i]',
    ];

    const bannerLocator = page.locator(bannerSelectors.join(', ')).first();
    const bannerVisible = await bannerLocator.isVisible({ timeout: 3000 }).catch(() => false);
    if (!bannerVisible) return;

    const candidateLocators = [
      page.getByRole('button', { name: /accetta.*cookie|accetta tutti|accept all|consenti tutti|accetto/i }).first(),
      page.getByRole('button', { name: /chiudi|close|continua|prosegui/i }).first(),
      page.locator('[data-testid*="accept" i], [data-testid*="cookie-accept" i], [id*="accept" i], [class*="accept" i]').first(),
      page.locator('button:has-text("Accetta"), button:has-text("Accept"), button:has-text("Cookie"), button:has-text("Chiudi")').first(),
    ];

    for (const locator of candidateLocators) {
      const visible = await locator.isVisible({ timeout: 800 }).catch(() => false);
      if (!visible) continue;
      await locator.click({ timeout: 2500 });
      await page.waitForTimeout(300);
      return;
    }

    await page.evaluate(() => {
      const buttonLabels = ['accetta', 'accept', 'cookie', 'chiudi', 'close', 'continua'];
      const elements = Array.from(document.querySelectorAll('button, [role="button"], [data-testid]'));
      for (const element of elements) {
        const label = String(
          (element.textContent ?? '')
          || element.getAttribute('aria-label')
          || element.getAttribute('data-testid')
          || ''
        ).trim().toLowerCase();
        if (!label) continue;
        if (!buttonLabels.some((fragment) => label.includes(fragment))) continue;
        if (element instanceof HTMLElement) {
          element.click();
          return;
        }
      }
    });
  }

  private async tryDismissCookieBanner(page: Page, context: Record<string, unknown> = {}): Promise<void> {
    try {
      await this.dismissCookieBanner(page);
    } catch (error) {
      this.recordSmokeIssue('cookie_or_spa_dom_issue', 'Gestione cookie banner fallita', true, context);
      this.logEurobet('warn', 'Gestione cookie banner fallita', context, error);
    }
  }

  private async refreshEurobetSession(page: Page): Promise<void> {
    try {
      await page.goto(`${EurobetOddsService.BASE_URL}/it/scommesse`, {
        waitUntil: 'domcontentloaded',
        timeout: 90000,
      });
    } catch (error) {
      this.logEurobet('warn', 'Refresh sessione Eurobet fallito', {
        pageUrl: `${EurobetOddsService.BASE_URL}/it/scommesse`,
        scope: 'refreshEurobetSession',
      }, error);
    }
    await this.tryDismissCookieBanner(page, {
      pageUrl: `${EurobetOddsService.BASE_URL}/it/scommesse`,
      scope: 'refreshEurobetSession',
    });
    await page.waitForTimeout(2500);
  }

  private parseJsonPayload<T>(
    rawText: string,
    sourceLabel: string,
    context: Record<string, unknown> = {}
  ): T {
    const text = String(rawText ?? '').trim();
    if (!this.looksLikeJson(text)) {
      const reason = this.classifyNonJsonPayload(text);
      const category = reason === 'HTML/captcha invece di JSON' || reason === 'HTML invece di JSON'
        ? 'html_or_captcha'
        : 'non_json_response';
      this.recordSmokeIssue(category, `${sourceLabel} ha restituito ${reason}`, true, context);
      this.logEurobet('warn', `${sourceLabel} ha restituito ${reason}`, {
        ...context,
        snippet: this.buildPayloadSnippet(text),
      });
      throw new Error(`Eurobet ${sourceLabel} ha restituito ${reason}`);
    }

    try {
      return JSON.parse(text) as T;
    } catch (error) {
      this.logEurobet('warn', `${sourceLabel} contiene JSON non parsabile`, {
        ...context,
        snippet: this.buildPayloadSnippet(text),
      }, error);
      throw new Error(`Eurobet ${sourceLabel} contiene JSON non parsabile`);
    }
  }

  private classifyNonJsonPayload(text: string): string {
    const compact = String(text ?? '').trim().toLowerCase();
    if (!compact) return 'una risposta vuota';
    if (compact.startsWith('<') || compact.includes('<html')) {
      if (compact.includes('captcha') || compact.includes('cloudflare') || compact.includes('just a moment')) {
        return 'HTML/captcha invece di JSON';
      }
      return 'HTML invece di JSON';
    }
    return 'testo non JSON';
  }

  private classifyErrorFromMessage(message: string): EurobetSmokeErrorCategory | null {
    const normalized = this.normalizeWords(message);
    if (!normalized) return null;
    if (normalized.includes('captcha') || normalized.includes('cloudflare') || normalized.includes('html invece di json')) {
      return 'html_or_captcha';
    }
    if (normalized.includes('non json') || normalized.includes('testo non json')) {
      return 'non_json_response';
    }
    if (normalized.includes('cookie') || normalized.includes('spa') || normalized.includes('dom')) {
      return 'cookie_or_spa_dom_issue';
    }
    if (normalized.includes('meeting json')) {
      return 'meeting_json_failed';
    }
    if (normalized.includes('parsing quote vuoto') || normalized.includes('mercato')) {
      return 'parsing_zero_markets';
    }
    if (normalized.includes('fixture')) {
      return 'fixture_matching_failed';
    }
    if (normalized.includes('gruppo esteso')) {
      return 'extended_groups_failed';
    }
    if (normalized.includes('competizione')) {
      return 'resolve_meeting_alias_failed';
    }
    return null;
  }

  private recordDerivedSmokeIssue(
    error: unknown,
    recoverable: boolean,
    context: Record<string, unknown> = {}
  ): void {
    const message = this.describeEurobetError(error);
    const category = this.classifyErrorFromMessage(message);
    if (!category) return;
    this.recordSmokeIssue(category, message, recoverable, context);
  }

  private looksLikeJson(text: string): boolean {
    const trimmed = String(text ?? '').trim();
    return trimmed.startsWith('{') || trimmed.startsWith('[');
  }

  private buildPayloadSnippet(text: string, maxLength = 180): string {
    const compact = String(text ?? '').replace(/\s+/g, ' ').trim();
    if (!compact) return '';
    if (compact.length <= maxLength) return compact;
    return `${compact.slice(0, maxLength)}...`;
  }

  private mergeAliases(...groups: Array<string[] | undefined>): string[] {
    return Array.from(
      new Set(
        groups.flatMap((items) => items ?? []).filter(Boolean)
      )
    );
  }

  private buildEventAliasCandidates(fixture: FixtureCandidate): string[] {
    const homeCandidates = this.buildTeamSlugCandidates(fixture.homeTeam);
    const awayCandidates = this.buildTeamSlugCandidates(fixture.awayTeam);
    const timeCandidates = this.buildTimeCandidates(fixture.commenceTime);
    const aliases = new Set<string>();

    for (const home of homeCandidates) {
      for (const away of awayCandidates) {
        for (const stamp of timeCandidates) {
          aliases.add(`${home}-${away}-${stamp}`);
        }
      }
    }

    return Array.from(aliases);
  }

  private buildTeamSlugCandidates(teamName: string): string[] {
    const normalized = this.normalizeWords(teamName);
    const compact = normalized.replace(/\s+/g, '-');
    const overrides = new Set<string>();

    for (const [canonical, aliases] of Object.entries(EurobetOddsService.TEAM_SLUG_OVERRIDES)) {
      const normalizedAliases = aliases.map((value) => this.normalizeWords(value));
      if (normalized === canonical || normalizedAliases.includes(normalized)) {
        overrides.add(canonical.replace(/\s+/g, '-'));
        for (const alias of normalizedAliases) {
          overrides.add(alias.replace(/\s+/g, '-'));
        }
      }
    }

    return Array.from(
      new Set(
        [compact, ...overrides]
          .map((value) => String(value ?? '').trim().toLowerCase())
          .filter(Boolean)
      )
    );
  }

  private buildTimeCandidates(commenceTime?: string | null): string[] {
    const raw = String(commenceTime ?? '').trim();
    if (!raw) return [''];

    const baseDate = new Date(raw);
    if (Number.isNaN(baseDate.getTime())) return [''];

    const deltas = [-120, -60, 0, 60, 120];
    const timeZones: Array<'Europe/Rome' | 'UTC'> = ['Europe/Rome', 'UTC'];
    return Array.from(
      new Set(
        deltas.flatMap((deltaMinutes) => {
          const candidate = new Date(baseDate.getTime() + deltaMinutes * 60_000);
          return timeZones.map((timeZone) => this.formatEurobetTimestamp(candidate, timeZone));
        }).filter(Boolean)
      )
    );
  }

  private formatEurobetTimestamp(date: Date, timeZone: 'Europe/Rome' | 'UTC'): string {
    const formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

    const parts = formatter.formatToParts(date);
    const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? '';
    return `${pick('year')}${pick('month')}${pick('day')}${pick('hour')}${pick('minute')}`;
  }

  private fixtureMatches(fixture: FixtureCandidate, match: EurobetOddsMatch): boolean {
    return this.scoreFixtureMatch(fixture, match) >= 700;
  }

  private logEurobet(
    level: 'info' | 'warn' | 'error',
    message: string,
    context: Record<string, unknown> = {},
    error?: unknown
  ): void {
    const filteredContext = Object.fromEntries(
      Object.entries(context).filter(([, value]) => value !== undefined && value !== null && value !== '')
    );
    const contextSuffix = Object.keys(filteredContext).length > 0
      ? ` | ${JSON.stringify(filteredContext)}`
      : '';
    const errorSuffix = error ? ` | ${this.describeEurobetError(error)}` : '';
    const line = `[Eurobet] ${message}${contextSuffix}${errorSuffix}`;

    if (level === 'error') {
      console.error(line);
      return;
    }
    if (level === 'warn') {
      console.warn(line);
      return;
    }
    console.info(line);
  }

  private describeEurobetError(error: unknown): string {
    if (error instanceof Error) return error.message;
    return typeof error === 'string' ? error : 'Errore sconosciuto';
  }

  private isPersistentProfileEnabled(): boolean {
    const raw = String(process.env.EUROBET_PERSISTENT_PROFILE_ENABLED ?? 'true').trim().toLowerCase();
    return raw !== '0' && raw !== 'false' && raw !== 'no' && raw !== 'off';
  }

  private isHeadlessBrowser(): boolean {
    const raw = String(process.env.EUROBET_BROWSER_HEADLESS ?? 'true').trim().toLowerCase();
    return raw !== '0' && raw !== 'false' && raw !== 'no' && raw !== 'off';
  }

  private getPersistentProfileDir(): string {
    const configured = String(process.env.EUROBET_PROFILE_DIR ?? '').trim();
    if (configured) {
      return path.isAbsolute(configured)
        ? configured
        : path.resolve(process.cwd(), configured);
    }

    return path.resolve(process.cwd(), '.playwright', 'eurobet-profile');
  }

  private getBrowserChannel(): string | undefined {
    const configured = String(process.env.EUROBET_BROWSER_CHANNEL ?? '').trim();
    return configured || undefined;
  }

  private getBrowserExecutablePath(): string | undefined {
    const configured = String(process.env.EUROBET_BROWSER_EXECUTABLE_PATH ?? '').trim();
    return configured || undefined;
  }

  private getBrowserSlowMo(): number | undefined {
    const configured = Number.parseInt(String(process.env.EUROBET_BROWSER_SLOW_MO ?? ''), 10);
    return Number.isFinite(configured) && configured >= 0 ? configured : undefined;
  }

  private getEventConcurrency(): number {
    const configured = Number.parseInt(String(process.env.EUROBET_EVENT_CONCURRENCY ?? ''), 10);
    if (Number.isFinite(configured) && configured > 0) {
      return configured;
    }

    return this.isPersistentProfileEnabled()
      ? EurobetOddsService.DEFAULT_PROFILE_EVENT_CONCURRENCY
      : EurobetOddsService.DEFAULT_EVENT_CONCURRENCY;
  }

  private buildLaunchOptions(): {
    headless: boolean;
    slowMo?: number;
    channel?: string;
    executablePath?: string;
    args: string[];
  } {
    const executablePath = this.getBrowserExecutablePath();
    const channel = executablePath ? undefined : this.getBrowserChannel();

    return {
      headless: this.isHeadlessBrowser(),
      slowMo: this.getBrowserSlowMo(),
      channel,
      executablePath,
      args: this.buildBrowserArgs(),
    };
  }

  private buildPersistentContextOptions(): {
    headless: boolean;
    slowMo?: number;
    channel?: string;
    executablePath?: string;
    args: string[];
    userAgent: string;
    locale: string;
    timezoneId: string;
    viewport: { width: number; height: number } | null;
    extraHTTPHeaders: Record<string, string>;
  } {
    return {
      ...this.buildLaunchOptions(),
      ...this.buildContextOptions(),
    };
  }

  private buildContextOptions(): {
    userAgent: string;
    locale: string;
    timezoneId: string;
    viewport: { width: number; height: number } | null;
    extraHTTPHeaders: Record<string, string>;
  } {
    return {
      userAgent: EurobetOddsService.USER_AGENT,
      locale: 'it-IT',
      timezoneId: 'Europe/Rome',
      viewport: this.isHeadlessBrowser() ? { width: 1366, height: 900 } : null,
      extraHTTPHeaders: {
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    };
  }

  private buildBrowserArgs(): string[] {
    const args = [
      '--disable-blink-features=AutomationControlled',
      '--lang=it-IT',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-infobars',
      '--disable-notifications',
      '--disable-popup-blocking',
      '--ignore-certificate-errors',
      '--disable-gpu',
      '--disable-web-security',
      '--allow-running-insecure-content',
    ];

    if (this.isDockerRuntime()) {
      args.push(
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--single-process',
      );
    }

    if (!this.isHeadlessBrowser()) {
      args.push('--start-maximized');
    }

    return args;
  }

  private isDockerRuntime(): boolean {
    return existsSync('/.dockerenv');
  }

  private buildBookmakers(homeTeam: string, awayTeam: string, betGroupList: EurobetBetGroup[]): BookmakerOdds[] {
    const markets = this.parseBetGroupMarkets(homeTeam, awayTeam, betGroupList);
    return [
      {
        bookmakerKey: 'eurobet',
        bookmakerName: 'Eurobet',
        markets,
      },
    ];
  }

  private parseBetGroupMarkets(homeTeam: string, awayTeam: string, betGroupList: EurobetBetGroup[]): MarketOdds[] {
    const markets: MarketOdds[] = [];
    for (const betGroup of betGroupList ?? []) {
      for (const oddGroup of betGroup.oddGroupList ?? []) {
        const market = this.parseOddGroup(homeTeam, awayTeam, betGroup, oddGroup);
        if (market && market.outcomes.length > 0) {
          markets.push(market);
        }
      }
    }
    return markets;
  }

  private parseOddGroup(
    homeTeam: string,
    awayTeam: string,
    betGroup: EurobetBetGroup,
    oddGroup: EurobetOddGroup
  ): MarketOdds | null {
    const combined = this.normalizeWords([
      betGroup.betDescription,
      oddGroup.oddGroupDescription,
      oddGroup.alternativeDescription,
    ].filter(Boolean).join(' '));

    const marketKey = this.resolveMarketKey(combined);
    if (!marketKey) return null;

    const line = this.extractLine(oddGroup);
    const outcomes: OutcomeOdds[] = [];

    for (const odd of oddGroup.oddList ?? []) {
      const price = this.parsePrice(odd.oddValue);
      if (!price) continue;

      const outcome = this.buildOutcome(homeTeam, awayTeam, marketKey, combined, odd, line);
      if (!outcome) continue;
      outcomes.push(outcome);
    }

    if (outcomes.length === 0) return null;
    return { marketKey, outcomes };
  }

  private resolveMarketKey(combinedDescription: string): string | null {
    const compact = combinedDescription.replace(/\s+/g, '');

    if (compact === '1x2' || compact.startsWith('1x2match') || compact.startsWith('scommessetop1x2')) return 'h2h';
    if (compact.includes('ggng')) return 'btts';
    if (compact === 'dc' || compact.includes('doppiachance')) return 'double_chance';
    if (compact.includes('drawnobet') || compact.includes('rimborso')) return 'draw_no_bet';

    if (compact.includes('tiriinporta') || compact.includes('shotsontarget')) return 'shots_on_target';
    if (compact.includes('tiri') || compact.includes('shots')) return 'shots';
    if (compact.includes('corner')) return 'corners';
    if (compact.includes('cartell') || compact.includes('ammon') || compact.includes('giall') || compact.includes('cards')) return 'cards';
    if (compact.includes('falli') || compact.includes('fouls')) return 'fouls';

    if (compact.includes('uogoal') || compact.includes('underovergoal')) return 'totals';
    return null;
  }

  private buildOutcome(
    homeTeam: string,
    awayTeam: string,
    marketKey: string,
    combinedDescription: string,
    odd: EurobetOdd,
    line: number | undefined
  ): OutcomeOdds | null {
    const token = this.normalizeWords(`${odd.boxTitle ?? ''} ${odd.oddDescription ?? ''}`.trim());
    const compact = token.replace(/\s+/g, '');

    if (marketKey === 'h2h') {
      if (compact === '1') return { name: homeTeam, price: this.parsePrice(odd.oddValue)! };
      if (compact === 'x') return { name: 'Draw', price: this.parsePrice(odd.oddValue)! };
      if (compact === '2') return { name: awayTeam, price: this.parsePrice(odd.oddValue)! };
      return null;
    }

    if (marketKey === 'btts') {
      if (compact === 'gg' || compact === 'si' || compact === 'yes') return { name: 'Yes', price: this.parsePrice(odd.oddValue)! };
      if (compact === 'ng' || compact === 'no') return { name: 'No', price: this.parsePrice(odd.oddValue)! };
      return null;
    }

    if (marketKey === 'double_chance') {
      if (compact === '1x' || compact === 'x2' || compact === '12') {
        return { name: odd.boxTitle ?? odd.oddDescription ?? '', price: this.parsePrice(odd.oddValue)! };
      }
      return null;
    }

    if (marketKey === 'draw_no_bet') {
      if (compact === '1') return { name: homeTeam, price: this.parsePrice(odd.oddValue)! };
      if (compact === '2') return { name: awayTeam, price: this.parsePrice(odd.oddValue)! };
      return null;
    }

    const price = this.parsePrice(odd.oddValue)!;
    const overUnder = compact.includes('over')
      ? 'Over'
      : compact.includes('under')
        ? 'Under'
        : null;
    if (!overUnder) return null;

    const point = line ?? this.extractLineFromOdd(odd);
    if (!Number.isFinite(point)) return null;

    if (marketKey === 'totals') {
      return { name: overUnder, price, point, description: 'Goals' };
    }
    if (marketKey === 'corners') {
      return { name: overUnder, price, point, description: 'Corners' };
    }
    if (marketKey === 'cards') {
      return { name: overUnder, price, point, description: 'Cards' };
    }
    if (marketKey === 'shots') {
      return { name: overUnder, price, point, description: combinedDescription.includes('casa') ? homeTeam : combinedDescription.includes('ospite') ? awayTeam : 'Shots' };
    }
    if (marketKey === 'shots_on_target') {
      return { name: overUnder, price, point, description: 'Shots On Target' };
    }
    if (marketKey === 'fouls') {
      return { name: overUnder, price, point, description: 'Fouls' };
    }

    return null;
  }

  private parsePrice(raw: unknown): number | null {
    const numeric = this.parseNumberish(raw);
    if (numeric === null || numeric <= 0) return null;

    const normalized = Number.isInteger(numeric) && numeric >= 100 && !this.hasExplicitDecimalSeparator(raw)
      ? numeric / 100
      : numeric;

    if (normalized < 1.01 || normalized > 1000) return null;
    return this.trimToTwoDecimals(normalized);
  }

  private extractLine(oddGroup: EurobetOddGroup): number | undefined {
    const candidates = [
      oddGroup.oddList?.[0]?.additionalInfo,
      oddGroup.oddList?.[1]?.additionalInfo,
    ];
    for (const list of candidates) {
      const numeric = this.extractLineFromAdditionalInfo(list);
      if (numeric !== undefined) return numeric;
    }

    const text = String(oddGroup.oddGroupDescription ?? '').trim();
    const match = text.match(/(-?\d+(?:[.,]\d+)?)/);
    if (!match) return undefined;
    const parsed = Number(match[1].replace(',', '.'));
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private extractLineFromOdd(odd: EurobetOdd): number | undefined {
    return this.extractLineFromAdditionalInfo(odd.additionalInfo);
  }

  private extractLineFromAdditionalInfo(values: unknown): number | undefined {
    if (!Array.isArray(values)) return undefined;
    for (const value of values) {
      const numeric = this.parseNumberish(value);
      if (numeric === null || numeric <= 0) continue;
      const normalized = Number.isInteger(numeric) && numeric >= 10 && !this.hasExplicitDecimalSeparator(value)
        ? numeric / 100
        : numeric;
      return this.trimToTwoDecimals(normalized);
    }
    return undefined;
  }

  private parseNumberish(raw: unknown): number | null {
    if (typeof raw === 'number') {
      return Number.isFinite(raw) ? raw : null;
    }

    if (typeof raw !== 'string') return null;

    const normalized = raw.trim().replace(',', '.');
    if (!normalized) return null;

    const numeric = Number(normalized);
    return Number.isFinite(numeric) ? numeric : null;
  }

  private hasExplicitDecimalSeparator(raw: unknown): boolean {
    return typeof raw === 'string' && /[.,]/.test(raw);
  }

  private trimToTwoDecimals(value: number): number {
    return Number(value.toFixed(2));
  }

  private mergeMarkets(existingBookmakers: BookmakerOdds[], extraMarkets: MarketOdds[]): BookmakerOdds[] {
    const bookmaker = existingBookmakers.find((entry) => entry.bookmakerKey === 'eurobet');
    if (!bookmaker) return existingBookmakers;

    const signatures = new Set<string>();
    for (const market of bookmaker.markets) {
      for (const outcome of market.outcomes ?? []) {
        signatures.add(`${market.marketKey}|${outcome.name}|${String(outcome.point ?? '')}|${String(outcome.description ?? '')}`);
      }
    }

    for (const market of extraMarkets) {
      const dedupedOutcomes = (market.outcomes ?? []).filter((outcome) => {
        const signature = `${market.marketKey}|${outcome.name}|${String(outcome.point ?? '')}|${String(outcome.description ?? '')}`;
        if (signatures.has(signature)) return false;
        signatures.add(signature);
        return true;
      });

      if (dedupedOutcomes.length > 0) {
        bookmaker.markets.push({ marketKey: market.marketKey, outcomes: dedupedOutcomes });
      }
    }

    return existingBookmakers;
  }

  private extractGroupAliases(groupList: Array<{ aliasUrl?: string }> | undefined): string[] {
    return Array.from(
      new Set(
        (groupList ?? [])
          .map((group) => String(group.aliasUrl ?? '').trim())
          .filter(Boolean)
      )
    );
  }

  private flattenMeetings(nodes: EurobetTreeNode[]): EurobetTreeNode[] {
    const meetings: EurobetTreeNode[] = [];
    const walk = (nodeList: EurobetTreeNode[]) => {
      for (const node of nodeList ?? []) {
        if (String(node.type ?? '').toLowerCase() === 'meeting' && node.aliasUrl) {
          meetings.push(node);
        }
        if (Array.isArray(node.itemList) && node.itemList.length > 0) {
          walk(node.itemList);
        }
      }
    };
    walk(nodes);
    return meetings;
  }

  private isCompetitionMatch(candidate: string, competition: string): boolean {
    const normalizedCandidate = this.normalizeWords(candidate);
    const normalizedCompetition = this.normalizeWords(competition);
    const overrides: Record<string, string[]> = {
      'La Liga': ['liga', 'la liga'],
      'Premier League': ['premier league'],
      'Bundesliga': ['bundesliga'],
      'Ligue 1': ['ligue 1', 'ligue1'],
      'Serie A': ['serie a'],
      'Champions League': ['champions league'],
    };

    const accepted = overrides[competition] ?? [competition];
    return accepted.some((entry) => normalizedCandidate === this.normalizeWords(entry));
  }

  private normalizeWords(value: string): string {
    return String(value ?? '')
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  private async mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<R>
  ): Promise<R[]> {
    const results: R[] = new Array(items.length);
    let nextIndex = 0;

    const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      for (;;) {
        const currentIndex = nextIndex++;
        if (currentIndex >= items.length) return;
        results[currentIndex] = await worker(items[currentIndex], currentIndex);
      }
    });

    await Promise.all(runners);
    return results;
  }

  private formatLineKey(point: unknown): string {
    const numeric = Number(point);
    if (!Number.isFinite(numeric)) return '0';
    return Number.isInteger(numeric) ? String(numeric) : String(numeric);
  }

  private extractBookmakerOdds(match: OddsMatch, bookmaker: BookmakerOdds): Record<string, number> {
    const odds: Record<string, number> = {};
    for (const market of bookmaker.markets ?? []) {
      for (const outcome of market.outcomes ?? []) {
        const key = this.toSelectionKey(match, market.marketKey, outcome);
        if (!key) continue;
        if (odds[key] === undefined && Number.isFinite(outcome.price) && outcome.price > 1) {
          odds[key] = outcome.price;
        }
      }
    }
    return odds;
  }

  private toSelectionKey(match: OddsMatch, marketKey: string, outcome: OutcomeOdds): string | null {
    const normalize = (value: string): string =>
      String(value ?? '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^a-z0-9]+/g, '')
        .trim();

    const name = String(outcome.name ?? '').trim();
    const desc = String(outcome.description ?? '').trim();
    const nameLower = name.toLowerCase();
    const market = String(marketKey ?? '').toLowerCase();

    const homeNorm = normalize(match.homeTeam);
    const awayNorm = normalize(match.awayTeam);
    const nameNorm = normalize(name);
    const descNorm = normalize(desc);
    const combinedNorm = `${nameNorm}${descNorm}`;

    const isHome = name === match.homeTeam || nameLower === 'home'
      || nameNorm === homeNorm
      || combinedNorm.includes(homeNorm);
    const isAway = name === match.awayTeam || nameLower === 'away'
      || nameNorm === awayNorm
      || combinedNorm.includes(awayNorm);

    const lineRaw = this.formatLineKey(outcome.point ?? 2.5);
    const compactLine = lineRaw.replace('.', '');

    const domainFromContext = (): 'shots_total' | 'sot_total' | 'corners' | 'fouls' | 'yellow' | null => {
      const probe = `${market} ${nameLower} ${desc.toLowerCase()}`.replace(/[^a-z0-9\s]/g, ' ');
      if (/\bshots?\s+on\s+target\b|\bon\s+target\b|\bsot\b/.test(probe)) return 'sot_total';
      if (/\bshots?\b|\btiri\b/.test(probe)) return 'shots_total';
      if (/\bcorners?\b|\bcorner\s+kicks?\b/.test(probe)) return 'corners';
      if (/\bfouls?\b|\bfalli\b/.test(probe)) return 'fouls';
      if (/\byellow\b|\bcards?\b|\bbookings?\b|\bcartellini\b|\bammonizioni\b/.test(probe)) return 'yellow';
      return null;
    };

    if (market === 'h2h' || market === 'h2h_3_way') {
      if (isHome) return 'homeWin';
      if (isAway) return 'awayWin';
      if (nameLower === 'draw') return 'draw';
      return null;
    }

    if (market === 'btts') {
      if (nameLower === 'yes' || nameLower === 'si') return 'btts';
      if (nameLower === 'no') return 'bttsNo';
      return null;
    }

    if (market === 'draw_no_bet') {
      if (isHome) return 'dnb_home';
      if (isAway) return 'dnb_away';
      return null;
    }

    if (market === 'totals' || market === 'alternate_totals') {
      if (nameLower !== 'over' && nameLower !== 'under') return null;
      const contextualDomain = domainFromContext();
      if (contextualDomain) return `${contextualDomain}_${nameLower}_${lineRaw}`;
      return `${nameLower}${compactLine}`;
    }

    if (market === 'team_totals' || market === 'alternate_team_totals') {
      if (nameLower !== 'over' && nameLower !== 'under') return null;
      if (isHome || descNorm.includes(homeNorm)) return `team_home_${nameLower}_${compactLine}`;
      if (isAway || descNorm.includes(awayNorm)) return `team_away_${nameLower}_${compactLine}`;
      return null;
    }

    if (market.includes('double_chance')) {
      const token = normalize(name);
      if (token.includes('1x') || (token.includes('home') && token.includes('draw'))) return 'double_chance_1x';
      if (token.includes('x2') || (token.includes('draw') && token.includes('away'))) return 'double_chance_x2';
      if (token.includes('12') || (token.includes('home') && token.includes('away'))) return 'double_chance_12';
      return null;
    }

    if ((market.includes('shots') || market.includes('corners') || market.includes('cards') || market.includes('fouls')) && (nameLower === 'over' || nameLower === 'under')) {
      const contextualDomain = domainFromContext();
      const domain = contextualDomain
        ?? (market.includes('shots_on_target') || market.includes('shot_on_target') || market.includes('sot')
          ? 'sot_total'
          : market.includes('corners')
            ? 'corners'
            : market.includes('shots')
              ? 'shots_total'
              : market.includes('cards') || market.includes('yellow')
                ? 'yellow'
                : 'fouls');
      return `${domain}_${nameLower}_${lineRaw}`;
    }

    return null;
  }
}
