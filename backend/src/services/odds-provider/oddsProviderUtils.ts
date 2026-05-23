import { BookmakerOdds, MarketOdds, OddsMatch } from '../OddsApiService';
import { OddsProviderFixture } from './OddsProvider';

export const MAX_FIXTURE_MATCH_WINDOW_HOURS = 36;

const TEAM_ALIAS_GROUPS: string[][] = [
  ['inter', 'internazionale', 'inter milan', 'fc internazionale milano', 'internazionale milano'],
  ['milan', 'ac milan', 'a c milan'],
  ['roma', 'as roma', 'a s roma'],
  ['lazio', 'ss lazio', 's s lazio'],
  ['napoli', 'ssc napoli', 's s c napoli'],
  ['juventus', 'juve', 'juventus fc'],
  ['psg', 'paris saint germain', 'paris sg', 'paris st germain'],
  ['manchester city', 'man city', 'mancity'],
  ['manchester united', 'man united', 'man utd'],
];

const normalizeTeamRaw = (name: string): string =>
  String(name ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[-_.']/g, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(fc|ac|as|ss|ssc|calcio|club)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const teamAliasLookup: Record<string, string> = TEAM_ALIAS_GROUPS.reduce((acc, group) => {
  const canonical = normalizeTeamRaw(group[0]);
  for (const alias of group) {
    acc[normalizeTeamRaw(alias)] = canonical;
  }
  return acc;
}, {} as Record<string, string>);

const aliasSetByCanonical = TEAM_ALIAS_GROUPS.reduce((acc, group) => {
  const canonical = normalizeTeamRaw(group[0]);
  acc[canonical] = new Set(group.map(normalizeTeamRaw).filter(Boolean));
  acc[canonical].add(canonical);
  return acc;
}, {} as Record<string, Set<string>>);

export const normalizeTeamForOdds = (name: string): string => {
  const aliases: Record<string, string> = {
    'hellas verona': 'verona',
    ...teamAliasLookup,
  };

  const cleaned = normalizeTeamRaw(name);
  return aliases[cleaned] ?? cleaned;
};

const getTeamAliases = (name: string): Set<string> => {
  const normalized = normalizeTeamForOdds(name);
  const aliases = new Set<string>([normalized]);
  for (const alias of aliasSetByCanonical[normalized] ?? []) {
    aliases.add(alias);
  }
  return aliases;
};

