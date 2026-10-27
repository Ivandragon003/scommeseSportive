/** Offline calendar demand. A projection never substitutes for measured quota headers. */
export const ODDS_DEMAND_COMPETITIONS = ['Serie A', 'Premier League', 'La Liga', 'Bundesliga', 'Ligue 1'] as const;
const MINUTE = 60_000;

export type DemandFixture = {
  matchId: string;
  competition: string;
  date?: string;
  kickoffAt?: string;
  kickoffKnown?: boolean;
  kickoffPrecision?: 'exact' | 'date' | 'unknown';
  timePrecision?: 'exact' | 'date' | 'unknown';
  status?: string;
  homeGoals?: number | null;
  awayGoals?: number | null;
};
export type OddsDemandGroup = {
  competition: string; kickoffAt: string; decisionAt: string;
  fixtureIds: string[]; futureUnverifiedFixtureCount: number;
};
export type OddsDemandOptions = {
  month: string;
  asOf: string;
  monthlyBudgetCredits?: number;
  reserveCredits?: number;
  reserveAppliesToT15?: boolean;
  retryRate?: number;
  marketCount?: number;
  regionCount?: number;
  cacheWindowSeconds?: number;
  providerPriceAgeAtFetchSeconds?: number;
  nightlyOddsEnabled?: boolean;
  kickoffRefreshesPerCompetitionPerDay?: number;
  uiRequestsPerDay?: number;
  uiCreditsPerRequest?: number;
  eventExtraRequestsPerDay?: number;
  eventExtraCreditsPerRequest?: number;
};

const iso = (value: string): string => {
  if (!/(?:z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) throw new Error('Explicit timezone required');
  return new Date(value).toISOString();
};
const integer = (value: number, name: string, minimum = 0): number => {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`Invalid ${name}`);
  return value;
};

export function quoteRequestCredits(marketCount: number, regionCount = 1, bookmakerCount?: number): number {
  integer(marketCount, 'market count', 1); integer(regionCount, 'region count', 1);
  if (bookmakerCount !== undefined) integer(bookmakerCount, 'bookmaker count', 1);
  return marketCount * (bookmakerCount === undefined ? regionCount : Math.ceil(bookmakerCount / 10));
}

/** The earlier 855 calculation is a 30-day example, not observed HTTP usage. */
export function originalMonthlyApproximation(groups = 135, days = 30, competitions = 5) {
  [groups, days, competitions].forEach((value) => integer(value, 'approximation input'));
  const t15Credits = groups * 3;
  const nightlyCredits = competitions * 3 * days;
  return { groups, days, competitions, t15Credits, nightlyCredits, totalCredits: t15Credits + nightlyCredits,
    measuredConsumption: false, excludesRetriesUiKickoffAndExtraMarkets: true };
}

