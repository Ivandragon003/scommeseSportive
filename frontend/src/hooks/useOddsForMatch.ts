import { useCallback } from 'react';
import { getOddsForMatch, getPrediction, refreshPlayerAvailability } from '../utils/api';
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
  bookmakerBySelection: Record<string, string>;
  analysisBookmakers: string[];
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

    // Fetch odds first. Starting a base prediction in parallel used to make the
    // UI issue a second full model run whenever real odds arrived.
    const oddsResult = await getOddsForMatch({
      matchId: resolvedMatchId,
      competition: competition || 'Serie A',
      homeTeam: homeName,
      awayTeam: awayName,
      commenceTime: match?.date ? String(match.date) : null,
    })
      .then((response) => ({ response, errorMessage: null as string | null }))
      .catch((error) => ({ response: null, errorMessage: getOddsErrorMessage(error) }));
    const payload = (oddsResult.response as any)?.data ?? {};
    const requestedMarkets = Array.isArray(payload.marketsRequested) ? payload.marketsRequested : [];

    let oddsMessage = '';
    let oddsTone: 'info' | 'success' | 'warning' | 'danger' = 'info';
    let appliedOdds: Record<string, string> = {};

    const providerOdds: Record<string, number> = payload?.found && (payload?.analysisOdds || payload?.selectedOdds)
      ? (payload.analysisOdds ?? payload.selectedOdds) as Record<string, number>
      : {};
    const bookmakerBySelection: Record<string, string> = payload?.bookmakerBySelection
      && typeof payload.bookmakerBySelection === 'object'
      ? payload.bookmakerBySelection as Record<string, string>
      : {};
    const analysisBookmakers = Array.isArray(payload?.analysisBookmakers)
      ? payload.analysisBookmakers.map(String).map((name: string) => name.trim()).filter(Boolean)
      : Array.from(new Set(Object.values(bookmakerBySelection).map(String).map((name) => name.trim()).filter(Boolean)));
    const fallbackOdds: Record<string, number> = payload?.fallbackOdds
      ? payload.fallbackOdds as Record<string, number>
      : {};
    const source = String(payload?.source ?? payload?.oddsSource ?? '');
    const selectedBookmakerName = String(payload?.selectedBookmakerName ?? '').trim();
    const verifiedBookmakerLabel = analysisBookmakers.length > 1
      ? `${analysisBookmakers.length} bookmaker reali`
      : (analysisBookmakers[0] ?? selectedBookmakerName);
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

    const hasVerifiedRealBookmakerOdds =
      Object.keys(providerOdds).length > 0
      && source === 'odds_api'
      && !usedFallbackProvider
      && Boolean(verifiedBookmakerLabel);

    // Close to kickoff this replaces the predicted XI with the official one
    // before player props are evaluated. Outside that window the endpoint is
    // a cheap no-op; provider errors do not block the team prediction.
    await Promise.resolve(refreshPlayerAvailability(resolvedMatchId)).catch(() => undefined);
    const predictionResponse = await getPrediction({
      homeTeamId: homeId,
      awayTeamId: awayId,
      matchId: resolvedMatchId,
      competition: competition || undefined,
      ...(hasVerifiedRealBookmakerOdds
        ? { bookmakerOdds: providerOdds, bookmakerBySelection, oddsSource: source || 'unknown' }
        : {}),
    });
    const basePrediction = predictionResponse.data ?? null;
    if (basePrediction && onBasePrediction) {
      onBasePrediction(sanitizePredictionForBookmakerOdds(basePrediction));
    }
    let finalPrediction = basePrediction;

    if (hasVerifiedRealBookmakerOdds) {
      appliedOdds = stringifyOdds(providerOdds);
      const realProvider = String(payload?.selectedProvider ?? payload?.activeProvider ?? source ?? '').trim();
      oddsMessage = `${payload.message ?? `Quote bookmaker reali caricate${realProvider ? ` (${realProvider})` : ''}.`} ${analysisBookmakers.length > 1 ? `Copertura combinata da ${analysisBookmakers.length} bookmaker.` : ''}`.trim();
      oddsTone = 'success';

      finalPrediction = sanitizePredictionForBookmakerOdds(basePrediction, 'odds_api', verifiedBookmakerLabel);
    } else if (Object.keys(providerOdds).length > 0 || Object.keys(fallbackOdds).length > 0) {
      oddsMessage = 'Quote bookmaker reali non disponibili. Le quote di fallback restano interne e non vengono mostrate.';
      oddsTone = 'warning';
      finalPrediction = sanitizePredictionForBookmakerOdds(finalPrediction, 'fallback_provider');
    } else if (oddsResult.errorMessage) {
      oddsMessage = `Errore quote: ${oddsResult.errorMessage}`;
      oddsTone = 'danger';
      finalPrediction = sanitizePredictionForBookmakerOdds(finalPrediction, 'odds_unavailable');
    } else {
      oddsMessage = payload.message ?? 'Quote bookmaker reali non disponibili per questa partita.';
      oddsTone = 'warning';
      finalPrediction = sanitizePredictionForBookmakerOdds(finalPrediction, payload.source ?? 'odds_unavailable');
    }

    if (finalPrediction) {
      finalPrediction = sanitizePredictionForBookmakerOdds(
        finalPrediction,
        finalPrediction?.usedFallbackBookmaker ? 'fallback_provider' : (payload.source ?? finalPrediction?.oddsSource ?? null),
        verifiedBookmakerLabel
      );
    }

    return {
      finalPred: finalPrediction,
      appliedOdds,
      bookmakerBySelection,
      analysisBookmakers,
      marketsRequested: requestedMarkets,
      oddsMsg: oddsMessage,
      oddsTone,
    };
  }, [resolveTeamName]);

  return {
    fetchPredictionWithOdds,
  };
}
