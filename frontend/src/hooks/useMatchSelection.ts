import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getRecentMatches, getTeams, getUpcomingMatches } from '../utils/api';
import {
  currentSeason,
  dateToDayKey,
  formatDayLabel,
} from '../components/predictions/predictionWorkbenchUtils';
import { parseMatchDateValue } from '../utils/dateTime';

export type MatchMode = 'upcoming' | 'recent';

export function useMatchSelection() {
  const listRequest = useRef(0);
  const [teams, setTeams] = useState<any[]>([]);
  const [competition, setCompetition] = useState(() => new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search).get('competition') ?? 'Serie A');
  const [season, setSeason] = useState(() => new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search).get('season') ?? currentSeason());
  const [matchMode, setMatchMode] = useState<MatchMode>(() => new URLSearchParams(typeof window === 'undefined' ? '' : window.location.search).get('mode') === 'recent' ? 'recent' : 'upcoming');
  const [upcomingLoading, setUpcomingLoading] = useState(false);
  const [upcoming, setUpcoming] = useState<any[]>([]);
  const [recentMatches, setRecentMatches] = useState<any[]>([]);
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

  const loadUpcoming = useCallback(async (force = false) => {
    const requestId = ++listRequest.current;
    setUpcomingLoading(true);
    try {
      const response = await getUpcomingMatches({
        competition: competition || undefined,
        season: season || undefined,
        limit: 160,
        includeStartedWithoutResult: true,
      }, ...(force ? [{ force: true }] : []));
      if (requestId === listRequest.current) setUpcoming(response.data ?? []);
    } catch {
      if (requestId === listRequest.current) { setUpcoming([]); setAutoSyncMsg("Impossibile aggiornare il calendario. Riprova."); }
    } finally {
      if (requestId === listRequest.current) setUpcomingLoading(false);
    }
  }, [competition, season]);

  const loadRecent = useCallback(async (force = false) => {
    const requestId = ++listRequest.current;
    setUpcomingLoading(true);
    try {
      const response = await getRecentMatches({
        competition: competition || undefined,
        season: season || undefined,
        limit: 160,
      }, ...(force ? [{ force: true }] : []));
      if (requestId === listRequest.current) setRecentMatches(response.data ?? []);
    } catch {
      if (requestId === listRequest.current) { setRecentMatches([]); setAutoSyncMsg("Impossibile aggiornare il calendario. Riprova."); }
    } finally {
      if (requestId === listRequest.current) setUpcomingLoading(false);
    }
  }, [competition, season]);

  const refreshVisibleMatches = useCallback(async (force = false) => {
    if (matchMode === 'recent') {
      await loadRecent(force);
      return;
    }
    await loadUpcoming(force);
  }, [loadRecent, loadUpcoming, matchMode]);

  useEffect(() => {
    void loadTeams();
  }, [loadTeams]);

  useEffect(() => {
    void refreshVisibleMatches();
  }, [refreshVisibleMatches]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (competition) params.set('competition', competition); else params.delete('competition');
    if (season) params.set('season', season); else params.delete('season');
    params.set('mode', matchMode);
    window.history.replaceState(window.history.state, '', `${window.location.pathname}?${params.toString()}`);
  }, [competition, season, matchMode]);

  const comps = useMemo(
    () => Array.from(new Set(['Serie A', ...teams.map((team: any) => team.competition).filter(Boolean)])),
    [teams]
  );

  const visibleMatches = useMemo(() => matchMode === 'recent'
    ? recentMatches.filter(match => match.home_goals != null && match.away_goals != null)
    : upcoming.filter(match => match.home_goals == null || match.away_goals == null), [matchMode, recentMatches, upcoming]);

  const groupedMatches = useMemo(() => {
    const grouped = new Map<string, Array<any & { __ts: number }>>();
    for (const match of visibleMatches) {
      const key = dateToDayKey(match.date);
      const bucket = grouped.get(key) ?? [];
      const parsedDate = parseMatchDateValue(match.date);
      const timestamp = parsedDate?.getTime() ?? Number.NaN;
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
    refreshVisibleMatches,
  };
}