export function buildOddsDemandGroups(fixtures: DemandFixture[], month: string, asOf: string) {
  if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(month)) throw new Error('Invalid UTC month');
  const observedAt = Date.parse(iso(asOf));
  const exclusions: Record<string, number> = {};
  const exclude = (reason: string) => { exclusions[reason] = (exclusions[reason] ?? 0) + 1; };
  const unique = new Map<string, DemandFixture>();
  const conflicts = new Set<string>();
  let sourceFixtureCount = 0;
  for (const fixture of fixtures) {
    const raw = fixture.kickoffAt ?? fixture.date ?? '';
    // Quota is consumed at T-15, which can belong to the preceding UTC month.
    const parsed = Date.parse(raw);
    const decisionMonth = Number.isFinite(parsed) ? new Date(parsed - 15 * MINUTE).toISOString().slice(0, 7) : null;
    if (decisionMonth !== month && raw.slice(0, 7) !== month) continue;
    sourceFixtureCount++;
    if (!(ODDS_DEMAND_COMPETITIONS as readonly string[]).includes(fixture.competition)) { exclude('outside_top_five'); continue; }
    if (!fixture.matchId?.trim()) { exclude('missing_match_identity'); continue; }
    if (fixture.kickoffKnown === false || (fixture.kickoffPrecision && fixture.kickoffPrecision !== 'exact')
      || (fixture.timePrecision && fixture.timePrecision !== 'exact')) { exclude('unknown_or_date_only_kickoff'); continue; }
    if (['cancelled', 'postponed', 'unknown'].includes(String(fixture.status ?? '').toLowerCase())) { exclude('fixture_not_scheduled'); continue; }
    let kickoff: string;
    try { kickoff = iso(raw); } catch { exclude('invalid_or_timezone_missing_kickoff'); continue; }
    if (new Date(Date.parse(kickoff) - 15 * MINUTE).toISOString().slice(0, 7) !== month) { exclude('outside_utc_decision_month'); continue; }
    const existing = unique.get(fixture.matchId);
    if (existing) {
      if (iso(existing.kickoffAt ?? existing.date!) !== kickoff || existing.competition !== fixture.competition) {
        conflicts.add(fixture.matchId); exclude('conflicting_duplicate_identity');
      } else exclude('duplicate_identity');
      continue;
    }
    unique.set(fixture.matchId, { ...fixture, kickoffAt: kickoff });
  }
  for (const id of conflicts) unique.delete(id);
  const grouped = new Map<string, OddsDemandGroup>();
  let completedFixtureCount = 0;
  let futureUnverifiedFixtureCount = 0;
  for (const fixture of unique.values()) {
    const kickoffAt = fixture.kickoffAt!;
    const key = `${fixture.competition}:${kickoffAt}`;
    const group = grouped.get(key) ?? { competition: fixture.competition, kickoffAt,
      decisionAt: new Date(Date.parse(kickoffAt) - 15 * MINUTE).toISOString(), fixtureIds: [], futureUnverifiedFixtureCount: 0 };
    group.fixtureIds.push(fixture.matchId);
    // An exported future ISO timestamp is not proof of an officially confirmed kickoff.
    if (Date.parse(kickoffAt) > observedAt) { group.futureUnverifiedFixtureCount++; futureUnverifiedFixtureCount++; }
    if (Number.isInteger(fixture.homeGoals) && Number.isInteger(fixture.awayGoals)
      && Number(fixture.homeGoals) >= 0 && Number(fixture.awayGoals) >= 0) completedFixtureCount++;
    grouped.set(key, group);
  }
  const groups = [...grouped.values()].sort((a, b) => a.decisionAt.localeCompare(b.decisionAt)
    || a.competition.localeCompare(b.competition));
  for (const group of groups) group.fixtureIds.sort();
  return { month, timezone: 'UTC', groupingPeriod: 'T15_decision_month_not_kickoff_month', sourceFixtureCount, eligibleFixtureCount: unique.size,
    completedFixtureCount, futureUnverifiedFixtureCount, exclusions, groups,
    calendarCompletenessVerified: false,
    futureScheduleVerified: futureUnverifiedFixtureCount === 0,
    limitation: 'Coverage refers only to eligible fixtures in this export, never an independently complete top-five calendar.' };
}

type PlannedSession = { at: string; category: 't15' | 'nightly' | 'kickoff_refresh' | 'ui' | 'event_extra';
  competition?: string; cost: number; httpRequests: number; group?: OddsDemandGroup; retry: boolean };