export const teamSimilarity = (a: string, b: string): number => {
  const na = normalizeTeamForOdds(a);
  const nb = normalizeTeamForOdds(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;

  const aliasesA = getTeamAliases(a);
  const aliasesB = getTeamAliases(b);
  for (const alias of aliasesA) {
    if (aliasesB.has(alias)) return 1;
  }

  if (na.includes(nb) || nb.includes(na)) return 0.86;

  const at = new Set(na.split(' ').filter(Boolean));
  const bt = new Set(nb.split(' ').filter(Boolean));
  if (at.size === 0 || bt.size === 0) return 0;

  let inter = 0;
  for (const token of at) {
    if (bt.has(token)) inter += 1;
  }
  return inter / Math.max(at.size, bt.size);
};

export type FixtureCandidateScore = {
  candidate: {
    matchId: string;
    homeTeam: string;
    awayTeam: string;
    commenceTime: string;
  };
  score: number;
  straightTeamScore: number;
  swappedTeamScore: number;
  timeDiffHours: number | null;
  reason: string;
  warnings: string[];
};

export const getTimeDiffHours = (candidate: OddsMatch, commenceTime?: string | null): number | null => {
  if (!commenceTime || !candidate.commenceTime) return null;
  const targetTs = Date.parse(String(commenceTime));
  const candidateTs = Date.parse(String(candidate.commenceTime));
  if (!Number.isFinite(targetTs) || !Number.isFinite(candidateTs)) return null;
  return Math.abs(targetTs - candidateTs) / (1000 * 60 * 60);
};

export const scoreFixtureCandidate = (
  candidate: OddsMatch,
  homeTeam: string,
  awayTeam: string,
  commenceTime?: string | null
): FixtureCandidateScore => {
  const homeScore = teamSimilarity(homeTeam, candidate.homeTeam);
  const awayScore = teamSimilarity(awayTeam, candidate.awayTeam);
  const straightTeamScore = homeScore + awayScore;
  const swappedTeamScore = teamSimilarity(homeTeam, candidate.awayTeam)
    + teamSimilarity(awayTeam, candidate.homeTeam);
  const timeDiffHours = getTimeDiffHours(candidate, commenceTime);
  const warnings: string[] = [];

  if (!commenceTime) {
    warnings.push('missing_commence_time_for_fixture_matching');
  }

  if (swappedTeamScore >= Math.max(straightTeamScore + 0.25, 1.65)) {
    warnings.push('home_away_inverted_candidate');
  }

  let score = straightTeamScore;
  let reason = straightTeamScore >= 1.9
    ? 'team_pair_exact_or_alias'
    : straightTeamScore >= 1.5
      ? 'team_pair_fuzzy'
      : 'team_pair_weak';

  if (timeDiffHours !== null) {
    if (timeDiffHours > MAX_FIXTURE_MATCH_WINDOW_HOURS) {
      score = 0;
      reason = 'kickoff_outside_36h_window';
    } else if (timeDiffHours <= 1.5) {
      score += 0.5;
    } else if (timeDiffHours <= 4) {
      score += 0.35;
    } else if (timeDiffHours <= 12) {
      score += 0.2;
    } else {
      score += 0.05;
    }
  }

  if (reason !== 'kickoff_outside_36h_window' && homeScore >= 0.98 && awayScore >= 0.98) {
    score += 0.15;
  }

  return {
    candidate: {
      matchId: String(candidate.matchId ?? ''),
      homeTeam: candidate.homeTeam,
      awayTeam: candidate.awayTeam,
      commenceTime: candidate.commenceTime,
    },
    score,
    straightTeamScore,
    swappedTeamScore,
    timeDiffHours,
    reason,
    warnings,
  };
};

export const matchScore = (
  candidate: OddsMatch,
  homeTeam: string,
  awayTeam: string,
  commenceTime?: string | null
): number => {
  return scoreFixtureCandidate(candidate, homeTeam, awayTeam, commenceTime).score;
};

export const findBestMatchIndex = (
  pool: OddsMatch[],
  fixture: OddsProviderFixture,
  threshold = 1.65
): number => {
  let bestIndex = -1;
  let bestScore = -1;

  pool.forEach((candidate, index) => {
    const score = matchScore(candidate, fixture.homeTeam, fixture.awayTeam, fixture.commenceTime);
    if (score > bestScore) {
      bestScore = score;
      bestIndex = index;
    }
  });

  return bestScore >= threshold ? bestIndex : -1;
};

export type FixtureMatchDiagnostic = {
  requestedFixture: OddsProviderFixture;
  matched: boolean;
  candidateCount: number;
  bestScore: number;
  matchedCandidate?: FixtureCandidateScore['candidate'];
  candidates: FixtureCandidateScore[];
  warnings: string[];
};

export const matchFixturesToMatches = (
  fixtures: OddsProviderFixture[],
  matches: OddsMatch[],
  threshold = 1.65
): {
  matchedMatches: OddsMatch[];
  missingFixtures: OddsProviderFixture[];
  diagnostics: FixtureMatchDiagnostic[];
} => {
  const available = [...matches];
  const matchedMatches: OddsMatch[] = [];
  const missingFixtures: OddsProviderFixture[] = [];
  const diagnostics: FixtureMatchDiagnostic[] = [];

  for (const fixture of fixtures) {
    const scoredCandidates: Array<{ index: number; score: FixtureCandidateScore }> = [];
    let best: { index: number; score: FixtureCandidateScore } | null = null;
    for (let index = 0; index < available.length; index += 1) {
      const score = scoreFixtureCandidate(available[index], fixture.homeTeam, fixture.awayTeam, fixture.commenceTime);
      const row = { index, score };
      scoredCandidates.push(row);
      if (!best || score.score > best.score.score) {
        best = row;
      }
    }
    scoredCandidates.sort((a, b) => b.score.score - a.score.score);
    if (!best || best.score.score < threshold) {
      missingFixtures.push(fixture);
      diagnostics.push({
        requestedFixture: fixture,
        matched: false,
        candidateCount: available.length,
        bestScore: best?.score.score ?? 0,
        candidates: scoredCandidates.slice(0, 8).map((candidate) => candidate.score),
        warnings: Array.from(new Set(scoredCandidates.flatMap((candidate) => candidate.score.warnings))),
      });
      continue;
    }

    const matched = available[best.index];
    const matchedScore = best.score;
    matchedMatches.push(matched);
    diagnostics.push({
      requestedFixture: fixture,
      matched: true,
      candidateCount: available.length,
      bestScore: matchedScore.score,
      matchedCandidate: matchedScore.candidate,
      candidates: scoredCandidates.slice(0, 8).map((candidate) => candidate.score),
      warnings: matchedScore.warnings,
    });
    available.splice(best.index, 1);
  }

  return { matchedMatches, missingFixtures, diagnostics };
};

export const mergeOddsMatchMarkets = (base: OddsMatch, extra: OddsMatch): OddsMatch => {
  const byBookmaker = new Map<string, BookmakerOdds>();

  for (const bookmaker of base.bookmakers ?? []) {
    byBookmaker.set(String(bookmaker.bookmakerKey), {
      ...bookmaker,
      markets: [...(bookmaker.markets ?? [])],
    });
  }

  for (const bookmaker of extra.bookmakers ?? []) {
    const key = String(bookmaker.bookmakerKey);
    const existing = byBookmaker.get(key);
    if (!existing) {
      byBookmaker.set(key, {
        ...bookmaker,
        markets: [...(bookmaker.markets ?? [])],
      });
      continue;
    }

    const marketMap = new Map<string, MarketOdds>();
    for (const market of existing.markets ?? []) {
      marketMap.set(String(market.marketKey), {
        ...market,
        outcomes: [...(market.outcomes ?? [])],
      });
    }

    for (const market of bookmaker.markets ?? []) {
      const marketKey = String(market.marketKey);
      const previous = marketMap.get(marketKey);
      if (!previous) {
        marketMap.set(marketKey, {
          ...market,
          outcomes: [...(market.outcomes ?? [])],
        });
        continue;
      }

      const outcomeSet = new Set<string>();
      for (const outcome of previous.outcomes ?? []) {
        outcomeSet.add(`${String(outcome.name)}|${String(outcome.point ?? '')}|${String(outcome.description ?? '')}`);
      }

      for (const outcome of market.outcomes ?? []) {
        const signature = `${String(outcome.name)}|${String(outcome.point ?? '')}|${String(outcome.description ?? '')}`;
        if (!outcomeSet.has(signature)) {
          previous.outcomes.push(outcome);
          outcomeSet.add(signature);
        }
      }

      marketMap.set(marketKey, previous);
    }

    existing.markets = Array.from(marketMap.values());
    byBookmaker.set(key, existing);
  }

  return {
    ...base,
    bookmakers: Array.from(byBookmaker.values()),
  };
};

export const collectMarketSources = (
  providerMatches: Record<string, OddsMatch | null | undefined>
): Record<string, string[]> => {
  const marketSources = new Map<string, Set<string>>();

  for (const [providerName, match] of Object.entries(providerMatches)) {
    for (const bookmaker of match?.bookmakers ?? []) {
      for (const market of bookmaker.markets ?? []) {
        const key = String(market.marketKey ?? '').trim();
        if (!key) continue;
        if (!marketSources.has(key)) {
          marketSources.set(key, new Set<string>());
        }
        marketSources.get(key)?.add(providerName);
      }
    }
  }

  return Object.fromEntries(
    Array.from(marketSources.entries()).map(([marketKey, providers]) => [marketKey, Array.from(providers)])
  );
};
