export type PlayerLineupStatus =
  | 'predicted_starter'
  | 'predicted_bench'
  | 'confirmed_starter'
  | 'confirmed_bench'
  | 'unavailable';

export type PlayerLineupAssessment = {
  probability: number;
  tier: 'probable_starter' | 'ballotaggio' | 'uncertain' | 'confirmed_starter' | 'confirmed_bench' | 'unavailable';
  status: PlayerLineupStatus | 'modelled';
  warnings: string[];
};

const clamp = (value: number, min: number, max: number): number => Math.min(max, Math.max(min, value));

export type PositionGroup = 'GK' | 'DF' | 'MF' | 'FW';

export type OfficialLineupHistoryRow = {
  matchId: string;
  playerId: string;
  status: 'confirmed_starter' | 'confirmed_bench';
  playedAt: string;
};

export type PredictedLineupPlayer = {
  playerId: string;
  teamId: string;
  name: string;
  positionGroup: PositionGroup;
  probability: number;
  status: 'predicted_starter' | 'predicted_bench';
  recentStarts: number;
};

export type PredictedLineup = {
  starters: PredictedLineupPlayer[];
  bench: PredictedLineupPlayer[];
  formation: string | null;
  historyMatchesUsed: number;
  incomplete: boolean;
  warnings: string[];
};

export function completeOfficialTeamIds(rows: any[], expectedStarters = 11): Set<string> {
  const startersByTeam = new Map<string, Set<string>>();
  for (const row of rows ?? []) {
    if (String(row?.status ?? '') !== 'confirmed_starter') continue;
    const teamId = String(row?.team_id ?? row?.teamId ?? '').trim();
    const playerId = String(row?.player_id ?? row?.playerId ?? '').trim();
    if (!teamId || !playerId) continue;
    if (!startersByTeam.has(teamId)) startersByTeam.set(teamId, new Set());
    startersByTeam.get(teamId)!.add(playerId);
  }
  return new Set([...startersByTeam.entries()]
    .filter(([, playerIds]) => playerIds.size === expectedStarters)
    .map(([teamId]) => teamId));
}

export function retainCompleteOfficialLineupRows(rows: any[]): any[] {
  const completeTeams = completeOfficialTeamIds(rows);
  return (rows ?? []).filter((row: any) => completeTeams.has(String(row?.team_id ?? row?.teamId ?? '')));
}

function parseRawJson(value: unknown): Record<string, any> | null {
  if (value && typeof value === 'object') return value as Record<string, any>;
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' ? parsed as Record<string, any> : null;
  } catch {
    return null;
  }
}

/**
 * Converte i roster post-partita Understat in evidenza storica ufficiale.
 * Le righe vengono filtrate rigorosamente prima del kickoff target e limitate
 * alle cinque gare piu recenti, evitando leakage nei backtest.
 */
export function extractOfficialLineupHistory(
  matches: any[],
  teamId: string,
  beforeKickoff: string,
  limitMatches = 5,
): OfficialLineupHistoryRow[] {
  const cutoff = Date.parse(beforeKickoff);
  if (!Number.isFinite(cutoff)) return [];
  const recent = matches
    .filter((match) => {
      const playedAt = Date.parse(String(match?.date ?? ''));
      return Number.isFinite(playedAt)
        && playedAt < cutoff
        && match?.home_goals != null
        && match?.away_goals != null
        && (String(match?.home_team_id ?? '') === teamId || String(match?.away_team_id ?? '') === teamId);
    })
    .sort((left, right) => Date.parse(String(right.date)) - Date.parse(String(left.date)))
    .map((match) => {
      const raw = parseRawJson(match?.raw_json);
      const side = String(match?.home_team_id ?? '') === teamId ? 'h' : 'a';
      const roster = raw?.details?.rosters?.[side];
      return { match, roster };
    })
    .filter(({ roster }) => Boolean(roster && typeof roster === 'object' && Object.keys(roster).length > 0))
    .slice(0, Math.max(1, Math.trunc(limitMatches)));

  const rows: OfficialLineupHistoryRow[] = [];
  for (const { match, roster } of recent) {
    for (const entry of Object.values(roster) as any[]) {
      const rawId = String(entry?.player_id ?? entry?.playerId ?? '').trim();
      const name = String(entry?.player ?? entry?.playerName ?? '').trim();
      if (!rawId && !name) continue;
      const playerId = rawId
        ? `understat_player_${rawId}`
        : `understat_player_${name.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_]/g, '')}`;
      const rosterIn = Number(entry?.roster_in ?? entry?.rosterIn ?? 0);
      const position = String(entry?.position ?? '').trim().toLowerCase();
      const started = (!Number.isFinite(rosterIn) || rosterIn <= 0) && !/^sub/.test(position);
      rows.push({
        matchId: String(match.match_id),
        playerId,
        status: started ? 'confirmed_starter' : 'confirmed_bench',
        playedAt: String(match.date),
      });
    }
  }
  return rows;
}