export function simulateOddsDemandMonth(fixtures: DemandFixture[], options: OddsDemandOptions) {
  const calendar = buildOddsDemandGroups(fixtures, options.month, options.asOf);
  const budget = integer(options.monthlyBudgetCredits ?? 500, 'monthly budget');
  const reserve = integer(options.reserveCredits ?? 50, 'reserve');
  if (reserve > budget) throw new Error('Reserve exceeds budget');
  const retryRate = options.retryRate ?? .1;
  if (!Number.isFinite(retryRate) || retryRate < 0 || retryRate > 1) throw new Error('Invalid retry rate');
  const marketCount = integer(options.marketCount ?? 3, 'market count', 1);
  const regionCount = integer(options.regionCount ?? 1, 'region count', 1);
  const cacheWindow = Math.min(300, integer(options.cacheWindowSeconds ?? 30, 'cache window'));
  const priceAge = integer(options.providerPriceAgeAtFetchSeconds ?? 0, 'provider age');
  const cacheFreshWindow = Math.max(0, Math.min(cacheWindow, 300 - priceAge)) * 1000;
  const callCost = quoteRequestCredits(marketCount, regionCount);
  const year = Number(options.month.slice(0, 4)), month = Number(options.month.slice(5, 7));
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const retryGroups = Math.ceil(calendar.groups.length * retryRate);
  const retryIndices = new Set(Array.from({ length: retryGroups }, (_, index) => Math.floor((index + 1) * calendar.groups.length / (retryGroups + 1))));
  const sessions: PlannedSession[] = [];
  for (let day = 1; day <= days; day++) {
    const dayStart = Date.UTC(year, month - 1, day);
    const at = new Date(dayStart).toISOString();
    if (options.nightlyOddsEnabled) for (const competition of ODDS_DEMAND_COMPETITIONS) sessions.push({
      at, category: 'nightly', competition, cost: callCost, httpRequests: 1, retry: false });
    const kickoffRefreshes = integer(options.kickoffRefreshesPerCompetitionPerDay ?? 0, 'kickoff refresh count');
    for (let refresh = 0; refresh < kickoffRefreshes; refresh++) for (const competition of ODDS_DEMAND_COMPETITIONS) sessions.push({
      at: new Date(dayStart + (refresh + 1) * MINUTE).toISOString(), category: 'kickoff_refresh', competition,
      cost: quoteRequestCredits(1, regionCount) + 2, httpRequests: 2, retry: false });
    const add = (category: 'ui' | 'event_extra', count: number, cost: number) => {
      integer(count, 'extra request count'); integer(cost, 'extra request credits');
      for (let index = 0; index < count; index++) sessions.push({ at: new Date(dayStart + 12 * 60 * MINUTE + index).toISOString(),
        category, cost, httpRequests: 1, retry: false });
    };
    add('ui', options.uiRequestsPerDay ?? 0, options.uiCreditsPerRequest ?? callCost);
    add('event_extra', options.eventExtraRequestsPerDay ?? 0, options.eventExtraCreditsPerRequest ?? callCost);
  }
  calendar.groups.forEach((group, index) => sessions.push({ at: group.decisionAt, category: 't15', competition: group.competition,
    group, cost: callCost * (retryIndices.has(index) ? 2 : 1), httpRequests: retryIndices.has(index) ? 2 : 1, retry: retryIndices.has(index) }));
  sessions.sort((a, b) => a.at.localeCompare(b.at) || a.category.localeCompare(b.category)
    || String(a.competition ?? '').localeCompare(String(b.competition ?? '')));
  const caches = new Map<string, number>();
  const unlimitedCaches = new Map<string, number>();
  const categoryTotals: Record<string, { credits: number; httpRequests: number; skippedSessions: number }> = {};
  const decisions: Array<{ competition: string; kickoffAt: string; fixtureIds: string[]; admitted: boolean;
    cacheHit: boolean; plannedCredits: number; reason: string | null }> = [];
  let spent = 0, plannedCredits = 0, plannedHttpRequests = 0, admittedHttpRequests = 0;
  let coveredFixtures = 0, skippedFixtures = 0, cacheHits = 0;
  for (const session of sessions) {
    const category = categoryTotals[session.category] ??= { credits: 0, httpRequests: 0, skippedSessions: 0 };
    const cachedAt = session.category === 't15' ? caches.get(session.competition!) : undefined;
    const hit = cachedAt !== undefined && Date.parse(session.at) >= cachedAt
      && Date.parse(session.at) - cachedAt <= cacheFreshWindow && priceAge <= 300;
    const unlimitedCachedAt = session.category === 't15' ? unlimitedCaches.get(session.competition!) : undefined;
    const unlimitedHit = unlimitedCachedAt !== undefined && Date.parse(session.at) >= unlimitedCachedAt
      && Date.parse(session.at) - unlimitedCachedAt <= cacheFreshWindow && priceAge <= 300;
    plannedCredits += unlimitedHit ? 0 : session.cost;
    plannedHttpRequests += unlimitedHit ? 0 : session.httpRequests;
    const fetchedAt = Date.parse(session.at) + (session.retry ? 15 * 1000 : 0);
    if ((session.category === 't15' && !unlimitedHit) || session.category === 'nightly') unlimitedCaches.set(session.competition!, fetchedAt);
    const credits = hit ? 0 : session.cost;
    const httpRequests = hit ? 0 : session.httpRequests;
    const limit = session.category === 't15' && options.reserveAppliesToT15 === false ? budget : budget - reserve;
    const admitted = spent + credits <= limit;
    if (admitted) {
      spent += credits; admittedHttpRequests += httpRequests; category.credits += credits; category.httpRequests += httpRequests;
      if (session.category === 't15') {
        if (priceAge <= 300) coveredFixtures += session.group!.fixtureIds.length;
        else skippedFixtures += session.group!.fixtureIds.length;
        if (hit) cacheHits++;
        else caches.set(session.competition!, fetchedAt);
      } else if (session.category === 'nightly') caches.set(session.competition!, fetchedAt);
    } else {
      category.skippedSessions++;
      if (session.category === 't15') skippedFixtures += session.group!.fixtureIds.length;
    }
    if (session.group) decisions.push({ competition: session.group.competition, kickoffAt: session.group.kickoffAt,
      fixtureIds: session.group.fixtureIds, admitted, cacheHit: admitted && hit, plannedCredits: credits,
      reason: !admitted ? 'monthly_budget_or_protected_reserve' : priceAge > 300 ? 'stale_price_scenario' : null });
  }
  const fixtureCount = calendar.eligibleFixtureCount;
  return { protocol: 'offline-odds-demand-v1', month: options.month, asOf: iso(options.asOf),
    budgetSource: 'nominal_scenario_not_provider_measurement', measuredQuota: null,
    calendar: { ...calendar, groups: undefined }, groupCount: calendar.groups.length, days,
    assumptions: { monthlyBudgetCredits: budget, reserveCredits: reserve, reserveAppliesToT15: options.reserveAppliesToT15 !== false,
      retryRate, retryGroups, retryScope: 't15', retryTiming: 'one retry within the 60-second window; charged planning allowance',
      marketCount, regionCount, cacheWindowSeconds: cacheWindow, providerPriceAgeAtFetchSeconds: priceAge,
      nightlyOddsEnabled: options.nightlyOddsEnabled === true, kickoffRefreshesPerCompetitionPerDay: options.kickoffRefreshesPerCompetitionPerDay ?? 0,
      uiRequestsPerDay: options.uiRequestsPerDay ?? 0, uiCreditsPerRequest: options.uiCreditsPerRequest ?? callCost,
      eventExtraRequestsPerDay: options.eventExtraRequestsPerDay ?? 0, eventExtraCreditsPerRequest: options.eventExtraCreditsPerRequest ?? callCost,
      retryAdmission: 'The charged allowance for a retrying group is reserved before admitting that group; this is an offline capacity scenario, not a failure forecast.' },
    credits: { requiredWithoutBudgetLimit: plannedCredits, admitted: spent, unused: budget - spent,
      overNominalBudget: Math.max(0, plannedCredits - budget), byCategory: categoryTotals },
    httpRequests: { requiredWithoutBudgetLimit: plannedHttpRequests, admitted: admittedHttpRequests },
    coverage: { eligibleFixtures: fixtureCount, coveredFixtures, skippedFixtures,
      fraction: fixtureCount ? coveredFixtures / fixtureCount : null, coveredGroups: decisions.filter((row) => row.admitted && row.reason === null).length,
      skippedGroups: decisions.filter((row) => !row.admitted || row.reason !== null).length, cacheHitGroups: cacheHits,
      claim: 'calendar_capacity_only_not_actual_quote_or_betting_coverage' },
    eventSpecificAlternative: { baseHttpRequests: fixtureCount, baseCredits: fixtureCount * callCost,
      retryHttpRequestsAllowance: Math.ceil(fixtureCount * retryRate),
      totalCreditsWithRetryAllowance: (fixtureCount + Math.ceil(fixtureCount * retryRate)) * callCost },
    decisions,
    limitations: ['Credits are estimated from requested markets and regions; actual provider response headers remain authoritative.',
      'No quote availability, bookmaker coverage, provider latency or source update freshness has been tested by this offline simulation.',
      'All visible fixtures are considered, independently of model recommendations or whether a bet would be placed.',
      'Future exported kickoff groups may be provisional and understate eventual demand.',
      'The retry pattern is a deterministic capacity allowance, not an estimate of real provider failure probability.',
      'UI, extra markets and kickoff refresh frequency are explicit parameters; zero is not proof those paths never run.'] };
}

