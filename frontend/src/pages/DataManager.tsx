import React, { useEffect, useMemo, useState } from 'react';
import {
  bulkImportMatches, fitModel, getMatches,
  getPlayersByTeam, getStatsOverview, getTeams, recomputeAverages,
} from '../utils/api';

type TeamScope = 'current' | 'previous' | 'total';

const seasonKey = (s?: string) => {
  const m = String(s ?? '').trim().match(/^(\d{4})/);
  return m ? Number(m[1]) : -1;
};
const n = (v: any, d = 2) => {
  if (v === null || v === undefined || v === '') return '-';
  const x = Number(v);
  return Number.isFinite(x) ? x.toFixed(d) : '-';
};

/* Solo stili specifici di DataManager */
const localStyles = `
  .dm-wrap { padding: 40px 32px; min-height: 100vh; }

  .dm-title {
    font-size: clamp(28px,4vw,40px); font-weight: 800; letter-spacing: -1.5px; line-height: 1;
    background: linear-gradient(135deg, #fff 35%, var(--purple));
    -webkit-background-clip: text; -webkit-text-fill-color: transparent;
    margin-bottom: 8px;
  }
  .dm-subtitle { font-size: 12px; color: var(--text-2); font-family: 'DM Mono',monospace; margin-bottom: 36px; }

  /* TABS wrapper - sovrascrive fp-tabs per aggiungere margin */
  .dm-tabs-wrap { margin-bottom: 24px; }

  /* STEPS */
  .dm-steps { display: grid; grid-template-columns: repeat(4,1fr); gap: 14px; }
  .dm-step {
    background: var(--surface2); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 20px; position: relative;
    transition: border-color var(--transition), background var(--transition), transform var(--transition);
  }
  .dm-step:hover { border-color: var(--border-hover); background: var(--surface3); transform: translateY(-2px); }
  .dm-step-num  { font-size: 10px; font-weight: 700; letter-spacing: 1.2px; text-transform: uppercase; color: var(--purple); margin-bottom: 10px; font-family: 'DM Mono',monospace; }
  .dm-step-title{ font-size: 15px; font-weight: 700; margin-bottom: 6px; }
  .dm-step-desc { font-size: 12px; color: var(--text-2); line-height: 1.55; }
  .dm-step-arrow{
    position: absolute; right: -7px; top: 50%; transform: translateY(-50%);
    background: var(--surface); border: 1px solid var(--border);
    border-radius: 50%; width: 14px; height: 14px;
    display: flex; align-items: center; justify-content: center;
    font-size: 8px; color: var(--text-2); z-index: 1;
  }

  /* FILTERS */
  .dm-filters { display: flex; gap: 14px; padding: 16px 24px; border-bottom: 1px solid var(--border); flex-wrap: wrap; }
  .dm-filter-group { display: flex; flex-direction: column; gap: 5px; min-width: 140px; }

  /* MATCHES table specifics */
  .dm-score { font-family: 'DM Mono',monospace; font-weight: 700; font-size: 14px; }
  .dm-comp-tag {
    display: inline-block; background: var(--surface2); border: 1px solid var(--border);
    border-radius: var(--radius-pill); padding: 2px 12px; font-size: 11px; color: var(--text-2);
  }

  /* COMP PILLS */
  .dm-comp-pills { display: flex; gap: 6px; flex-wrap: wrap; padding: 14px 24px; border-bottom: 1px solid var(--border); }

  /* TEAM GRID */
  .dm-team-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(165px,1fr)); gap: 10px; padding: 20px 24px; }
  .dm-team-card { padding: 16px; text-align: left; }
  .dm-team-name { font-size: 13px; font-weight: 700; margin-bottom: 4px; line-height: 1.3; }
  .dm-team-comp { font-size: 11px; color: var(--text-2); margin-bottom: 12px; }
  .dm-team-badges { display: flex; gap: 5px; flex-wrap: wrap; }

  /* TEAM DETAIL */
  .dm-detail { margin: 0 24px 24px; }
  .dm-detail-head {
    display: flex; align-items: flex-start; justify-content: space-between;
    padding: 20px 0 16px; border-bottom: 1px solid var(--border); margin-bottom: 20px;
  }
  .dm-detail-name { font-size: 22px; font-weight: 800; margin-bottom: 4px; }
  .dm-detail-comp { font-size: 13px; color: var(--text-2); }
  .dm-scope-tabs { display: flex; gap: 4px; flex-wrap: wrap; }
  .dm-scope-tab {
    font-family: 'Syne',sans-serif; font-size: 11px; font-weight: 700;
    padding: 7px 14px; border-radius: var(--radius-xs); border: 1px solid var(--border);
    background: transparent; color: var(--text-2); cursor: pointer; transition: all var(--transition);
  }
  .dm-scope-tab:hover:not(.active) { color: var(--text); background: var(--surface3); border-color: var(--border-hover); }
  .dm-scope-tab.active { background: var(--purple-dim); border-color: var(--purple-border); color: var(--purple); }

  /* RECORD BOXES */
  .dm-record { display: flex; gap: 10px; margin-bottom: 20px; }
  .dm-rec-box { flex: 1; text-align: center; border-radius: var(--radius-sm); padding: 14px 8px; }
  .dm-rec-box.w { background: var(--green-dim); border: 1px solid var(--green-border); }
  .dm-rec-box.d { background: var(--blue-dim);  border: 1px solid var(--blue-border); }
  .dm-rec-box.l { background: var(--red-dim);   border: 1px solid var(--red-border); }
  .dm-rec-val  { font-size: 26px; font-weight: 800; font-family: 'DM Mono',monospace; }
  .dm-rec-val.w { color: var(--green); }
  .dm-rec-val.d { color: var(--blue);  }
  .dm-rec-val.l { color: var(--red);   }
  .dm-rec-lbl  { font-size: 10px; text-transform: uppercase; letter-spacing: 1px; font-weight: 700; margin-top: 3px; opacity: .75; }

  /* STATS PANELS */
  .dm-stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 20px; }
  .dm-stats-panel { background: var(--surface2); border: 1px solid var(--border); border-radius: var(--radius-sm); overflow: hidden; }
  .dm-stats-head { padding: 12px 16px; border-bottom: 1px solid var(--border); font-size: 11px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; }
  .dm-stats-head.fotmob { color: var(--blue); }
  .dm-stats-head.model  { color: var(--gold); }

  /* Stats inner table */
  .dm-stats-table { width: 100%; }
  .dm-stats-table tr { border-bottom: 1px solid rgba(255,255,255,0.04); transition: background var(--transition); }
  .dm-stats-table tr:last-child { border-bottom: none; }
  .dm-stats-table tr:hover { background: var(--surface3); }
  .dm-stats-table td { padding: 10px 16px; font-size: 13px; }
  .dm-stats-table td:first-child { color: var(--text-2); font-size: 12px; }
  .dm-stats-table td:last-child  { font-family: 'DM Mono',monospace; font-weight: 500; text-align: right; color: var(--text); }

  /* PLAYERS HEAD */
  .dm-players-head { padding: 16px 0 12px; display: flex; justify-content: space-between; align-items: center; border-top: 1px solid var(--border); margin-top: 4px; }
  .dm-players-title { font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 1px; color: var(--text-2); }

  /* MODEL TAB */
  .dm-model-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
  .dm-form-group { display: flex; flex-direction: column; gap: 6px; }

  /* ACTION BUTTONS - grandi, per model tab */
  .dm-action-btn {
    font-family: 'Syne',sans-serif; font-weight: 700; font-size: 14px;
    border-radius: var(--radius-sm); cursor: pointer; padding: 15px 24px;
    transition: all var(--transition); display: flex; align-items: center;
    gap: 8px; width: 100%; justify-content: center; border: 1px solid;
  }
  .dm-action-btn:disabled { opacity: .35; cursor: not-allowed; }
  .dm-action-btn.blue   { background: var(--blue-dim);   border-color: var(--blue-border);   color: var(--blue);   }
  .dm-action-btn.blue:hover:not(:disabled)   { background: var(--blue-hover);   border-color: var(--blue); }
  .dm-action-btn.purple { background: var(--purple-dim); border-color: var(--purple-border); color: var(--purple); }
  .dm-action-btn.purple:hover:not(:disabled) { background: var(--purple-hover); border-color: var(--purple); }

  /* RESULT BOX */
  .dm-result { border-radius: var(--radius-sm); padding: 14px 18px; font-size: 13px; margin-top: 12px; line-height: 1.6; }
  .dm-result.ok  { background: var(--green-dim); border: 1px solid var(--green-border); color: var(--green); }
  .dm-result.err { background: var(--red-dim);   border: 1px solid var(--red-border);   color: var(--red);   }

  /* IMPORT */
  .dm-textarea {
    background: var(--surface2); border: 1px solid var(--border); border-radius: var(--radius-sm);
    padding: 14px 16px; color: var(--text); font-family: 'DM Mono',monospace; font-size: 12px;
    width: 100%; height: 210px; resize: vertical; outline: none; line-height: 1.65;
    transition: border-color var(--transition), background var(--transition);
  }
  .dm-textarea:hover  { background: var(--surface3); border-color: rgba(255,255,255,0.16); }
  .dm-textarea:focus  { border-color: var(--blue); box-shadow: 0 0 0 3px var(--blue-dim); }
  .dm-import-hint { font-size: 12px; color: var(--text-2); margin-top: 8px; line-height: 1.6; }
  .dm-import-hint code {
    background: var(--surface2); border: 1px solid var(--border);
    border-radius: 4px; padding: 1px 6px;
    font-family: 'DM Mono',monospace; font-size: 11px; color: var(--blue);
  }

  .dm-overview-grid { display: grid; grid-template-columns: 1.2fr 1fr; gap: 16px; margin-top: 16px; }
  .dm-overview-card {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 16px;
  }
  .dm-overview-title {
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 1px;
    color: var(--text-2);
    font-weight: 700;
    margin-bottom: 12px;
  }
  .dm-qual-row { display: grid; grid-template-columns: 100px 1fr auto; gap: 10px; align-items: center; margin-bottom: 8px; }
  .dm-qual-row:last-child { margin-bottom: 0; }
  .dm-qual-key { color: var(--text-2); font-size: 12px; }
  .dm-qual-track { height: 7px; border-radius: 20px; background: rgba(255,255,255,0.08); overflow: hidden; }
  .dm-qual-fill { height: 100%; border-radius: 20px; background: var(--blue); }
  .dm-qual-val { font-family: 'DM Mono',monospace; font-size: 11px; color: var(--text); min-width: 48px; text-align: right; }
  .dm-top5-grid { display: grid; grid-template-columns: repeat(5, minmax(150px, 1fr)); gap: 10px; margin-top: 14px; }
  .dm-league-card {
    background: var(--surface2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: 12px;
  }
  .dm-league-head { font-size: 11px; font-weight: 700; margin-bottom: 8px; color: var(--text); }
  .dm-league-kpi { font-size: 11px; color: var(--text-2); margin-bottom: 4px; display: flex; justify-content: space-between; gap: 8px; }
  .dm-league-kpi strong { color: var(--text); font-family: 'DM Mono',monospace; font-weight: 700; }
  .dm-check-badge {
    display: inline-flex;
    align-items: center;
    border-radius: 999px;
    font-size: 10px;
    padding: 3px 10px;
    border: 1px solid var(--border);
    font-family: 'DM Mono',monospace;
    margin-left: 8px;
  }
  .dm-check-badge.ok { background: var(--green-dim); color: var(--green); border-color: var(--green-border); }
  .dm-check-badge.ko { background: var(--red-dim); color: var(--red); border-color: var(--red-border); }

  @media (max-width: 900px) {
    .dm-steps      { grid-template-columns: repeat(2,1fr); }
    .dm-model-grid { grid-template-columns: 1fr; }
    .dm-stats-grid { grid-template-columns: 1fr; }
    .dm-team-grid  { grid-template-columns: repeat(auto-fill, minmax(140px,1fr)); }
    .dm-overview-grid { grid-template-columns: 1fr; }
    .dm-top5-grid { grid-template-columns: repeat(2, minmax(140px, 1fr)); }
  }
  @media (max-width: 600px) {
    .dm-wrap { padding: 16px; }
    .dm-title { font-size: 26px; }
    .dm-steps { grid-template-columns: 1fr; }
    .dm-top5-grid { grid-template-columns: 1fr; }
  }
`;

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
  const [statsOverview, setStatsOverview] = useState<any>(null);
  const [statsOverviewError, setStatsOverviewError] = useState('');

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    setLoading(true);
    const [teamsRes, matchesRes, overviewRes] = await Promise.allSettled([
      getTeams(),
      getMatches(),
      getStatsOverview(),
    ]);

    if (teamsRes.status === 'fulfilled') {
      const t = teamsRes.value.data ?? [];
      setTeams(t);
      if (!selectedTeamId && t.length > 0) setSelectedTeamId(String(t[0].team_id));
    }

    if (matchesRes.status === 'fulfilled') {
      setMatches([...(matchesRes.value.data ?? [])].sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime()));
    }

    if (overviewRes.status === 'fulfilled') {
      setStatsOverview(overviewRes.value.data ?? null);
      setStatsOverviewError('');
    } else {
      setStatsOverview(null);
      setStatsOverviewError(overviewRes.reason?.message ?? 'Errore caricamento audit stats');
    }

    setLoading(false);
  };

  const loadPlayers = async (teamId: string) => {
    if (!teamId || playersByTeam[teamId]) return;
    setPlayersLoading(teamId);
    try {
      const res = await getPlayersByTeam(teamId);
      setPlayersByTeam(p => ({ ...p, [teamId]: res.data ?? [] }));
    } catch { setPlayersByTeam(p => ({ ...p, [teamId]: [] })); }
    finally { setPlayersLoading(''); }
  };

  useEffect(() => { if (selectedTeamId) loadPlayers(selectedTeamId); }, [selectedTeamId]);

  const handleFitModel = async () => {
    if (!fitForm.competition) return alert('Inserisci la competizione');
    setFitLoading(true); setFitResult(null);
    try { const res = await fitModel({ competition: fitForm.competition, season: fitForm.season || undefined }); setFitResult(res.data); }
    catch (e: any) { alert('Errore: ' + e.message); }
    setFitLoading(false);
  };

  const handleRecompute = async () => {
    setRecomputeLoading(true); setRecomputeResult(null);
    try { const res = await recomputeAverages(fitForm.competition || undefined); setRecomputeResult(res); await loadData(); }
    catch (e: any) { alert('Errore: ' + e.message); }
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
  const seasons = Array.from(new Set(matches.map((m: any) => String(m.season ?? '').trim()).filter(Boolean))).sort((a, b) => seasonKey(b) - seasonKey(a) || b.localeCompare(a));
  const years = Array.from(new Set(matches.map((m: any) => new Date(m.date).getFullYear()).filter(Number.isFinite).map(String))).sort((a, b) => Number(b) - Number(a));

  const filteredMatches = matches.filter((m: any) => {
    if (competitionFilter && m.competition !== competitionFilter) return false;
    if (seasonFilter && String(m.season ?? '') !== seasonFilter) return false;
    if (yearFilter && String(new Date(m.date).getFullYear()) !== yearFilter) return false;
    return true;
  });

  const filteredTeams = competitionFilter ? teams.filter((t: any) => t.competition === competitionFilter) : teams;
  const selectedTeam  = teams.find((t: any) => String(t.team_id) === String(selectedTeamId)) ?? null;

  useEffect(() => {
    const nf = competitionFilter ? teams.filter((t: any) => t.competition === competitionFilter) : teams;
    if (!nf.length) { setSelectedTeamId(''); return; }
    if (!nf.some((t: any) => String(t.team_id) === String(selectedTeamId))) setSelectedTeamId(String(nf[0].team_id));
  }, [competitionFilter, teams, selectedTeamId]);

  const teamAllMatches = useMemo(() => {
    if (!selectedTeam) return [];
    return matches.filter((m: any) => m.home_goals !== null && m.away_goals !== null)
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
    const s: any = { p: scopedMatches.length, w: 0, d: 0, l: 0, pts: 0, gf: 0, ga: 0, xgf: 0, xga: 0, sf: 0, sa: 0, sotf: 0, sota: 0, fouls: 0, yc: 0, rc: 0, xgfN: 0, xgaN: 0, sfN: 0, saN: 0, sotfN: 0, sotaN: 0, foulsN: 0, ycN: 0, rcN: 0, poss: 0, possN: 0, fotmob: 0 };
    const add = (sk: string, nk: string, rv: any) => { const v = Number(rv); if (Number.isFinite(v)) { s[sk] += v; s[nk]++; } };
    for (const m of scopedMatches) {
      const h = m.home_team_id === selectedTeam?.team_id;
      const gf = Number(h ? m.home_goals : m.away_goals) || 0;
      const ga = Number(h ? m.away_goals : m.home_goals) || 0;
      s.gf += gf; s.ga += ga;
      if (gf > ga) { s.w++; s.pts += 3; } else if (gf === ga) { s.d++; s.pts++; } else s.l++;
      add('xgf','xgfN', h ? m.home_xg : m.away_xg);
      add('xga','xgaN', h ? m.away_xg : m.home_xg);
      add('sf', 'sfN',  h ? m.home_shots : m.away_shots);
      add('sa', 'saN',  h ? m.away_shots : m.home_shots);
      add('sotf','sotfN', h ? m.home_shots_on_target : m.away_shots_on_target);
      add('sota','sotaN', h ? m.away_shots_on_target : m.home_shots_on_target);
      add('fouls','foulsN', h ? m.home_fouls : m.away_fouls);
      add('yc','ycN', h ? m.home_yellow_cards : m.away_yellow_cards);
      add('rc','rcN', h ? m.home_red_cards : m.away_red_cards);
      const poss = Number(h ? m.home_possession : m.away_possession);
      if (Number.isFinite(poss)) { s.poss += poss; s.possN++; }
      if (String(m.source ?? '').toLowerCase() === 'fotmob') s.fotmob++;
    }
    const d = Math.max(1, s.p);
    s.ppg = s.pts / d; s.gd = s.gf - s.ga; s.wr = s.w / d;
    s.xgfAvg  = s.xgfN  > 0 ? s.xgf  / s.xgfN  : null;
    s.xgaAvg  = s.xgaN  > 0 ? s.xga  / s.xgaN  : null;
    s.sfAvg   = s.sfN   > 0 ? s.sf   / s.sfN   : null;
    s.saAvg   = s.saN   > 0 ? s.sa   / s.saN   : null;
    s.sotfAvg = s.sotfN > 0 ? s.sotf / s.sotfN : null;
    s.sotaAvg = s.sotaN > 0 ? s.sota / s.sotaN : null;
    s.foulsAvg= s.foulsN> 0 ? s.fouls/ s.foulsN: null;
    s.ycAvg   = s.ycN   > 0 ? s.yc   / s.ycN   : null;
    s.rcAvg   = s.rcN   > 0 ? s.rc   / s.rcN   : null;
    s.possAvg = s.possN > 0 ? s.poss / s.possN : null;
    return s;
  }, [scopedMatches, selectedTeam]);

  const players = selectedTeam ? (playersByTeam[selectedTeam.team_id] ?? []) : [];
  const qualityRows = [
    { key: 'xg', label: 'xG' },
    { key: 'shots', label: 'Tiri' },
    { key: 'shotsOnTarget', label: 'Tiri OT' },
    { key: 'fouls', label: 'Falli' },
    { key: 'yellowCards', label: 'Gialli' },
    { key: 'redCards', label: 'Rossi' },
    { key: 'possession', label: 'Possesso' },
    { key: 'referee', label: 'Arbitro' },
  ].map((item) => ({
    ...item,
    pct: Number(statsOverview?.coverage?.fields?.[item.key]?.pct ?? 0),
    filled: Number(statsOverview?.coverage?.fields?.[item.key]?.filled ?? 0),
  }));
  const top5Leagues = statsOverview?.leagues ?? [];

  const TABS = [
    { id: 'overview', label: ' Overview' },
    { id: 'matches',  label: ` Partite${matches.length ? ` (${matches.length})` : ''}` },
    { id: 'teams',    label: ` Squadre${teams.length ? ` (${teams.length})` : ''}` },
    { id: 'model',    label: ' Modello AI' },
    { id: 'import',   label: ' Import JSON' },
  ];

  return (
    <>
      <style>{localStyles}</style>
      <div className="dm-wrap">

        {/* HEADER */}
        <div className="dm-title">Gestione Dati</div>
        <div className="dm-subtitle">Database storico partite  Addestramento Dixon-Coles</div>

        {/* STAT GRID  usa classi globali */}
        <div className="fp-grid-4" style={{ marginBottom: 28 }}>
          {[
            { icon: '', val: loading ? '' : matches.length,                          label: 'Partite',       c: 'blue'   },
            { icon: '', val: loading ? '' : teams.length,                            label: 'Squadre',       c: 'purple' },
            { icon: '', val: loading ? '' : competitions.length,                     label: 'Campionati',    c: 'gold'   },
            { icon: '', val: teams.filter((t: any) => t.attack_strength).length,       label: 'Modello attivo',c: 'green'  },
          ].map(({ icon, val, label, c }) => (
            <div key={label} className={`fp-stat c-${c}`}>
              <span className="fp-stat-icon">{icon}</span>
              <div className={`fp-stat-val c-${c}`}>{val}</div>
              <div className="fp-stat-label">{label}</div>
            </div>
          ))}
        </div>

        {/* TABS */}
        <div className="dm-tabs-wrap">
          <div className="fp-tabs">
            {TABS.map(t => (
              <button key={t.id} className={`fp-tab${activeTab === t.id ? ' active' : ''}`} onClick={() => setActiveTab(t.id)}>
                {t.label}
              </button>
            ))}
          </div>
        </div>

        {/*  OVERVIEW  */}
        {activeTab === 'overview' && (
          <>
            <div className="fp-card">
              <div className="fp-card-head"><div className="fp-card-title">Flusso Consigliato</div></div>
              <div className="fp-card-body">
                <div className="dm-steps">
                  {[
                    { n: '01', title: 'Importa Dati',     desc: 'Importa i dati FotMob tramite Dati Automatici o manualmente via JSON.' },
                    { n: '02', title: 'Ricalcola Medie',  desc: 'Aggiorna le medie statistiche per ogni squadra (tiri, xG, cartellini, falli).' },
                    { n: '03', title: 'Addestra Modello', desc: 'Esegui il fit Dixon-Coles per calibrare attack e defence strength.' },
                    { n: '04', title: 'Analizza Partite', desc: 'Vai in Previsioni per calcolare probabilita, quote e value bet.' },
                  ].map(({ n: num, title, desc }, i, arr) => (
                    <div key={num} className="dm-step">
                      <div className="dm-step-num">Step {num}</div>
                      <div className="dm-step-title">{title}</div>
                      <div className="dm-step-desc">{desc}</div>
                      {i < arr.length - 1 && <div className="dm-step-arrow"></div>}
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="dm-overview-grid">
              <div className="dm-overview-card">
                <div className="dm-overview-title">
                  Verifica caricamento statistiche
                  <span className={`dm-check-badge ${statsOverview?.checks?.allCoreStatsLoaded ? 'ok' : 'ko'}`}>
                    {statsOverview?.checks?.allCoreStatsLoaded ? 'OK' : 'Parziale'}
                  </span>
                </div>
                {statsOverviewError ? (
                  <div className="fp-alert fp-alert-warning">{statsOverviewError}</div>
                ) : (
                  <>
                    <div style={{ display: 'flex', gap: 14, marginBottom: 12, flexWrap: 'wrap' }}>
                      <span className="fp-badge fp-badge-blue">Match: {statsOverview?.coverage?.totals?.totalMatches ?? 0}</span>
                      <span className="fp-badge fp-badge-green">Completi: {statsOverview?.coverage?.totals?.completedMatches ?? 0}</span>
                      <span className="fp-badge fp-badge-gray">Upcoming: {statsOverview?.coverage?.totals?.upcomingMatches ?? 0}</span>
                    </div>
                    {qualityRows.map((row) => (
                      <div key={row.key} className="dm-qual-row">
                        <div className="dm-qual-key">{row.label}</div>
                        <div className="dm-qual-track">
                          <div
                            className="dm-qual-fill"
                            style={{
                              width: `${Math.min(100, row.pct)}%`,
                              background: row.pct >= 80 ? 'var(--green)' : row.pct >= 60 ? 'var(--gold)' : 'var(--red)'
                            }}
                          />
                        </div>
                        <div className="dm-qual-val">{n(row.pct, 1)}%</div>
                      </div>
                    ))}
                  </>
                )}
              </div>

              <div className="dm-overview-card">
                <div className="dm-overview-title">Copertura stats giocatori (opzionale)</div>
                <div style={{ display: 'grid', gap: 10 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                    <span style={{ color: 'var(--text-2)' }}>Squadre con profili giocatori</span>
                    <strong className="fp-mono">{statsOverview?.coverage?.teams?.teamsWithPlayers ?? 0} / {statsOverview?.coverage?.teams?.totalTeams ?? 0}</strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                    <span style={{ color: 'var(--text-2)' }}>Copertura squadre</span>
                    <strong className="fp-mono">{n(statsOverview?.coverage?.teams?.pctWithPlayers ?? 0, 1)}%</strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                    <span style={{ color: 'var(--text-2)' }}>Giocatori disponibili</span>
                    <strong className="fp-mono">{statsOverview?.coverage?.players?.totalPlayers ?? 0}</strong>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12 }}>
                    <span style={{ color: 'var(--text-2)' }}>Media partite / giocatore</span>
                    <strong className="fp-mono">{n(statsOverview?.coverage?.players?.avgGamesPlayed ?? 0, 2)}</strong>
                  </div>
                </div>
                <div className="fp-alert fp-alert-info" style={{ marginTop: 12 }}>
                  Il database giocatori dedicato e gia presente (tabella players) e alimenta il modello player props in Previsioni.
                </div>
              </div>
            </div>

            <div className="fp-card" style={{ marginTop: 16 }}>
              <div className="fp-card-head">
                <div className="fp-card-title">Top 5 campionati europei (3+ metriche)</div>
                <span className="fp-badge fp-badge-blue">Aggiornato: {statsOverview?.generatedAt ? new Date(statsOverview.generatedAt).toLocaleString('it-IT') : 'n/d'}</span>
              </div>
              <div className="fp-card-body">
                {top5Leagues.length === 0 ? (
                  <div className="fp-empty"><div className="fp-empty-text">Nessun dato top-5 disponibile.</div></div>
                ) : (
                  <div className="dm-top5-grid">
                    {top5Leagues.map((league: any) => (
                      <div key={league.competition} className="dm-league-card">
                        <div className="dm-league-head">{league.competition}</div>
                        <div className="dm-league-kpi"><span>Partite</span><strong>{league.matches ?? 0}</strong></div>
                        <div className="dm-league-kpi"><span>Gol medi</span><strong>{n(league.avgGoals ?? 0, 2)}</strong></div>
                        <div className="dm-league-kpi"><span>Cartellini medi</span><strong>{n(league.avgTotalCards ?? 0, 2)}</strong></div>
                        <div className="dm-league-kpi"><span>Tiri medi</span><strong>{n(league.avgTotalShots ?? 0, 2)}</strong></div>
                        <div className="dm-league-kpi"><span>xG coverage</span><strong>{n(league.xgCoveragePct ?? 0, 1)}%</strong></div>
                        <div className="dm-league-kpi"><span>Giocatori</span><strong>{league.players?.players ?? 0}</strong></div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </>
        )}

        {/*  MATCHES  */}
        {activeTab === 'matches' && (
          <div className="fp-card">
            <div className="fp-card-head">
              <div className="fp-card-title"> Partite ({filteredMatches.length})</div>
            </div>
            <div className="dm-filters">
              {[
                { label: 'Campionato', value: competitionFilter, set: setCompetitionFilter, opts: competitions, ph: 'Tutti' },
                { label: 'Stagione',   value: seasonFilter,      set: setSeasonFilter,      opts: seasons,      ph: 'Tutte' },
                { label: 'Anno',       value: yearFilter,         set: setYearFilter,        opts: years,        ph: 'Tutti' },
              ].map(({ label, value, set, opts, ph }) => (
                <div key={label} className="dm-filter-group">
                  <label className="fp-label">{label}</label>
                  <select className="fp-select" value={value} onChange={e => set(e.target.value)}>
                    <option value="">{ph}</option>
                    {opts.map(o => <option key={o} value={o}>{o}</option>)}
                  </select>
                </div>
              ))}
            </div>
            {filteredMatches.length === 0 ? (
              <div className="fp-empty"><div className="fp-empty-icon"></div><div className="fp-empty-text">Nessuna partita trovata.</div></div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table className="fp-table">
                  <thead>
                    <tr><th>Data</th><th>Casa</th><th style={{ textAlign: 'center' }}>Ris.</th><th>Ospite</th><th>xG</th><th>Tiri</th><th>Campionato</th></tr>
                  </thead>
                  <tbody>
                    {filteredMatches.slice(0, 80).map((m: any) => (
                      <tr key={m.match_id}>
                        <td className="fp-mono" style={{ color: 'var(--text-2)', fontSize: 12 }}>{new Date(m.date).toLocaleDateString('it-IT')}</td>
                        <td style={{ fontWeight: 700 }}>{m.home_team_name ?? m.home_team_id}</td>
                        <td style={{ textAlign: 'center' }}><span className="dm-score">{m.home_goals ?? '-'} - {m.away_goals ?? '-'}</span></td>
                        <td style={{ fontWeight: 700 }}>{m.away_team_name ?? m.away_team_id}</td>
                        <td className="fp-mono" style={{ color: 'var(--text-2)', fontSize: 12 }}>
                          {(m.home_xg !== null && m.home_xg !== undefined && m.away_xg !== null && m.away_xg !== undefined)
                            ? `${n(m.home_xg, 1)} - ${n(m.away_xg, 1)}`
                            : '-'}
                        </td>
                        <td className="fp-mono" style={{ color: 'var(--text-2)', fontSize: 12 }}>
                          {(m.home_shots !== null && m.home_shots !== undefined && m.away_shots !== null && m.away_shots !== undefined)
                            ? `${m.home_shots} - ${m.away_shots}`
                            : '-'}
                        </td>
                        <td><span className="dm-comp-tag">{m.competition}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/*  TEAMS  */}
        {activeTab === 'teams' && (
          <div className="fp-card">
            <div className="fp-card-head">
              <div className="fp-card-title"> Squadre ({filteredTeams.length})</div>
              <span className="fp-badge fp-badge-purple">Clicca per stats complete</span>
            </div>

            {competitions.length > 1 && (
              <div className="dm-comp-pills">
                <button className={`fp-pill-btn${!competitionFilter ? ' active' : ''}`} onClick={() => setCompetitionFilter('')}>Tutte</button>
                {competitions.map(c => (
                  <button key={c} className={`fp-pill-btn${competitionFilter === c ? ' active' : ''}`} onClick={() => setCompetitionFilter(c)}>{c}</button>
                ))}
              </div>
            )}

            <div className="dm-team-grid">
              {filteredTeams.map((t: any) => (
                <button
                  key={t.team_id}
                  className={`fp-clickable dm-team-card${selectedTeamId === String(t.team_id) ? ' selected' : ''}`}
                  onClick={() => { setSelectedTeamId(String(t.team_id)); setScope('current'); }}
                >
                  <div className="dm-team-name">{t.name}</div>
                  <div className="dm-team-comp">{t.competition ?? ''}</div>
                  <div className="dm-team-badges">
                    <span className="fp-badge fp-badge-blue">ATT {n(t.attack_strength, 2)}</span>
                    <span className="fp-badge fp-badge-red">DIF {n(t.defence_strength, 2)}</span>
                  </div>
                </button>
              ))}
            </div>

            {selectedTeam && (
              <div className="dm-detail">
                <div className="dm-detail-head">
                  <div>
                    <div className="dm-detail-name">{selectedTeam.name}</div>
                    <div className="dm-detail-comp">{selectedTeam.competition ?? ''}</div>
                  </div>
                  <div className="dm-scope-tabs">
                    {([
                      { id: 'current'  as TeamScope, label: `Stagione corrente${currentTeamSeason ? ` (${currentTeamSeason})` : ''}` },
                      { id: 'previous' as TeamScope, label: 'Precedenti' },
                      { id: 'total'    as TeamScope, label: 'Totale' },
                    ] as const).map(({ id, label }) => (
                      <button key={id} className={`dm-scope-tab${scope === id ? ' active' : ''}`} onClick={() => setScope(id)}>{label}</button>
                    ))}
                  </div>
                </div>

                {/* W/D/L */}
                <div className="dm-record">
                  <div className="dm-rec-box w"><div className="dm-rec-val w">{stats.w}</div><div className="dm-rec-lbl" style={{ color: 'var(--green)' }}>Vinte</div></div>
                  <div className="dm-rec-box d"><div className="dm-rec-val d">{stats.d}</div><div className="dm-rec-lbl" style={{ color: 'var(--blue)' }}>Pari</div></div>
                  <div className="dm-rec-box l"><div className="dm-rec-val l">{stats.l}</div><div className="dm-rec-lbl" style={{ color: 'var(--red)' }}>Perse</div></div>
                </div>

                <div className="dm-stats-grid">
                  <div className="dm-stats-panel">
                    <div className="dm-stats-head fotmob"> Stats Partite (FotMob)</div>
                    <table className="dm-stats-table">
                      <tbody>
                        {[
                          ['Partite', stats.p],
                          ['Punti', `${stats.pts} (${n(stats.ppg, 2)} ppg)`],
                          ['Win Rate', `${n(stats.wr * 100, 1)}%`],
                          ['Gol fatti / subiti', `${stats.gf} / ${stats.ga} (${stats.gd >= 0 ? '+' : ''}${stats.gd})`],
                          ['xG fatto / subito', `${n(stats.xgfAvg, 2)} / ${n(stats.xgaAvg, 2)}`],
                          ['Tiri fatti / subiti', `${n(stats.sfAvg, 2)} / ${n(stats.saAvg, 2)}`],
                          ['Tiri in porta (OT) fatti / subiti', `${n(stats.sotfAvg, 2)} / ${n(stats.sotaAvg, 2)}`],
                          ['Falli / partita', n(stats.foulsAvg, 2)],
                          ['Gialli / partita', n(stats.ycAvg, 2)],
                          ['Rossi / partita', n(stats.rcAvg, 3)],
                          ['Possesso medio', stats.possAvg !== null ? `${n(stats.possAvg, 1)}%` : ''],
                          ['Match FotMob', stats.fotmob],
                        ].map(([l, v]) => <tr key={String(l)}><td>{l}</td><td>{String(v)}</td></tr>)}
                      </tbody>
                    </table>
                  </div>

                  <div className="dm-stats-panel">
                    <div className="dm-stats-head model"> Stats Modello AI</div>
                    <table className="dm-stats-table">
                      <tbody>
                        {[
                          ['Attack Strength',   n(selectedTeam.attack_strength, 3)],
                          ['Defence Strength',  n(selectedTeam.defence_strength, 3)],
                          ['Avg Home Shots',    n(selectedTeam.avg_home_shots, 2)],
                          ['Avg Away Shots',    n(selectedTeam.avg_away_shots, 2)],
                          ['Avg Home Shots On Target (OT)', n(selectedTeam.avg_home_shots_ot, 2)],
                          ['Avg Away Shots On Target (OT)', n(selectedTeam.avg_away_shots_ot, 2)],
                          ['Avg Home xG',       n(selectedTeam.avg_home_xg, 2)],
                          ['Avg Away xG',       n(selectedTeam.avg_away_xg, 2)],
                          ['Avg Yellow Cards',  n(selectedTeam.avg_yellow_cards, 2)],
                          ['Avg Red Cards',     n(selectedTeam.avg_red_cards, 3)],
                          ['Avg Fouls',         n(selectedTeam.avg_fouls, 2)],
                          ['Shots Suppression', n(selectedTeam.shots_suppression, 3)],
                        ].map(([l, v]) => <tr key={String(l)}><td>{l}</td><td>{String(v)}</td></tr>)}
                      </tbody>
                    </table>
                  </div>
                </div>

                {/* PLAYERS */}
                <div className="dm-players-head">
                  <div className="dm-players-title"> Giocatori</div>
                  <span className="fp-badge fp-badge-blue">
                    {playersLoading === selectedTeam.team_id ? 'Caricamento' : `${players.length} giocatori`}
                  </span>
                </div>
                {playersLoading === selectedTeam.team_id ? (
                  <div className="fp-spinner-wrap"><div className="fp-spinner" /></div>
                ) : players.length === 0 ? (
                  <div className="fp-alert fp-alert-info">Nessun giocatore disponibile. Esegui import da FotMob.</div>
                ) : (
                  <div style={{ overflowX: 'auto' }}>
                    <table className="fp-table">
                      <thead>
                        <tr><th>Nome</th><th>Ruolo</th><th>PG</th><th>Tiri/G</th><th>Tiri in porta (OT)/G</th><th>xG/G</th><th>xGOT/G</th><th>Gol</th><th>Shot share</th></tr>
                      </thead>
                      <tbody>
                        {players.map((p: any) => (
                          <tr key={p.player_id}>
                            <td style={{ fontWeight: 700 }}>{p.name}</td>
                            <td><span className="fp-badge fp-badge-purple">{p.position_code}</span></td>
                            <td className="fp-mono">{p.games_played ?? 0}</td>
                            <td className="fp-mono">{n(p.avg_shots_per_game, 2)}</td>
                            <td className="fp-mono">{n(p.avg_shots_on_target_per_game, 2)}</td>
                            <td className="fp-mono">{n(p.avg_xg_per_game, 3)}</td>
                            <td className="fp-mono">{n(p.avg_xgot_per_game, 3)}</td>
                            <td className="fp-mono" style={{ color: 'var(--green)', fontWeight: 700 }}>{p.total_goals ?? 0}</td>
                            <td className="fp-mono" style={{ color: 'var(--text-2)' }}>{n((Number(p.shot_share_of_team) || 0) * 100, 1)}%</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/*  MODEL  */}
        {activeTab === 'model' && (
          <div>
            <div className="fp-card" style={{ marginBottom: 16 }}>
              <div className="fp-card-head"><div className="fp-card-title">Pipeline Modello</div></div>
              <div className="fp-card-body">
                <div className="fp-alert fp-alert-info">
                  Dopo ogni import FotMob il sistema esegue automaticamente:
                  <strong> ricalcolo medie squadre</strong> e <strong>fit del modello Dixon-Coles</strong> per i campionati importati.
                </div>
                <div className="dm-model-grid" style={{ marginTop: 12 }}>
                  <div className="fp-card">
                    <div className="fp-card-head"><div className="fp-card-title">Ricalcolo Medie</div></div>
                    <div className="fp-card-body">
                      <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.6, margin: 0 }}>
                        Automatico su import: aggiorna tiri, xG, cartellini, falli e fattore difensivo per squadra.
                      </p>
                    </div>
                  </div>
                  <div className="fp-card">
                    <div className="fp-card-head"><div className="fp-card-title">Fit Modello</div></div>
                    <div className="fp-card-body">
                      <p style={{ fontSize: 13, color: 'var(--text-2)', lineHeight: 1.6, margin: 0 }}>
                        Automatico su import: aggiorna parametri attack/defence e salva i parametri modello più recenti.
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/*  IMPORT  */}
        {activeTab === 'import' && (
          <div className="fp-card">
            <div className="fp-card-head"><div className="fp-card-title"> Import Manuale JSON</div></div>
            <div className="fp-card-body" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              <div className="dm-form-group">
                <label className="fp-label">Array JSON Partite</label>
                <textarea className="dm-textarea" value={importJson} onChange={e => setImportJson(e.target.value)}
                  placeholder={'[\n  {\n    "home_team": "...",\n    "away_team": "...",\n    "home_goals": 2,\n    "away_goals": 1,\n    "date": "2024-12-01",\n    "competition": "Serie A"\n  }\n]'} />
              </div>
              <div className="dm-import-hint">
                Accetta un array JSON o un oggetto con chiave <code>matches</code>. Campi obbligatori: <code>home_team</code>, <code>away_team</code>, <code>home_goals</code>, <code>away_goals</code>, <code>date</code>, <code>competition</code>.
              </div>
              <button className="dm-action-btn purple" style={{ maxWidth: 280 }} onClick={handleBulkImport} disabled={!importJson}>
                 Importa Dati
              </button>
              {importResult && (
                <div className={`dm-result ${importResult.success ? 'ok' : 'err'}`}>
                  {importResult.success
                    ? ` Importate ${importResult.data?.imported ?? importResult.imported} partite con successo!`
                    : ` Errore: ${importResult.error}`}
                </div>
              )}
            </div>
          </div>
        )}

      </div>
    </>
  );
};

export default DataManager;

