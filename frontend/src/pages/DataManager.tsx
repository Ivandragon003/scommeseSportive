import React, { useEffect, useMemo, useState } from 'react';
import {
  bulkImportMatches,
  fitModel,
  getMatches,
  getPlayersByTeam,
  getTeams,
  recomputeAverages,
} from '../utils/api';

type TeamScope = 'current' | 'previous' | 'total';

const seasonKey = (s?: string) => {
  const m = String(s ?? '').trim().match(/^(\d{4})/);
  return m ? Number(m[1]) : -1;
};

const n = (v: any, d = 2) => {
  const x = Number(v);
  return Number.isFinite(x) ? x.toFixed(d) : '-';
};

const DataManager: React.FC = () => {
  const [teams, setTeams] = useState<any[]>([]);
  const [matches, setMatches] = useState<any[]>([]);
  const [activeTab, setActiveTab] = useState('overview');
  const [loading, setLoading] = useState(true);
  const [fitLoading, setFitLoading] = useState(false);
  const [recomputeLoading, setRecomputeLoading] = useState(false);
  const [recomputeResult, setRecomputeResult] = useState<any>(null);
  const [fitResult, setFitResult] = useState<any>(null);
  const [importJson, setImportJson] = useState('');
  const [importResult, setImportResult] = useState<any>(null);
  const [competitionFilter, setCompetitionFilter] = useState('');
  const [seasonFilter, setSeasonFilter] = useState('');
  const [yearFilter, setYearFilter] = useState('');
  const [fitForm, setFitForm] = useState({ competition: 'Serie A', season: '' });

  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [scope, setScope] = useState<TeamScope>('current');
  const [playersByTeam, setPlayersByTeam] = useState<Record<string, any[]>>({});
  const [playersLoading, setPlayersLoading] = useState('');

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [teamsRes, matchesRes] = await Promise.all([getTeams(), getMatches()]);
      const t = teamsRes.data ?? [];
      setTeams(t);
      setMatches([...(matchesRes.data ?? [])].sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime()));
      if (!selectedTeamId && t.length > 0) setSelectedTeamId(String(t[0].team_id));
    } catch {}
    setLoading(false);
  };

  const loadPlayers = async (teamId: string) => {
    if (!teamId || playersByTeam[teamId]) return;
    setPlayersLoading(teamId);
    try {
      const res = await getPlayersByTeam(teamId);
      setPlayersByTeam(p => ({ ...p, [teamId]: res.data ?? [] }));
    } catch {
      setPlayersByTeam(p => ({ ...p, [teamId]: [] }));
    } finally {
      setPlayersLoading('');
    }
  };

  useEffect(() => {
    if (selectedTeamId) loadPlayers(selectedTeamId);
  }, [selectedTeamId]);

  const handleFitModel = async () => {
    if (!fitForm.competition) return alert('Inserisci la competizione');
    setFitLoading(true); setFitResult(null);
    try {
      const res = await fitModel({ competition: fitForm.competition, season: fitForm.season || undefined });
      setFitResult(res.data);
    } catch (e: any) { alert('Errore: ' + e.message); }
    setFitLoading(false);
  };

  const handleRecompute = async () => {
    setRecomputeLoading(true); setRecomputeResult(null);
    try {
      const res = await recomputeAverages(fitForm.competition || undefined);
      setRecomputeResult(res);
      await loadData();
    } catch (e: any) { alert('Errore: ' + e.message); }
    setRecomputeLoading(false);
  };

  const handleBulkImport = async () => {
    try {
      const data = JSON.parse(importJson);
      const arr = Array.isArray(data) ? data : data.matches;
      if (!Array.isArray(arr)) return alert('Formato non valido.');
      const res = await bulkImportMatches(arr);
      setImportResult(res);
      await loadData();
    } catch (e: any) { alert('Errore import: ' + (e.message ?? 'JSON non valido')); }
  };

  const competitions = Array.from(new Set(teams.map((t: any) => t.competition).filter(Boolean)));
  const seasons = Array.from(new Set(matches.map((m: any) => String(m.season ?? '').trim()).filter(Boolean)))
    .sort((a, b) => seasonKey(b) - seasonKey(a) || b.localeCompare(a));
  const years = Array.from(new Set(matches.map((m: any) => new Date(m.date).getFullYear()).filter(Number.isFinite).map(String)))
    .sort((a, b) => Number(b) - Number(a));

  const filteredMatches = matches.filter((m: any) => {
    if (competitionFilter && m.competition !== competitionFilter) return false;
    if (seasonFilter && String(m.season ?? '') !== seasonFilter) return false;
    if (yearFilter && String(new Date(m.date).getFullYear()) !== yearFilter) return false;
    return true;
  });

  const filteredTeams = competitionFilter ? teams.filter((t: any) => t.competition === competitionFilter) : teams;
  const selectedTeam = teams.find((t: any) => String(t.team_id) === String(selectedTeamId)) ?? null;

  useEffect(() => {
    const nextFiltered = competitionFilter
      ? teams.filter((t: any) => t.competition === competitionFilter)
      : teams;
    if (nextFiltered.length === 0) {
      setSelectedTeamId('');
      return;
    }
    const exists = nextFiltered.some((t: any) => String(t.team_id) === String(selectedTeamId));
    if (!exists) setSelectedTeamId(String(nextFiltered[0].team_id));
  }, [competitionFilter, teams, selectedTeamId]);

  const teamAllMatches = useMemo(() => {
    if (!selectedTeam) return [];
    return matches
      .filter((m: any) => m.home_goals !== null && m.away_goals !== null)
      .filter((m: any) => m.home_team_id === selectedTeam.team_id || m.away_team_id === selectedTeam.team_id);
  }, [matches, selectedTeam]);

  const teamSeasons = useMemo(() => Array.from(new Set(teamAllMatches.map((m: any) => String(m.season ?? '').trim()).filter(Boolean)))
    .sort((a, b) => seasonKey(b) - seasonKey(a) || b.localeCompare(a)), [teamAllMatches]);
  const currentTeamSeason = teamSeasons[0];

  const scopedMatches = useMemo(() => {
    if (scope === 'total') return teamAllMatches;
    if (!currentTeamSeason) return teamAllMatches;
    if (scope === 'current') return teamAllMatches.filter((m: any) => String(m.season ?? '').trim() === currentTeamSeason);
    return teamAllMatches.filter((m: any) => String(m.season ?? '').trim() !== currentTeamSeason);
  }, [teamAllMatches, currentTeamSeason, scope]);

  const stats = useMemo(() => {
    const s: any = { p: scopedMatches.length, w: 0, d: 0, l: 0, pts: 0, gf: 0, ga: 0, xgf: 0, xga: 0, sf: 0, sa: 0, sotf: 0, sota: 0, fouls: 0, yc: 0, rc: 0, poss: 0, possN: 0, fotmob: 0 };
    for (const m of scopedMatches) {
      const h = m.home_team_id === selectedTeam?.team_id;
      const gf = Number(h ? m.home_goals : m.away_goals) || 0;
      const ga = Number(h ? m.away_goals : m.home_goals) || 0;
      s.gf += gf; s.ga += ga;
      if (gf > ga) { s.w++; s.pts += 3; } else if (gf === ga) { s.d++; s.pts += 1; } else s.l++;
      s.xgf += Number(h ? m.home_xg : m.away_xg) || 0;
      s.xga += Number(h ? m.away_xg : m.home_xg) || 0;
      s.sf += Number(h ? m.home_shots : m.away_shots) || 0;
      s.sa += Number(h ? m.away_shots : m.home_shots) || 0;
      s.sotf += Number(h ? m.home_shots_on_target : m.away_shots_on_target) || 0;
      s.sota += Number(h ? m.away_shots_on_target : m.home_shots_on_target) || 0;
      s.fouls += Number(h ? m.home_fouls : m.away_fouls) || 0;
      s.yc += Number(h ? m.home_yellow_cards : m.away_yellow_cards) || 0;
      s.rc += Number(h ? m.home_red_cards : m.away_red_cards) || 0;
      const poss = Number(h ? m.home_possession : m.away_possession);
      if (Number.isFinite(poss)) { s.poss += poss; s.possN++; }
      if (String(m.source ?? '').toLowerCase() === 'fotmob') s.fotmob++;
    }
    const d = Math.max(1, s.p);
    s.ppg = s.pts / d; s.gd = s.gf - s.ga; s.wr = s.w / d;
    s.xgfAvg = s.xgf / d; s.xgaAvg = s.xga / d; s.sfAvg = s.sf / d; s.saAvg = s.sa / d;
    s.sotfAvg = s.sotf / d; s.sotaAvg = s.sota / d; s.foulsAvg = s.fouls / d; s.ycAvg = s.yc / d; s.rcAvg = s.rc / d;
    s.possAvg = s.possN > 0 ? s.poss / s.possN : null;
    return s;
  }, [scopedMatches, selectedTeam]);

  const players = selectedTeam ? (playersByTeam[selectedTeam.team_id] ?? []) : [];

  const tabs = [
    { id: 'overview', label: 'Overview' },
    { id: 'matches', label: `Partite${matches.length ? ` (${matches.length})` : ''}` },
    { id: 'teams', label: `Squadre${teams.length ? ` (${teams.length})` : ''}` },
    { id: 'model', label: 'Modello AI' },
    { id: 'import', label: 'Import JSON' },
  ];

  return (
    <div>
      <h1 className="page-title">Gestione Dati</h1>
      <p className="page-subtitle">Database storico partite e addestramento modello Dixon-Coles</p>

      <div className="grid-4" style={{ marginBottom: 20 }}>
        <div className="stat-box"><div className="stat-value">{loading ? '...' : matches.length}</div><div className="stat-label">Partite</div></div>
        <div className="stat-box"><div className="stat-value">{loading ? '...' : teams.length}</div><div className="stat-label">Squadre</div></div>
        <div className="stat-box"><div className="stat-value">{loading ? '...' : competitions.length}</div><div className="stat-label">Campionati</div></div>
        <div className="stat-box"><div className="stat-value">{teams.filter((t:any) => t.attack_strength).length}</div><div className="stat-label">Squadre col modello</div></div>
      </div>

      <div className="tabs" style={{ marginBottom: 16 }}>
        {tabs.map(t => <button key={t.id} className={`tab ${activeTab === t.id ? 'active' : ''}`} onClick={() => setActiveTab(t.id)}>{t.label}</button>)}
      </div>

      {activeTab === 'overview' && (
        <div className="card">
          <div className="card-header"><h2 className="card-title">Flusso consigliato</h2></div>
          <ol style={{ margin: 0, paddingLeft: 18, lineHeight: 1.8 }}>
            <li>Import dati FotMob da Dati Automatici.</li>
            <li>Ricalcola medie squadre.</li>
            <li>Addestra modello Dixon-Coles.</li>
            <li>Vai in Previsioni per quote/value bet.</li>
          </ol>
        </div>
      )}

      {activeTab === 'matches' && (
        <div className="card">
          <div className="card-header"><h2 className="card-title">Partite</h2></div>
          <div className="form-row">
            <div className="form-group"><label className="form-label">Campionato</label><select className="form-select" value={competitionFilter} onChange={e => setCompetitionFilter(e.target.value)}><option value="">Tutti</option>{competitions.map(c => <option key={c} value={c}>{c}</option>)}</select></div>
            <div className="form-group"><label className="form-label">Stagione</label><select className="form-select" value={seasonFilter} onChange={e => setSeasonFilter(e.target.value)}><option value="">Tutte</option>{seasons.map(s => <option key={s} value={s}>{s}</option>)}</select></div>
            <div className="form-group"><label className="form-label">Anno</label><select className="form-select" value={yearFilter} onChange={e => setYearFilter(e.target.value)}><option value="">Tutti</option>{years.map(y => <option key={y} value={y}>{y}</option>)}</select></div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead><tr><th>Data</th><th>Casa</th><th>Ris.</th><th>Ospite</th><th>xG</th><th>Tiri</th><th>Camp.</th></tr></thead>
              <tbody>
                {filteredMatches.slice(0, 80).map((m: any) => (
                  <tr key={m.match_id}>
                    <td>{new Date(m.date).toLocaleDateString('it-IT')}</td>
                    <td>{m.home_team_name ?? m.home_team_id}</td>
                    <td>{m.home_goals ?? '-'}-{m.away_goals ?? '-'}</td>
                    <td>{m.away_team_name ?? m.away_team_id}</td>
                    <td>{m.home_xg ? `${n(m.home_xg, 1)}-${n(m.away_xg, 1)}` : '-'}</td>
                    <td>{m.home_shots ? `${m.home_shots}-${m.away_shots}` : '-'}</td>
                    <td>{m.competition}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {activeTab === 'teams' && (
        <div className="card">
          <div className="card-header"><h2 className="card-title">Squadre</h2><span className="badge badge-green">Clicca una squadra per aprire stats complete</span></div>
          {competitions.length > 1 && (
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
              <button className={`btn btn-sm ${!competitionFilter ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setCompetitionFilter('')}>Tutte</button>
              {competitions.map(c => <button key={c} className={`btn btn-sm ${competitionFilter === c ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setCompetitionFilter(c)}>{c}</button>)}
            </div>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(170px,1fr))', gap: 10 }}>
            {filteredTeams.map((t: any) => (
              <button key={t.team_id} onClick={() => { setSelectedTeamId(t.team_id); setScope('current'); }} className="card" style={{ textAlign: 'left', border: selectedTeamId === t.team_id ? '2px solid var(--primary)' : undefined, marginBottom: 0 }}>
                <div style={{ fontWeight: 700 }}>{t.name}</div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginBottom: 8 }}>{t.competition ?? '-'}</div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <span className="badge badge-blue">ATT {n(t.attack_strength, 2)}</span>
                  <span className="badge badge-red">DIF {n(t.defence_strength, 2)}</span>
                </div>
              </button>
            ))}
          </div>

          {selectedTeam && (
            <div className="card" style={{ marginTop: 14, marginBottom: 0 }}>
              <div className="card-header">
                <div>
                  <h3 className="card-title">{selectedTeam.name}</h3>
                  <div className="card-subtitle">{selectedTeam.competition ?? '-'}</div>
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button className={`btn btn-sm ${scope === 'current' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setScope('current')}>Stagione corrente {currentTeamSeason ? `(${currentTeamSeason})` : ''}</button>
                  <button className={`btn btn-sm ${scope === 'previous' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setScope('previous')}>Stagioni precedenti</button>
                  <button className={`btn btn-sm ${scope === 'total' ? 'btn-primary' : 'btn-secondary'}`} onClick={() => setScope('total')}>Totale</button>
                </div>
              </div>

              <div className="grid-2">
                <div>
                  <div className="alert alert-info"><strong>Stats da dati partite (FotMob/import)</strong></div>
                  <table>
                    <tbody>
                      <tr><td>Partite</td><td>{stats.p}</td></tr>
                      <tr><td>Record</td><td>{stats.w}V-{stats.d}N-{stats.l}P</td></tr>
                      <tr><td>Punti</td><td>{stats.pts} ({n(stats.ppg, 2)} ppg)</td></tr>
                      <tr><td>Win rate</td><td>{n(stats.wr * 100, 1)}%</td></tr>
                      <tr><td>Gol fatti/subiti</td><td>{stats.gf}/{stats.ga} ({stats.gd >= 0 ? '+' : ''}{stats.gd})</td></tr>
                      <tr><td>xG fatti/subiti</td><td>{n(stats.xgfAvg, 2)}/{n(stats.xgaAvg, 2)}</td></tr>
                      <tr><td>Tiri fatti/subiti</td><td>{n(stats.sfAvg, 2)}/{n(stats.saAvg, 2)}</td></tr>
                      <tr><td>Tiri OT fatti/subiti</td><td>{n(stats.sotfAvg, 2)}/{n(stats.sotaAvg, 2)}</td></tr>
                      <tr><td>Falli/G</td><td>{n(stats.foulsAvg, 2)}</td></tr>
                      <tr><td>Gialli/G</td><td>{n(stats.ycAvg, 2)}</td></tr>
                      <tr><td>Rossi/G</td><td>{n(stats.rcAvg, 3)}</td></tr>
                      <tr><td>Possesso medio</td><td>{stats.possAvg !== null ? `${n(stats.possAvg, 1)}%` : '-'}</td></tr>
                      <tr><td>Match source FotMob</td><td>{stats.fotmob}</td></tr>
                    </tbody>
                  </table>
                </div>

                <div>
                  <div className="alert alert-warning"><strong>Stats generate dal nostro modello IA</strong></div>
                  <table>
                    <tbody>
                      <tr><td>Attack strength</td><td>{n(selectedTeam.attack_strength, 3)}</td></tr>
                      <tr><td>Defence strength</td><td>{n(selectedTeam.defence_strength, 3)}</td></tr>
                      <tr><td>Avg home shots</td><td>{n(selectedTeam.avg_home_shots, 2)}</td></tr>
                      <tr><td>Avg away shots</td><td>{n(selectedTeam.avg_away_shots, 2)}</td></tr>
                      <tr><td>Avg home shots OT</td><td>{n(selectedTeam.avg_home_shots_ot, 2)}</td></tr>
                      <tr><td>Avg away shots OT</td><td>{n(selectedTeam.avg_away_shots_ot, 2)}</td></tr>
                      <tr><td>Avg home xG</td><td>{n(selectedTeam.avg_home_xg, 2)}</td></tr>
                      <tr><td>Avg away xG</td><td>{n(selectedTeam.avg_away_xg, 2)}</td></tr>
                      <tr><td>Avg yellow cards</td><td>{n(selectedTeam.avg_yellow_cards, 2)}</td></tr>
                      <tr><td>Avg red cards</td><td>{n(selectedTeam.avg_red_cards, 3)}</td></tr>
                      <tr><td>Avg fouls</td><td>{n(selectedTeam.avg_fouls, 2)}</td></tr>
                      <tr><td>Shots suppression</td><td>{n(selectedTeam.shots_suppression, 3)}</td></tr>
                    </tbody>
                  </table>
                </div>
              </div>

              <div style={{ marginTop: 12 }}>
                <div className="card-header">
                  <h3 className="card-title" style={{ fontSize: 15 }}>Giocatori squadra (stats FotMob/FantaMod)</h3>
                  <span className="badge badge-blue">{playersLoading === selectedTeam.team_id ? 'Caricamento...' : `${players.length} giocatori`}</span>
                </div>
                {playersLoading === selectedTeam.team_id ? (
                  <div className="alert alert-info">Recupero dati giocatori...</div>
                ) : players.length === 0 ? (
                  <div className="alert alert-info">Nessun giocatore disponibile. Esegui import/aggiornamento da FotMob.</div>
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table>
                      <thead><tr><th>Nome</th><th>Ruolo</th><th>Partite</th><th>Tiri/G</th><th>Tiri OT/G</th><th>xG/G</th><th>xGOT/G</th><th>Gol</th><th>Shot share</th></tr></thead>
                      <tbody>
                        {players.map((p: any) => (
                          <tr key={p.player_id}>
                            <td style={{ fontWeight: 600 }}>{p.name}</td>
                            <td>{p.position_code}</td>
                            <td>{p.games_played ?? 0}</td>
                            <td>{n(p.avg_shots_per_game, 2)}</td>
                            <td>{n(p.avg_shots_on_target_per_game, 2)}</td>
                            <td>{n(p.avg_xg_per_game, 3)}</td>
                            <td>{n(p.avg_xgot_per_game, 3)}</td>
                            <td>{p.total_goals ?? 0}</td>
                            <td>{n((Number(p.shot_share_of_team) || 0) * 100, 1)}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {activeTab === 'model' && (
        <div>
          <div className="card" style={{ marginBottom: 12 }}>
            <div className="card-header"><h2 className="card-title">Parametri</h2></div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Competizione *</label>
                <select className="form-select" value={fitForm.competition} onChange={e => setFitForm(p => ({ ...p, competition: e.target.value }))}>
                  {['Serie A','Premier League','La Liga','Bundesliga','Ligue 1','Champions League'].map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Stagione (vuoto = tutte)</label>
                <input className="form-input" value={fitForm.season} onChange={e => setFitForm(p => ({ ...p, season: e.target.value }))} placeholder="es. 2024-2025" />
              </div>
            </div>
          </div>
          <div className="card" style={{ marginBottom: 12 }}>
            <button className="btn btn-secondary" onClick={handleRecompute} disabled={recomputeLoading}>{recomputeLoading ? 'Ricalcolo...' : 'Ricalcola Medie Squadre'}</button>
            {recomputeResult && <div className="alert alert-success" style={{ marginTop: 10 }}>Aggiornate <strong>{recomputeResult.data?.teamsUpdated ?? recomputeResult.teamsUpdated}</strong> squadre.</div>}
          </div>
          <div className="card">
            <button className="btn btn-primary" onClick={handleFitModel} disabled={fitLoading}>{fitLoading ? 'Addestramento...' : 'Addestra Modello'}</button>
            {fitResult && <div className="alert alert-success" style={{ marginTop: 10 }}><strong>Modello addestrato.</strong> Partite: <strong>{fitResult.matchesUsed}</strong> - Squadre: <strong>{fitResult.teams}</strong> - Log-likelihood: <strong>{fitResult.logLikelihood?.toFixed(2)}</strong></div>}
          </div>
        </div>
      )}

      {activeTab === 'import' && (
        <div className="card">
          <div className="card-header"><h2 className="card-title">Import Manuale JSON</h2></div>
          <div className="form-group">
            <label className="form-label">Array JSON partite</label>
            <textarea className="form-input" style={{ height: 160, fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }} value={importJson} onChange={e => setImportJson(e.target.value)} />
          </div>
          <button className="btn btn-primary" onClick={handleBulkImport} disabled={!importJson}>Importa Dati</button>
          {importResult && <div className={`alert ${importResult.success ? 'alert-success' : 'alert-danger'}`} style={{ marginTop: 12 }}>{importResult.success ? `Importate ${importResult.data?.imported ?? importResult.imported} partite!` : `Errore: ${importResult.error}`}</div>}
        </div>
      )}
    </div>
  );
};

export default DataManager;