export function simulateOddsDemandScenarios(fixtures: DemandFixture[], month: string, asOf: string) {
  const shared: OddsDemandOptions = { month, asOf, monthlyBudgetCredits: 500, reserveCredits: 50,
    retryRate: .1, marketCount: 3, regionCount: 1, cacheWindowSeconds: 30, providerPriceAgeAtFetchSeconds: 0 };
  const currentCallPaths = simulateOddsDemandMonth(fixtures, { ...shared, nightlyOddsEnabled: true });
  const optimizedConservative = simulateOddsDemandMonth(fixtures, { ...shared, nightlyOddsEnabled: false });
  const optimizedT15Priority = simulateOddsDemandMonth(fixtures, { ...shared, nightlyOddsEnabled: false, reserveAppliesToT15: false });
  return { month, currentCallPaths: { ...currentCallPaths, configuration: 'legacy_nightly_quotes_enabled_counterfactual',
    onDemandKickoffCallPath: { quoteCreditsPerCompetition: 1, scoreCreditsPerCompetitionWithDaysFrom: 2,
      automaticDailyFrequencyVerified: false, excludedUntilExplicitlyConfigured: true } },
    optimizedConservative, optimizedT15Priority,
    distinctFreeFallback: { status: 'BLOCKED_UNCONFIGURED', additionalProvenCoverage: 0,
      reason: 'No distinct authorized free fallback with proven three-market coverage is configured.',
      sameCapacityAs: 'optimizedConservative' },
    kickoffRefreshSensitivityOnceDaily: simulateOddsDemandMonth(fixtures, { ...shared, nightlyOddsEnabled: true,
      kickoffRefreshesPerCompetitionPerDay: 1 }),
    originalApproximation30Days: originalMonthlyApproximation() };
}

