import { useCallback, useEffect, useRef, useState } from 'react';
import { getMatchModelAdvice, MatchModelAdviceData } from '../utils/matchModelAdviceApi';
import { ChallengerPreview, getChallengerPreview } from '../utils/challengerPreviewApi';

export interface ModelAdviceState {
  matchId: string; data?: MatchModelAdviceData; error?: string; loading: boolean;
  preview?: ChallengerPreview; previewLoading?: boolean; previewError?: string; ineligible?: boolean;
}
export interface AdviceMatch { matchId: string; kickoffAt?: string; finished?: boolean }

/** One owner for archive and C preview. A may start only after this settles. */
export function useMatchModelAdvice() {
  const [state, setState] = useState<ModelAdviceState>({ matchId: '', loading: false });
  const request = useRef<AbortController | null>(null);
  const currentMatch = useRef<AdviceMatch | null>(null);
  const cancel = useCallback(() => { request.current?.abort(); request.current = null; }, []);
  useEffect(() => cancel, [cancel]);
  const prepare = useCallback(async (match: AdviceMatch) => {
    cancel();
    currentMatch.current = match;
    const controller = new AbortController();
    request.current = controller;
    const active = () => request.current === controller && !controller.signal.aborted;
    const { matchId, kickoffAt, finished } = match;
    setState({ matchId, loading: true });
    try {
      const data = await getMatchModelAdvice(matchId, controller.signal);
      if (!active()) return;
      const ineligible = !!finished || (kickoffAt !== undefined && (!Number.isFinite(Date.parse(kickoffAt)) || Date.parse(kickoffAt) <= Date.now()));
      const needsPreview = !data.C && !data.errors.C && !ineligible;
      setState({ matchId, data, loading: false, previewLoading: needsPreview, ineligible });
      if (!needsPreview) return;
      try {
        const preview = await getChallengerPreview(matchId, controller.signal);
        if (!active()) return;
        if (preview.status === 'ARCHIVED') {
          const recorded = await getMatchModelAdvice(matchId, controller.signal);
          if (!active()) return;
          setState({ matchId, data: recorded, loading: false, ...(recorded.C ? {} : {
            previewError: 'La decisione archiviata non è ancora leggibile. Riprova i consigli della partita.',
          }) });
          return;
        }
        setState({ matchId, data, loading: false, preview });
      } catch {
        if (active()) setState({ matchId, data, loading: false, previewError: 'Impossibile caricare l’anteprima del modello C.' });
      }
    } catch {
      if (active()) setState({ matchId, error: 'Impossibile caricare i consigli archiviati.', loading: false });
    }
  }, [cancel]);
  const retry = useCallback(() => { if (currentMatch.current) void prepare(currentMatch.current); }, [prepare]);
  return { state, prepare, retry, cancel };
}
export type ModelAdviceCoordinator = ReturnType<typeof useMatchModelAdvice>;
