import { useCallback } from 'react';
import { getOddsForMatch, getPrediction } from '../utils/api';
import { sanitizePredictionForBookmakerOdds } from '../components/predictions/predictionWorkbenchUtils';

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

const getOddsErrorMessage = (error: any): string => {
  const status = Number(error?.response?.status ?? 0);
  if (status === 502 || /status code 502/i.test(String(error?.message ?? error?.response?.data?.error ?? ''))) {
    return '502 = backend/proxy non ha risposto. Controlla logs backend.';
  }

  const responseData = error?.response?.data;
  const rawMessage = responseData?.error
    ?? responseData?.message
    ?? error?.message
    ?? 'errore sconosciuto durante il caricamento quote';

  return String(rawMessage);
};

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
    const oddsPromise = getOddsForMatch({
      matchId: resolvedMatchId,
      competition: competition || 'Serie A',
      homeTeam: homeName,
      awayTeam: awayName,
      commenceTime: match?.date ? String(match.date) : null,
    })
      .then((response) => ({ response, errorMessage: null as string | null }))
      .catch((error) => ({ response: null, errorMessage: getOddsErrorMessage(error) }));

    const basePredictionResponse = await basePredictionPromise;
    const basePrediction = basePredictionResponse.data ?? null;

    if (basePrediction && onBasePrediction) {
      onBasePrediction(sanitizePredictionForBookmakerOdds(basePrediction));
    }

    const oddsResult = await oddsPromise;
    const payload = (oddsResult.response as any)?.data ?? {};
    const requestedMarkets = Array.isArray(payload.marketsRequested) ? payload.marketsRequested : [];

    let finalPrediction = basePrediction;
    let oddsMessage = '';
    let oddsTone: 'info' | 'success' | 'warning' | 'danger' = 'info';
    let appliedOdds: Record<string, string> = {};

    const providerOdds: Record<string, number> = payload?.found && payload?.selectedOdds
      ? payload.selectedOdds as Record<string, number>
      : {};
    const fallbackOdds: Record<string, number> = payload?.fallbackOdds
      ? payload.fallbackOdds as Record<string, number>
      : {};
    const source = String(payload?.source ?? payload?.oddsSource ?? '');
    const primaryProvider = String(payload?.primaryProvider ?? '');
    const usedFallbackProvider = Boolean(payload?.usedFallbackBookmaker)
      || Boolean(source && primaryProvider && source !== primaryProvider);

    const stringifyOdds = (odds: Record<string, number>) => Object.entries(odds).reduce((acc, [key, value]) => {
      const nextValue = Number(value);
      if (Number.isFinite(nextValue) && nextValue > 1) {
        acc[key] = nextValue.toFixed(2);
      }
      return acc;
    }, {} as Record<string, string>);

    if (Object.keys(providerOdds).length > 0) {
      appliedOdds = stringifyOdds(providerOdds);
      oddsMessage = payload.message ?? 'Quote bookmaker caricate.';
      oddsTone = usedFallbackProvider ? 'warning' : 'success';

      const enriched = await getPrediction({
        homeTeamId: homeId,
        awayTeamId: awayId,
        matchId: resolvedMatchId,
        competition: competition || undefined,
        bookmakerOdds: providerOdds,
      });
      if (enriched.data) {
        finalPrediction = sanitizePredictionForBookmakerOdds(
          enriched.data,
          usedFallbackProvider ? 'fallback_provider' : (payload.source ?? 'odds_api')
        );
      }
    } else if (Object.keys(fallbackOdds).length > 0) {
      appliedOdds = stringifyOdds(fallbackOdds);
      oddsMessage = 'Quote provider primario non disponibili: mostro quote provider secondario per analisi.';
      oddsTone = 'warning';

      const enriched = await getPrediction({
        homeTeamId: homeId,
        awayTeamId: awayId,
        matchId: resolvedMatchId,
        competition: competition || undefined,
        bookmakerOdds: fallbackOdds,
      });
      if (enriched.data) {
        finalPrediction = sanitizePredictionForBookmakerOdds(enriched.data, 'fallback_provider');
      }
    } else if (oddsResult.errorMessage) {
      oddsMessage = `Errore quote: ${oddsResult.errorMessage}`;
      oddsTone = 'danger';
      finalPrediction = sanitizePredictionForBookmakerOdds(finalPrediction, 'odds_unavailable');
    } else {
      oddsMessage = payload.message ?? 'Quote bookmaker non disponibili per questa partita.';
      oddsTone = 'warning';
      finalPrediction = sanitizePredictionForBookmakerOdds(finalPrediction, payload.source ?? 'odds_unavailable');
    }

    if (finalPrediction) {
      finalPrediction = sanitizePredictionForBookmakerOdds(
        finalPrediction,
        finalPrediction?.usedFallbackBookmaker ? 'fallback_provider' : (payload.source ?? finalPrediction?.oddsSource ?? null)
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