export type RemainingDemandFixture = Partial<DemandFixture> & { match_id?: string; kickoff_at?: string };
/** Admin-safe projection: current UTC decision month, no quota reads or HTTP. */
export function forecastRemainingOddsDemand(fixtures: RemainingDemandFixture[], asOf: string,
  options: { markets?: string[]; retryRate?: number; regionCount?: number; through?: string } = {}) {
  const nowIso = iso(asOf), now = Date.parse(nowIso), month = nowIso.slice(0, 7);
  const date = new Date(now);
  const nextMonth = Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1);
  const through = options.through ? Math.min(Date.parse(iso(options.through)), nextMonth) : nextMonth;
  if (through < now) throw new Error('Forecast through precedes asOf');
  const markets = [...new Set(options.markets ?? ['h2h', 'totals', 'spreads'])];
  if (!markets.length || markets.some((market) => !market.trim())) throw new Error('Forecast markets required');
  const normalized: DemandFixture[] = fixtures.map((fixture) => ({ ...fixture,
    matchId: fixture.matchId ?? fixture.match_id ?? '', competition: fixture.competition ?? '',
    kickoffAt: fixture.kickoffAt ?? fixture.kickoff_at ?? fixture.date }));
  const remaining = normalized.filter((fixture) => {
    const decision = Date.parse(fixture.kickoffAt ?? '') - 15 * MINUTE;
    return Number.isFinite(decision) && decision >= now && decision < through;
  });
  const simulation = simulateOddsDemandMonth(remaining, { month, asOf: nowIso, nightlyOddsEnabled: false,
    monthlyBudgetCredits: Number.MAX_SAFE_INTEGER, reserveCredits: 0,
    retryRate: options.retryRate ?? .1, marketCount: markets.length, regionCount: options.regionCount ?? 1 });
  return { kind: 'offline_remaining_calendar_projection', asOf: nowIso, through: new Date(through).toISOString(),
    throughExclusive: true, month, scope: 'remaining_decision_targets_in_current_utc_month',
    calendarFixtures: simulation.calendar.eligibleFixtureCount, competitionKickoffGroups: simulation.groupCount,
    estimatedCredits: simulation.credits.requiredWithoutBudgetLimit,
    estimatedHttpRequests: simulation.httpRequests.requiredWithoutBudgetLimit,
    completeCalendarVerified: false, futureKickoffsVerified: false, measuredQuota: null,
    assumptions: { markets, regionCount: options.regionCount ?? 1, retryRate: options.retryRate ?? .1,
      sharedByModels: ['A', 'C'], cacheWindowSeconds: 30,
      note: 'Nominal charged cost for available future calendar targets; not measured usage, coverage or a promise that fixture times are final.' },
    exclusions: simulation.calendar.exclusions };
}