export function normalizePositionGroup(value: unknown): PositionGroup {
  const code = String(value ?? '').trim().toUpperCase();
  if (/^(GK|G|GOALKEEPER|PORTIERE)/.test(code)) return 'GK';
  if (/^(DF|D|DC|DL|DR|DEF)/.test(code)) return 'DF';
  if (/^(FW|F|ST|CF|LW|RW|ATT)/.test(code)) return 'FW';
  return 'MF';
}

/**
 * Probabile XI basato sulle ultime cinque formazioni ufficiali precedenti.
 * Se un ruolo di movimento è corto, completa dal depth chart; il portiere non
 * viene mai inventato o sostituito con un giocatore di movimento.
 */
export function buildPredictedLineup(
  players: any[],
  historyRows: OfficialLineupHistoryRow[],
  unavailablePlayerIds: Set<string>,
): PredictedLineup {
  const matchDates = new Map<string, number>();
  for (const row of historyRows) {
    const timestamp = Date.parse(row.playedAt);
    if (!Number.isFinite(timestamp)) continue;
    matchDates.set(row.matchId, Math.max(timestamp, matchDates.get(row.matchId) ?? -Infinity));
  }
  const recentMatchIds = [...matchDates.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([matchId]) => matchId);
  const matchWeight = new Map(recentMatchIds.map((matchId, index) => [matchId, 5 - index]));
  const totalWeight = [...matchWeight.values()].reduce((sum, value) => sum + value, 0);
  const recentRows = historyRows.filter((row) => matchWeight.has(row.matchId));

  const candidates = players
    .filter((player) => {
      const playerId = String(player?.player_id ?? player?.playerId ?? '').trim();
      const available = player?.is_available ?? player?.isAvailable ?? 1;
      return playerId && Number(available) !== 0 && !unavailablePlayerIds.has(playerId);
    })
    .map((player): PredictedLineupPlayer & { score: number } => {
      const playerId = String(player?.player_id ?? player?.playerId);
      const starts = recentRows.filter((row) => row.playerId === playerId && row.status === 'confirmed_starter');
      const weightedStarts = starts.reduce((sum, row) => sum + Number(matchWeight.get(row.matchId) ?? 0), 0);
      const historicalSignal = totalWeight > 0 ? weightedStarts / totalWeight : 0;
      const baseline = estimateStartingProbability(player);
      const probability = recentMatchIds.length > 0
        ? clamp(0.15 + historicalSignal * 0.70 + baseline * 0.15, 0.05, 0.97)
        : baseline;
      return {
        playerId,
        teamId: String(player?.team_id ?? player?.teamId ?? ''),
        name: String(player?.name ?? player?.playerName ?? 'Unknown'),
        positionGroup: normalizePositionGroup(player?.position_code ?? player?.positionCode),
        probability: Number(probability.toFixed(4)),
        status: 'predicted_bench',
        recentStarts: starts.length,
        score: probability,
      };
    })
    .sort((left, right) => right.score - left.score || right.recentStarts - left.recentStarts || left.name.localeCompare(right.name));

  const selected = new Map<string, PredictedLineupPlayer & { score: number }>();
  const take = (group: PositionGroup, count: number) => {
    candidates.filter((candidate) => candidate.positionGroup === group && !selected.has(candidate.playerId))
      .slice(0, count)
      .forEach((candidate) => selected.set(candidate.playerId, candidate));
  };
  take('GK', 1);
  take('DF', 4);
  take('MF', 3);
  take('FW', 3);

  // Fallback per ruoli di movimento: mantiene undici nomi validi quando il
  // provider etichetta un esterno in modo diverso, senza falsificare il GK.
  if (selected.size < 11 && [...selected.values()].some((candidate) => candidate.positionGroup === 'GK')) {
    candidates
      .filter((candidate) => candidate.positionGroup !== 'GK' && !selected.has(candidate.playerId))
      .slice(0, 11 - selected.size)
      .forEach((candidate) => selected.set(candidate.playerId, candidate));
  }

  const starters = [...selected.values()].map(({ score: _score, ...candidate }) => ({
    ...candidate,
    status: 'predicted_starter' as const,
  }));
  const bench = candidates
    .filter((candidate) => !selected.has(candidate.playerId))
    .map(({ score: _score, ...candidate }) => candidate);
  const hasGoalkeeper = starters.some((player) => player.positionGroup === 'GK');
  const warnings = [
    ...(recentMatchIds.length === 0 ? ['lineup_history_unavailable'] : []),
    ...(!hasGoalkeeper ? ['lineup_missing_goalkeeper'] : []),
    ...(starters.length < 11 ? ['lineup_incomplete'] : []),
  ];
  const counts = (group: PositionGroup) => starters.filter((player) => player.positionGroup === group).length;
  return {
    starters,
    bench,
    formation: hasGoalkeeper ? `${counts('DF')}-${counts('MF')}-${counts('FW')}` : null,
    historyMatchesUsed: recentMatchIds.length,
    incomplete: starters.length < 11 || !hasGoalkeeper,
    warnings,
  };
}

