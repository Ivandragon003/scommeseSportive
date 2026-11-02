import { useCallback, useEffect, useRef, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { getOddsForMatch } from '../../utils/api';
import { getErrorMessage } from '../../utils/errorUtils';

// Suppress repeated credit requests when switching tabs; failures remain manually retryable.
const attemptedAt = new Map<string, number>();
const RETRY_WINDOW = 5 * 60_000;
export default function MatchQuoteRequest({ match, onLoaded, ready = true, hasQuotes = false }: {
  match: any; onLoaded: () => void; ready?: boolean; hasQuotes?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const request = useRef<AbortController | null>(null);
  const loaded = useRef(onLoaded); loaded.current = onLoaded;
  const { match_id: matchId, competition, home_team_name: homeTeam, away_team_name: awayTeam, date } = match;
  const load = useCallback(async () => {
    if (request.current) return;
    const controller = new AbortController(); request.current = controller;
    attemptedAt.set(matchId, Date.now());
    setBusy(true); setMessage('');
    try {
      const response = await getOddsForMatch({ matchId, competition, homeTeam, awayTeam, commenceTime: date,
        cacheOnly: false, requestNetwork: true }, { signal: controller.signal });
      if (controller.signal.aborted) return;
      if (response.data?.found && response.data?.source === 'odds_api') {
        setMessage('Quote disponibili. Aggiornamento dei consigli…'); loaded.current();
      } else setMessage('Quote non disponibili per questa partita. Puoi riprovare più tardi.');
    } catch (error) {
      if (!controller.signal.aborted) setMessage(getErrorMessage(error, 'Recupero quote non riuscito. Puoi riprovare.'));
    } finally { if (!controller.signal.aborted) { setBusy(false); request.current = null; } }
  }, [matchId, competition, homeTeam, awayTeam, date]);
  useEffect(() => {
    if (!ready || hasQuotes || Date.now() - (attemptedAt.get(matchId) ?? 0) < RETRY_WINDOW) return;
    // Scheduling also prevents StrictMode's effect rehearsal from issuing a paid request.
    const timer = setTimeout(() => { void load(); }, 0);
    return () => clearTimeout(timer);
  }, [ready, hasQuotes, matchId, load]);
  useEffect(() => () => { request.current?.abort(); }, []);
  if (hasQuotes && !busy) return <p className="match-quotes-ready" role="status">Quote reali disponibili per la valutazione.</p>;
  return <section className="match-quote-request" aria-label="Stato quote della partita" aria-busy={busy}>
    <div><h3>{busy ? 'Verifica delle quote in corso' : !ready ? 'Preparazione dei consigli' : 'Quote della partita'}</h3>
      <p role="status">{message || (busy ? 'Recupero per questa partita, senza aggiornamenti continui.' : !ready ? 'Attendo il completamento dell’analisi.' : 'Controllo automatico all’apertura delle giocate. Usa i crediti del provider solo se serve.')}</p></div>
    {ready && !busy && <button type="button" className="fp-btn fp-btn-ghost" onClick={() => void load()}><RefreshCw size={15} aria-hidden="true" />Riprova quote</button>}
  </section>;
}
