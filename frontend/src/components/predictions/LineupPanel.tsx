import React, { useEffect, useMemo, useState } from 'react';
import { getPlayerAvailability } from '../../utils/api';

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
    setLoading(true);
    setError('');
    getPlayerAvailability(matchId)
      .then((response) => { if (active) setData(response.data ?? null); })
      .catch(() => { if (active) setError('Formazioni non disponibili al momento.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [matchId]);

  const summary = useMemo(() => {
    if (!data) return '';
    if (data.hasConfirmedLineup) return 'Formazione ufficiale ricevuta: le player bet possono essere rivalutate.';
    if (data.hasProviderData) return 'Indisponibilità aggiornate da API-Football; titolarità ancora stimata.';
    return 'Stima interna basata sui minuti e sulle presenze storiche.';
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
          <div className="lineup-panel__grid">
            <LineupColumn title={data.home[0]?.teamName ?? 'Casa'} players={data.home} />
            <LineupColumn title={data.away[0]?.teamName ?? 'Trasferta'} players={data.away} />
          </div>
          <small className="lineup-panel__note">{data.note} Le percentuali non sono garanzia di presenza.</small>
        </>
      )}
    </section>
  );
};

export default LineupPanel;
