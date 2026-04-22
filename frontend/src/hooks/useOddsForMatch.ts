import { useCallback } from 'react';
import { getEurobetOddsForMatch, getPrediction } from '../utils/api';
import { sanitizePredictionForEurobetOnly } from '../components/predictions/predictionWorkbenchUtils';

interface FetchPredictionWithOddsInput {
  competition: string;
  homeId: string;
  awayId: string;
  match: any;
  resolvedMatchId: string;
  teams: any[];
  onBasePrediction?: (prediction: any) => void;
}

export interface FetchPredictionWithOddsResult {
  finalPred: any;
  appliedOdds: Record<string, string>;
  marketsRequested: string[];
  oddsMsg: string;
  oddsTone: 'info' | 'success' | 'warning' | 'danger';
}

export function useOddsForMatch() {
  const resolveTeamName = useCallback((teamNameIndex: Map<string, string>, id: string, name?: string) => {
    if (name?.trim()) return name.trim();
    return teamNameIndex.get(id) ?? id;
  }, []);

  const fetchPredictionWithOdds = useCallback(async ({
    competition,
    homeId,
    awayId,
    match,
    resolvedMatchId,
    teams,
    onBasePrediction,
  }: FetchPredictionWithOddsInput): Promise<FetchPredictionWithOddsResult> => {
    const teamNameIndex = new Map<string, string>();
    for (const team of teams) {
      teamNameIndex.set(String(team?.team_id ?? ''), String(team?.name ?? ''));
    }

    const homeName = resolveTeamName(teamNameIndex, homeId, match.home_team_name);
    const awayName = resolveTeamName(teamNameIndex, awayId, match.away_team_name);

    const basePredictionPromise = getPrediction({
      homeTeamId: homeId,
      awayTeamId: awayId,
      matchId: resolvedMatchId,
      competition: competition || undefined,
    });
    const oddsPromise = getEurobetOddsForMatch({
      matchId: resolvedMatchId,
      competition: competition || 'Serie A',
      homeTeam: homeName,
      awayTeam: awayName,
      commenceTime: String(match.date ?? ''),
    }).catch(() => null);

    const basePredictionResponse = await basePredictionPromise;
    const basePrediction = basePredictionResponse.data ?? null;

    if (basePrediction && onBasePrediction) {
      onBasePrediction(sanitizePredictionForEurobetOnly(basePrediction));
    }

    const oddsResponse = await oddsPromise;
    const payload = (oddsResponse as any)?.data ?? {};
    const requestedMarkets = Array.isArray(payload.marketsRequested) ? payload.marketsRequested : [];

    let finalPrediction = basePrediction;
    let oddsMessage = '';
    let oddsTone: 'info' | 'success' | 'warning' | 'danger' = 'info';
    let appliedOdds: Record<string, string> = {};

    const eurobetOdds: Record<string, number> = payload?.found && payload?.selectedOdds
      ? payload.selectedOdds as Record<string, number>
      : {};
    const fallbackOdds: Record<string, number> = payload?.fallbackOdds
      ? payload.fallbackOdds as Record<string, number>
      : {};

    const stringifyOdds = (odds: Record<string, number>) => Object.entries(odds).reduce((acc, [key, value]) => {
      const nextValue = Number(value);
      if (Number.isFinite(nextValue) && nextValue > 1) {
        acc[key] = nextValue.toFixed(2);
      }
      return acc;
    }, {} as Record<string, string>);

    if (Object.keys(eurobetOdds).length > 0) {
      appliedOdds = stringifyOdds(eurobetOdds);
      oddsMessage = payload.message ?? 'Quote reali Eurobet caricate.';
      oddsTone = 'success';

      const enriched = await getPrediction({
        homeTeamId: homeId,
        awayTeamId: awayId,
        matchId: resolvedMatchId,
        competition: competition || undefined,
        bookmakerOdds: eurobetOdds,
      });
      if (enriched.data) {
        finalPrediction = sanitizePredictionForEurobetOnly(enriched.data, payload.source ?? 'eurobet_scraper');
      }
    } else if (Object.keys(fallbackOdds).length > 0) {
      appliedOdds = stringifyOdds(fallbackOdds);
      oddsMessage = 'Quote Eurobet non disponibili: mostro quote provider secondario per analisi.';
      oddsTone = 'warning';

      const enriched = await getPrediction({
        homeTeamId: homeId,
        awayTeamId: awayId,
        matchId: resolvedMatchId,
        competition: competition || undefined,
        bookmakerOdds: fallbackOdds,
      });
      if (enriched.data) {
        finalPrediction = sanitizePredictionForEurobetOnly(enriched.data, 'fallback_provider');
      }
    } else {
      oddsMessage = payload.message ?? 'Quote Eurobet non disponibili per questa partita.';
      oddsTone = 'warning';
      finalPrediction = sanitizePredictionForEurobetOnly(finalPrediction, payload.source ?? 'eurobet_unavailable');
    }

    if (finalPrediction) {
      finalPrediction = sanitizePredictionForEurobetOnly(
        finalPrediction,
        payload.source ?? finalPrediction?.oddsSource ?? null
      );
    }

    return {
      finalPred: finalPrediction,
      appliedOdds,
      marketsRequested: requestedMarkets,
      oddsMsg: oddsMessage,
      oddsTone,
    };
  }, [resolveTeamName]);

  return {
    fetchPredictionWithOdds,
  };
}
