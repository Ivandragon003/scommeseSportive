import { useCallback, useEffect, useMemo, useState } from 'react';
import { getMatchdayMap, getRecentMatches, getTeams, getUpcomingMatches } from '../utils/api';
import {
  currentSeason,
  dateToDayKey,
  formatDayLabel,
} from '../components/predictions/predictionWorkbenchUtils';

export type MatchMode = 'upcoming' | 'recent';

export function useMatchSelection() {
  const [teams, setTeams] = useState<any[]>([]);
  const [competition, setCompetition] = useState('Serie A');
  const [season, setSeason] = useState(currentSeason());
  const [matchMode, setMatchMode] = useState<MatchMode>('upcoming');
  const [upcomingLoading, setUpcomingLoading] = useState(false);
  const [upcoming, setUpcoming] = useState<any[]>([]);
  const [recentMatches, setRecentMatches] = useState<any[]>([]);
  const [matchdayMap, setMatchdayMap] = useState<Record<string, number>>({});
  const [activeMatchId, setActiveMatchId] = useState<string | null>(null);
  const [tab, setTab] = useState('1x2');
  const [autoSyncMsg, setAutoSyncMsg] = useState('');

  const loadTeams = useCallback(async () => {
    try {
      const response = await getTeams();
      setTeams(response.data ?? []);
    } catch {
      setTeams([]);
    }
  }, []);

  const loadUpcoming = useCallback(async () => {
    setUpcomingLoading(true);
    try {
      const response = await getUpcomingMatches({
        competition: competition || undefined,
        season: season || undefined,
        limit: 160,
      });
      setUpcoming(response.data ?? []);
    } catch {
      setUpcoming([]);
    } finally {
      setUpcomingLoading(false);
    }
  }, [competition, season]);

  const loadRecent = useCallback(async () => {
    setUpcomingLoading(true);
    try {
      const response = await getRecentMatches({
        competition: competition || undefined,
        season: season || undefined,
        limit: 160,
      });
      setRecentMatches(response.data ?? []);
    } catch {
      setRecentMatches([]);
    } finally {
      setUpcomingLoading(false);
    }
  }, [competition, season]);

  const loadMatchdays = useCallback(async () => {
    if (!season?.trim()) {
      setMatchdayMap({});
      return;
    }
    try {
      const response = await getMatchdayMap({
        competition: 'Serie A',
        season: season.trim(),
        matchesPerMatchday: 10,
      });
      setMatchdayMap(response.data ?? {});
    } catch {
      setMatchdayMap({});
    }
  }, [season]);

  const refreshVisibleMatches = useCallback(async () => {
    if (matchMode === 'recent') {
      await loadRecent();
      return;
    }
    await loadUpcoming();
  }, [loadRecent, loadUpcoming, matchMode]);

  useEffect(() => {
    void loadTeams();
  }, [loadTeams]);

  useEffect(() => {
    void refreshVisibleMatches();
  }, [refreshVisibleMatches]);

  useEffect(() => {
    void loadMatchdays();
  }, [loadMatchdays]);

  const comps = useMemo(
    () => Array.from(new Set(['Serie A', ...teams.map((team: any) => team.competition).filter(Boolean)])),
    [teams]
  );

  const visibleMatches = useMemo(
    () => (matchMode === 'recent' ? recentMatches : upcoming),
    [matchMode, recentMatches, upcoming]
  );

  const groupedMatches = useMemo(() => {
    const grouped = new Map<string, Array<any & { __ts: number }>>();
    for (const match of visibleMatches) {
      const key = dateToDayKey(match.date);
      const bucket = grouped.get(key) ?? [];
      const timestamp = new Date(match.date).getTime();
      bucket.push({
        ...match,
        __ts: Number.isFinite(timestamp) ? timestamp : 0,
      });
      grouped.set(key, bucket);
    }

    return Array.from(grouped.entries())
      .sort(([a], [b]) => {
        if (a === 'unknown') return 1;
        if (b === 'unknown') return -1;
        return matchMode === 'recent' ? b.localeCompare(a) : a.localeCompare(b);
      })
      .map(([key, matches]) => ({
        key,
        label: formatDayLabel(key),
        matches: [...matches].sort((left: any, right: any) =>
          matchMode === 'recent'
            ? right.__ts - left.__ts
            : left.__ts - right.__ts
        ).map(({ __ts, ...match }) => match),
      }));
  }, [visibleMatches, matchMode]);

  const activeMatchRow = useMemo(() => {
    const matchIndex = new Map<string, any>();
    for (const match of visibleMatches) {
      matchIndex.set(String(match.match_id ?? ''), match);
    }
    return matchIndex.get(String(activeMatchId ?? '')) ?? null;
  }, [activeMatchId, visibleMatches]);

  return {
    teams,
    competition,
    season,
    matchMode,
    upcomingLoading,
    upcoming,
    recentMatches,
    matchdayMap,
    activeMatchId,
    tab,
    autoSyncMsg,
    comps,
    visibleMatches,
    groupedMatches,
    activeMatchRow,
    setCompetition,
    setSeason,
    setMatchMode,
    setActiveMatchId,
    setTab,
    setAutoSyncMsg,
    loadTeams,
    loadUpcoming,
    loadRecent,
    loadMatchdays,
    refreshVisibleMatches,
  };
}
