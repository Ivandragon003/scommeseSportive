import React, { useEffect, useMemo, useState } from 'react';
import {
  getPlayerAvailability,
  PLAYER_AVAILABILITY_UPDATED_EVENT,
  refreshPlayerAvailability,
} from '../../utils/api';

type LineupPlayer = {
  playerId: string;
  name: string;
  teamName?: string;
  probability: number;
  tier: string;
  status: string;
  source: string;
  warnings?: string[];
};

type LineupData = {
  home: LineupPlayer[];
  away: LineupPlayer[];
  hasConfirmedLineup: boolean;
  hasProviderData: boolean;
  homeFormation?: string | null;
  awayFormation?: string | null;
  homeHistoryMatchesUsed?: number;
  awayHistoryMatchesUsed?: number;
  homeIncomplete?: boolean;
  awayIncomplete?: boolean;
  homeUnavailableCount?: number;
  awayUnavailableCount?: number;
  kickoff?: string;
  warnings?: string[];
  note: string;
};

const tierLabel: Record<string, string> = {
  confirmed_starter: 'Titolare confermato',
  confirmed_bench: 'Panchina confermata',
  probable_starter: 'Titolare probabile',
  ballotaggio: 'Ballottaggio',
  uncertain: 'Incerto',
  unavailable: 'Indisponibile',
};

const OFFICIAL_LINEUP_WINDOW_MS = 150 * 60 * 1000;
const LINEUP_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

const LineupColumn: React.FC<{ title: string; players: LineupPlayer[] }> = ({ title, players }) => (
  <div className="lineup-panel__column">
    <h4>{title}</h4>
    <div className="lineup-panel__list">
      {players.length === 0 ? <div className="lineup-panel__empty">Dati rosa non disponibili</div> : players.map((player) => (
        <div className={`lineup-player lineup-player--${player.tier}`} key={player.playerId}>
          <div>
            <strong>{player.name}</strong>
            <span>{tierLabel[player.tier] ?? player.tier}</span>
          </div>
          <b>{Math.round(player.probability * 100)}%</b>
        </div>
      ))}
    </div>
  </div>
);

const LineupPanel: React.FC<{ matchId?: string }> = ({ matchId }) => {
  const [data, setData] = useState<LineupData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!matchId) return undefined;
    let active = true;
    let requestSequence = 0;
    const load = () => {
      const requestId = ++requestSequence;
      setLoading(true);
      setError('');
      Promise.resolve(getPlayerAvailability(matchId))
        .then((response) => {
          if (active && requestId === requestSequence) setData(response?.data ?? null);
        })
        .catch(() => {
          if (active && requestId === requestSequence) setError('Formazioni non disponibili al momento.');
        })
        .finally(() => {
          if (active && requestId === requestSequence) setLoading(false);
        });
    };
    const onAvailabilityUpdated = (event: Event) => {
      const updatedMatchId = (event as CustomEvent<{ matchId?: string }>).detail?.matchId;
      if (updatedMatchId === matchId) load();
    };
    load();
    window.addEventListener(PLAYER_AVAILABILITY_UPDATED_EVENT, onAvailabilityUpdated);
    return () => {
      active = false;
      window.removeEventListener(PLAYER_AVAILABILITY_UPDATED_EVENT, onAvailabilityUpdated);
    };
  }, [matchId]);

  useEffect(() => {
    if (!matchId || !data?.kickoff || data.hasConfirmedLineup) return undefined;
    const kickoff = Date.parse(data.kickoff);
    const remaining = kickoff - Date.now();
    if (!Number.isFinite(kickoff) || remaining < 0 || remaining > OFFICIAL_LINEUP_WINDOW_MS) return undefined;

    const refresh = () => {
      // The endpoint applies its own cooldown and emits the event that reloads
      // this panel. A failed provider must not make the probable lineup vanish.
      void Promise.resolve(refreshPlayerAvailability(matchId)).catch(() => undefined);
    };
    refresh();
    const intervalId = window.setInterval(refresh, LINEUP_REFRESH_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [data?.hasConfirmedLineup, data?.kickoff, matchId]);

  const summary = useMemo(() => {
    if (!data) return '';
    if (data.hasConfirmedLineup) return 'Formazione ufficiale ricevuta: le player bet possono essere rivalutate.';
    if (data.hasProviderData) return 'Indisponibilità aggiornate da API-Football; titolarità ancora stimata.';
    const used = Math.min(data.homeHistoryMatchesUsed ?? 0, data.awayHistoryMatchesUsed ?? 0);
    return `Stima interna sulle ultime ${used || 0} formazioni ufficiali, con indisponibili esclusi e fallback per ruolo.`;
  }, [data]);

  return (
    <section className="lineup-panel" aria-label="Formazioni probabili">
      <div className="lineup-panel__head">
        <div><span className="lineup-panel__eyebrow">FORMAZIONI</span><h3>Probabili titolari</h3></div>
        <span className={`lineup-panel__status ${data?.hasConfirmedLineup ? 'is-confirmed' : ''}`}>
          {loading ? 'Aggiornamento...' : data?.hasConfirmedLineup ? 'Ufficiale' : 'Previsione'}
        </span>
      </div>
      {error ? <p className="lineup-panel__message is-error">{error}</p> : data && (
        <>
          <p className="lineup-panel__message">{summary}</p>
          {(data.homeIncomplete || data.awayIncomplete) && (
            <p className="lineup-panel__message is-error">Rosa incompleta per almeno una squadra: nessun giocatore viene inventato per riempire i ruoli mancanti.</p>
          )}
          <div className="lineup-panel__grid">
            <LineupColumn title={`${data.home[0]?.teamName ?? 'Casa'}${data.homeFormation ? ` · ${data.homeFormation}` : ''}`} players={data.home} />
            <LineupColumn title={`${data.away[0]?.teamName ?? 'Trasferta'}${data.awayFormation ? ` · ${data.awayFormation}` : ''}`} players={data.away} />
          </div>
          <small className="lineup-panel__note">{data.note} Le percentuali non sono garanzia di presenza.</small>
        </>
      )}
    </section>
  );
};

export default LineupPanel;
