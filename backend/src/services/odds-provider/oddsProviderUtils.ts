import { BookmakerOdds, MarketOdds, OddsMatch } from '../OddsApiService';
import { OddsProviderFixture } from './OddsProvider';

export const normalizeTeamForOdds = (name: string): string => {
  const aliases: Record<string, string> = {
    'inter milan': 'inter',
    'ac milan': 'milan',
    'hellas verona': 'verona',
    'ssc napoli': 'napoli',
    'ss lazio': 'lazio',
  };

  const cleaned = String(name ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\b(fc|ac|as|ss|ssc|calcio|club)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return aliases[cleaned] ?? cleaned;
};

export const teamSimilarity = (a: string, b: string): number => {
  const na = normalizeTeamForOdds(a);
  const nb = normalizeTeamForOdds(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
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

export const matchScore = (
  candidate: OddsMatch,
  homeTeam: string,
  awayTeam: string,
  commenceTime?: string | null
): number => {
  const straight = teamSimilarity(homeTeam, candidate.homeTeam) + teamSimilarity(awayTeam, candidate.awayTeam);
  const swapped = teamSimilarity(homeTeam, candidate.awayTeam) + teamSimilarity(awayTeam, candidate.homeTeam);
  let score = Math.max(straight, swapped);

  if (commenceTime) {
    const targetTs = new Date(commenceTime).getTime();
    const candTs = new Date(candidate.commenceTime).getTime();
    if (!Number.isNaN(targetTs) && !Number.isNaN(candTs)) {
      const diffHours = Math.abs(targetTs - candTs) / (1000 * 60 * 60);
      if (diffHours <= 1.5) score += 0.5;
      else if (diffHours <= 4) score += 0.25;
      else if (diffHours <= 12) score += 0.1;
    }
  }

  return score;
};

export const findBestMatchIndex = (
  pool: OddsMatch[],
  fixture: OddsProviderFixture,
  threshold = 1.25
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

export const matchFixturesToMatches = (
  fixtures: OddsProviderFixture[],
  matches: OddsMatch[],
  threshold = 1.25
): { matchedMatches: OddsMatch[]; missingFixtures: OddsProviderFixture[] } => {
  const available = [...matches];
  const matchedMatches: OddsMatch[] = [];
  const missingFixtures: OddsProviderFixture[] = [];

  for (const fixture of fixtures) {
    const bestIndex = findBestMatchIndex(available, fixture, threshold);
    if (bestIndex === -1) {
      missingFixtures.push(fixture);
      continue;
    }

    matchedMatches.push(available[bestIndex]);
    available.splice(bestIndex, 1);
  }

  return { matchedMatches, missingFixtures };
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