/**
 * Deterministic fallback used until a provider returns a fixture-specific lineup.
 * It is intentionally conservative: historical minutes are evidence of usage,
 * not proof that the player starts this particular fixture.
 */
export function estimateStartingProbability(player: any): number {
  const avgMinutes = clamp(Number(player?.avg_minutes ?? player?.avgMinutes ?? 0) || 0, 0, 90);
  const games = clamp(Number(player?.games_played ?? player?.gamesPlayed ?? 0) || 0, 0, 15);
  const minutesSignal = avgMinutes / 90;
  const sampleSignal = games / 15;
  let probability = 0.34 + minutesSignal * 0.48 + sampleSignal * 0.10;
  if (avgMinutes < 45) probability -= 0.18;
  if (avgMinutes >= 75) probability += 0.05;
  return Number(clamp(probability, 0.05, 0.92).toFixed(4));
}

export function assessPlayerLineup(player: any, external?: { status?: PlayerLineupStatus; probability?: number }): PlayerLineupAssessment {
  const status = external?.status;
  if (status === 'confirmed_starter') {
    return { probability: 1, tier: 'confirmed_starter', status, warnings: [] };
  }
  if (status === 'confirmed_bench') {
    return { probability: 0, tier: 'confirmed_bench', status, warnings: ['confirmed_on_bench'] };
  }
  if (status === 'unavailable') {
    return { probability: 0, tier: 'unavailable', status, warnings: ['player_unavailable'] };
  }
  if (status === 'predicted_starter' || status === 'predicted_bench') {
    const probability = clamp(Number(external?.probability ?? 0), 0, 1);
    if (status === 'predicted_bench') {
      return { probability, tier: 'uncertain', status, warnings: ['predicted_bench'] };
    }
    return {
      probability,
      tier: probability >= 0.85 ? 'probable_starter' : probability >= 0.70 ? 'ballotaggio' : 'uncertain',
      status,
      warnings: probability >= 0.85 ? [] : ['lineup_prediction_uncertain'],
    };
  }
  const probability = estimateStartingProbability(player);
  return {
    probability,
    tier: probability >= 0.85 ? 'probable_starter' : probability >= 0.70 ? 'ballotaggio' : 'uncertain',
    status: 'modelled',
    warnings: ['lineup_modelled_not_confirmed', ...(probability < 0.85 ? ['lineup_prediction_uncertain'] : [])],
  };
}
