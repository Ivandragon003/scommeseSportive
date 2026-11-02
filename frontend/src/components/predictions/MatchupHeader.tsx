import './matchup.css';

export default function MatchupHeader({ match, prediction, teams, meta, onRefresh, loading }: {
  match: any; prediction: any; teams: any[]; meta: string; onRefresh: () => void; loading: boolean;
}) {
  const side = (home: boolean) => {
    const name = String((home ? match?.home_team_name : match?.away_team_name) || (home ? prediction?.homeTeam : prediction?.awayTeam) || 'Squadra');
    const id = home ? match?.home_team_id : match?.away_team_id;
    const team = id == null ? undefined : teams.find((row) => String(row.team_id) === String(id));
    const format = (value: unknown) => typeof value === 'number' && Number.isFinite(value) ? value.toFixed(2) : '—';
    return <div className={`matchup-team${home ? '' : ' matchup-team--away'}`}>
      <div><span className="matchup-side">{home ? 'Casa' : 'Ospite'}</span><h2>{name}</h2>
        <div className="matchup-strength" aria-label={`Forza ${name}`}><span>Attacco <b>{format(team?.attack_strength)}</b></span><span>Difesa <b>{format(team?.defence_strength)}</b></span></div>
      </div>
    </div>;
  };
  return <header className="matchup-header">
    <div className="matchup-top"><p>{meta}</p><button type="button" className="fp-btn fp-btn-ghost fp-btn-sm" onClick={onRefresh} disabled={loading}>Aggiorna analisi</button></div>
    <h1 className="sr-only">{match?.home_team_name || prediction?.homeTeam} vs {match?.away_team_name || prediction?.awayTeam}</h1>
    <div className="matchup-duel">{side(true)}<span className="matchup-versus">VS</span>{side(false)}</div>
    <details className="matchup-note"><summary>Forza squadra · come leggerla</summary><p>Ultimi coefficienti salvati: valori più alti indicano attacco più produttivo e difesa più solida. — = dato non disponibile.</p></details>
  </header>;
}
