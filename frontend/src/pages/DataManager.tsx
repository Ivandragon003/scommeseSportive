import React, { useState, useEffect } from 'react';
import { getTeams, getMatches, fitModel, bulkImportMatches, recomputeAverages } from '../utils/api';

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

  useEffect(() => { loadData(); }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [teamsRes, matchesRes] = await Promise.all([getTeams(), getMatches()]);
      setTeams(teamsRes.data ?? []);
      const orderedMatches = [...(matchesRes.data ?? [])]
        .sort((a: any, b: any) => new Date(b.date).getTime() - new Date(a.date).getTime());
      setMatches(orderedMatches.slice(0, 500));
    } catch {}
    setLoading(false);
  };

  const handleFitModel = async () => {
    if (!fitForm.competition) { alert('Inserisci la competizione'); return; }
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
    } catch (e: any) { alert('Errore: ' + e.message); }
    setRecomputeLoading(false);
  };

  const handleBulkImport = async () => {
    try {
      const data = JSON.parse(importJson);
      const matchesArr = Array.isArray(data) ? data : data.matches;
      if (!Array.isArray(matchesArr)) { alert('Formato non valido.'); return; }
      const res = await bulkImportMatches(matchesArr);
      setImportResult(res);
      await loadData();
    } catch (e: any) { alert('Errore import: ' + (e.message ?? 'JSON non valido')); }
  };

  const competitions = Array.from(new Set(teams.map((t: any) => t.competition).filter(Boolean)));
  const seasons = Array.from(
    new Set(
      matches
        .map((m: any) => String(m.season ?? '').trim())
        .filter(Boolean)
    )
  ).sort((a, b) => b.localeCompare(a, undefined, { numeric: true, sensitivity: 'base' }));
  const years = Array.from(
    new Set(
      matches
        .map((m: any) => new Date(m.date).getFullYear())
        .filter((y: number) => Number.isFinite(y))
        .map((y: number) => String(y))
    )
  ).sort((a, b) => Number(b) - Number(a));
  const filteredMatches = matches.filter((m: any) => {
    if (competitionFilter && m.competition !== competitionFilter) return false;
    if (seasonFilter && String(m.season ?? '') !== seasonFilter) return false;
    if (yearFilter) {
      const matchYear = new Date(m.date).getFullYear();
      if (!Number.isFinite(matchYear) || String(matchYear) !== yearFilter) return false;
    }
    return true;
  });
  const filteredTeams = competitionFilter ? teams.filter(t => t.competition === competitionFilter) : teams;
  const isEmpty = matches.length === 0 && teams.length === 0 && !loading;

  const tabs = [
    { id: 'overview', label: '📊 Overview' },
    { id: 'matches', label: `⚽ Partite${matches.length > 0 ? ` (${matches.length})` : ''}` },
    { id: 'teams', label: `🏟️ Squadre${teams.length > 0 ? ` (${teams.length})` : ''}` },
    { id: 'model', label: '🧠 Modello AI' },
    { id: 'import', label: '📥 Import JSON' },
  ];

  return (
    <div>
      <style>{`
        .dm-stat { background:#fff; border:1px solid var(--border); border-radius:10px; padding:18px 20px; display:flex; align-items:center; gap:14px; }
        .dm-stat-icon { width:44px; height:44px; border-radius:9px; display:flex; align-items:center; justify-content:center; font-size:20px; flex-shrink:0; }
        .dm-stat-num { font-size:26px; font-weight:800; color:var(--text); line-height:1; }
        .dm-stat-lbl { font-size:12px; color:var(--text-secondary); margin-top:2px; }
        .dm-tabs { display:flex; gap:0; border-bottom:2px solid var(--border); margin-bottom:20px; overflow-x:auto; }
        .dm-tab { padding:10px 18px; border:none; background:none; cursor:pointer; font-size:13px; color:var(--text-secondary); border-bottom:2px solid transparent; margin-bottom:-2px; transition:all 0.15s; white-space:nowrap; }
        .dm-tab:hover { color:var(--primary); }
        .dm-tab.on { color:var(--primary); border-bottom-color:var(--primary); font-weight:600; }
        .dm-filters { display:flex; gap:6px; flex-wrap:wrap; margin-bottom:14px; }
        .dm-filter { padding:5px 12px; border-radius:20px; border:1px solid var(--border); background:#fff; cursor:pointer; font-size:12px; color:var(--text-secondary); transition:all 0.15s; }
        .dm-filter.on { background:var(--primary); color:#fff; border-color:var(--primary); }
        .dm-team-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(175px,1fr)); gap:10px; }
        .dm-team { background:#fff; border:1px solid var(--border); border-radius:10px; padding:14px; transition:all 0.2s; }
        .dm-team:hover { border-color:var(--primary); box-shadow:0 4px 12px rgba(26,115,232,0.1); transform:translateY(-1px); }
        .dm-team-name { font-size:14px; font-weight:700; color:var(--text); margin-bottom:3px; }
        .dm-team-comp { font-size:10px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.07em; margin-bottom:10px; }
        .dm-mini-stats { display:flex; gap:5px; }
        .dm-mini-stat { flex:1; background:var(--bg); border-radius:6px; padding:6px 3px; text-align:center; }
        .dm-mini-val { font-size:12px; font-weight:700; color:var(--primary); display:block; }
        .dm-mini-lbl { font-size:9px; color:var(--text-secondary); text-transform:uppercase; }
        .dm-step { background:#fff; border:1px solid var(--border); border-radius:10px; padding:20px; margin-bottom:12px; }
        .dm-step-row { display:flex; gap:14px; align-items:flex-start; margin-bottom:14px; }
        .dm-step-num { width:30px; height:30px; border-radius:50%; background:var(--primary-light); color:var(--primary); font-weight:800; font-size:13px; display:flex; align-items:center; justify-content:center; flex-shrink:0; margin-top:1px; }
        .dm-step-title { font-size:14px; font-weight:600; color:var(--text); margin-bottom:3px; }
        .dm-step-desc { font-size:12px; color:var(--text-secondary); line-height:1.5; }
        .dm-howto { background:#fff; border:1px solid var(--border); border-radius:10px; overflow:hidden; }
        .dm-howto-item { display:flex; align-items:flex-start; gap:12px; padding:14px 16px; border-bottom:1px solid var(--border); }
        .dm-howto-item:last-child { border-bottom:none; }
        .dm-howto-num { width:24px; height:24px; border-radius:50%; background:var(--primary); color:#fff; font-weight:700; font-size:12px; display:flex; align-items:center; justify-content:center; flex-shrink:0; margin-top:1px; }
        .dm-howto-title { font-size:13px; font-weight:600; color:var(--text); margin-bottom:2px; }
        .dm-howto-desc { font-size:12px; color:var(--text-secondary); line-height:1.4; }
        .dm-score { background:var(--primary-light); color:var(--primary); border-radius:5px; padding:3px 9px; font-weight:700; font-size:12px; font-family:monospace; }
      `}</style>

      <h1 className="page-title">🗄️ Gestione Dati</h1>
      <p className="page-subtitle">Database storico partite e addestramento modello Dixon-Coles</p>

      {/* Stat cards */}
      <div className="grid-4" style={{ marginBottom: 20 }}>
        {[
          { icon: '⚽', bg: '#e8f0fe', val: loading ? '…' : matches.length, lbl: 'Partite nel DB' },
          { icon: '🏟️', bg: '#e6f4ea', val: loading ? '…' : teams.length, lbl: 'Squadre' },
          { icon: '🏆', bg: '#fef7e0', val: loading ? '…' : competitions.length, lbl: 'Campionati' },
          { icon: '🧠', bg: '#fce8e6', val: teams.filter((t:any) => t.attack_strength).length, lbl: 'Squadre col modello' },
        ].map(s => (
          <div key={s.lbl} className="dm-stat">
            <div className="dm-stat-icon" style={{ background: s.bg }}>{s.icon}</div>
            <div>
              <div className="dm-stat-num">{s.val}</div>
              <div className="dm-stat-lbl">{s.lbl}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div className="dm-tabs">
        {tabs.map(t => (
          <button key={t.id} className={`dm-tab ${activeTab === t.id ? 'on' : ''}`} onClick={() => setActiveTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>

      {/* OVERVIEW */}
      {activeTab === 'overview' && (
        <div>
          {isEmpty ? (
            <div className="card" style={{ textAlign: 'center', padding: '48px 24px' }}>
              <div style={{ fontSize: 56, marginBottom: 16 }}>📭</div>
              <h2 style={{ fontSize: 20, fontWeight: 700, marginBottom: 8 }}>Database vuoto</h2>
              <p style={{ color: 'var(--text-secondary)', maxWidth: 400, margin: '0 auto 20px', fontSize: 14, lineHeight: 1.6 }}>
                Nessun dato nel database. Vai su <strong>Dati Automatici</strong> e scarica le statistiche
                storiche da FotMob in pochi clic con import automatico Playwright.
              </p>
            </div>
          ) : (
            <div className="card" style={{ marginBottom: 16 }}>
              <div className="card-header"><h2 className="card-title">✅ Database attivo</h2></div>
              <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                {competitions.map(c => (
                  <div key={c} style={{ background: 'var(--primary-light)', color: 'var(--primary)', borderRadius: 8, padding: '8px 16px', fontWeight: 600, fontSize: 13 }}>
                    🏆 {c} — {matches.filter(m => m.competition === c).length} partite
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="dm-howto">
            {[
              { n: 1, title: 'Scarica i dati da FotMob', desc: 'Vai su Dati Automatici e avvia import singolo o Top-5. Import incrementale automatico.' },
              { n: 2, title: 'Ricalcola le medie squadre', desc: 'Tab Modello AI → Ricalcola Medie. Aggiorna tiri, falli, cartellini per casa/trasferta. Eseguilo dopo ogni import.' },
              { n: 3, title: 'Addestra il modello Dixon-Coles', desc: 'Tab Modello AI → Addestra. Stima forza attacco/difesa per ogni squadra con decadimento temporale.' },
              { n: 4, title: 'Analizza le partite', desc: 'Vai su Previsioni, scegli le due squadre e ottieni probabilità su tutti i mercati + value bet con Kelly criterion.' },
            ].map(item => (
              <div key={item.n} className="dm-howto-item">
                <div className="dm-howto-num">{item.n}</div>
                <div>
                  <div className="dm-howto-title">{item.title}</div>
                  <div className="dm-howto-desc">{item.desc}</div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* PARTITE */}
      {activeTab === 'matches' && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">⚽ Partite nel Database</h2>
            <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>mostrate prime {Math.min(80, filteredMatches.length)}</span>
          </div>
          {competitions.length > 1 && (
            <div className="dm-filters">
              <button className={`dm-filter ${!competitionFilter ? 'on' : ''}`} onClick={() => setCompetitionFilter('')}>
                Tutti ({matches.length})
              </button>
              {competitions.map(c => (
                <button key={c} className={`dm-filter ${competitionFilter === c ? 'on' : ''}`} onClick={() => setCompetitionFilter(c)}>
                  {c} ({matches.filter(m => m.competition === c).length})
                </button>
              ))}
            </div>
          )}
          <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap' }}>
            <div>
              <label className="form-label" style={{ marginBottom: 4, fontSize: 11 }}>Stagione</label>
              <select
                className="form-select"
                value={seasonFilter}
                onChange={e => setSeasonFilter(e.target.value)}
                style={{ minWidth: 160 }}
              >
                <option value="">Tutte</option>
                {seasons.map((s: string) => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="form-label" style={{ marginBottom: 4, fontSize: 11 }}>Anno</label>
              <select
                className="form-select"
                value={yearFilter}
                onChange={e => setYearFilter(e.target.value)}
                style={{ minWidth: 120 }}
              >
                <option value="">Tutti</option>
                {years.map((y: string) => (
                  <option key={y} value={y}>{y}</option>
                ))}
              </select>
            </div>
          </div>
          {filteredMatches.length === 0 ? (
            <div className="alert alert-info">
              Nessuna partita nel database. Vai su <strong>Dati Automatici</strong> per scaricarle automaticamente da FotMob.
            </div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table>
                <thead>
                  <tr>
                    <th>Data</th><th>Casa</th><th style={{ textAlign: 'center' }}>Risultato</th>
                    <th>Ospite</th><th>xG</th><th>Tiri</th><th>Campionato</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredMatches.slice(0, 80).map((m: any) => (
                    <tr key={m.match_id}>
                      <td style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>
                        {new Date(m.date).toLocaleDateString('it-IT')}
                      </td>
                      <td style={{ fontWeight: 600 }}>{m.home_team_name ?? m.home_team_id}</td>
                      <td style={{ textAlign: 'center' }}>
                        {m.home_goals !== null && m.home_goals !== undefined
                          ? <span className="dm-score">{m.home_goals} – {m.away_goals}</span>
                          : <span className="badge badge-gray">TBD</span>}
                      </td>
                      <td style={{ fontWeight: 600 }}>{m.away_team_name ?? m.away_team_id}</td>
                      <td style={{ fontSize: 12, color: 'var(--secondary)' }}>
                        {m.home_xg ? `${parseFloat(m.home_xg).toFixed(1)} – ${parseFloat(m.away_xg).toFixed(1)}` : '—'}
                      </td>
                      <td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                        {m.home_shots ? `${m.home_shots} – ${m.away_shots}` : '—'}
                      </td>
                      <td><span className="badge badge-blue">{m.competition}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* SQUADRE */}
      {activeTab === 'teams' && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">🏟️ Squadre</h2>
            <span className="badge badge-green">Create automaticamente dal feed FotMob — nessun inserimento manuale</span>
          </div>
          {competitions.length > 1 && (
            <div className="dm-filters">
              <button className={`dm-filter ${!competitionFilter ? 'on' : ''}`} onClick={() => setCompetitionFilter('')}>
                Tutte ({teams.length})
              </button>
              {competitions.map(c => (
                <button key={c} className={`dm-filter ${competitionFilter === c ? 'on' : ''}`} onClick={() => setCompetitionFilter(c)}>
                  {c} ({teams.filter(t => t.competition === c).length})
                </button>
              ))}
            </div>
          )}
          {filteredTeams.length === 0 ? (
            <div className="alert alert-info">
              Nessuna squadra. Vengono create automaticamente quando importi i dati da FotMob —
              non è necessario inserirle manualmente.
            </div>
          ) : (
            <div className="dm-team-grid">
              {filteredTeams.map((t: any) => (
                <div key={t.team_id} className="dm-team">
                  <div className="dm-team-name">{t.name}</div>
                  <div className="dm-team-comp">{t.competition ?? '—'}</div>
                  <div className="dm-mini-stats">
                    {[
                      { v: t.attack_strength?.toFixed(2) ?? '—', l: 'ATT' },
                      { v: t.defence_strength?.toFixed(2) ?? '—', l: 'DIF' },
                      { v: t.avg_home_xg?.toFixed(1) ?? '—', l: 'xG' },
                    ].map(s => (
                      <div key={s.l} className="dm-mini-stat">
                        <span className="dm-mini-val">{s.v}</span>
                        <span className="dm-mini-lbl">{s.l}</span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* MODELLO */}
      {activeTab === 'model' && (
        <div>
          <div className="alert alert-info" style={{ marginBottom: 16 }}>
            <strong>Dixon-Coles:</strong> stima forza attacco e difesa di ogni squadra tramite log-verosimiglianza
            con correzione τ e decadimento temporale (half-life ~36 settimane).
            I dati recenti pesano di più nelle stime.
          </div>
          <div className="card" style={{ marginBottom: 12 }}>
            <div className="card-header"><h2 className="card-title">Parametri</h2></div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Competizione *</label>
                <select className="form-select" value={fitForm.competition} onChange={e => setFitForm(p => ({ ...p, competition: e.target.value }))}>
                  {['Serie A','Premier League','La Liga','Bundesliga','Ligue 1','Champions League'].map(c => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Stagione (vuoto = tutte)</label>
                <input className="form-input" value={fitForm.season} onChange={e => setFitForm(p => ({ ...p, season: e.target.value }))} placeholder="es. 2024-2025" />
              </div>
            </div>
          </div>
          <div className="dm-step">
            <div className="dm-step-row">
              <div className="dm-step-num">1</div>
              <div>
                <div className="dm-step-title">Ricalcola medie statistiche squadre</div>
                <div className="dm-step-desc">Aggiorna tiri, falli, cartellini e possesso per casa/trasferta. Eseguilo dopo ogni import FotMob.</div>
              </div>
            </div>
            <button className="btn btn-secondary" onClick={handleRecompute} disabled={recomputeLoading}>
              {recomputeLoading ? '⏳ Ricalcolo...' : '🔄 Ricalcola Medie Squadre'}
            </button>
            {recomputeResult && (
              <div className="alert alert-success" style={{ marginTop: 10 }}>
                ✅ Aggiornate <strong>{recomputeResult.data?.teamsUpdated ?? recomputeResult.teamsUpdated}</strong> squadre.
              </div>
            )}
          </div>
          <div className="dm-step">
            <div className="dm-step-row">
              <div className="dm-step-num">2</div>
              <div>
                <div className="dm-step-title">Addestra modello Dixon-Coles</div>
                <div className="dm-step-desc">Stima parametri attacco/difesa. Richiede almeno 5-6 partite per squadra. Dopo l'addestramento, le previsioni saranno disponibili.</div>
              </div>
            </div>
            <button className="btn btn-primary" onClick={handleFitModel} disabled={fitLoading}>
              {fitLoading ? '⏳ Addestramento...' : '🧠 Addestra Modello'}
            </button>
            {fitResult && (
              <div className="alert alert-success" style={{ marginTop: 10 }}>
                ✅ <strong>Modello addestrato!</strong> Partite: <strong>{fitResult.matchesUsed}</strong> · Squadre: <strong>{fitResult.teams}</strong> · Log-likelihood: <strong>{fitResult.logLikelihood?.toFixed(2)}</strong>
              </div>
            )}
          </div>
        </div>
      )}

      {/* IMPORT JSON */}
      {activeTab === 'import' && (
        <div className="card">
          <div className="card-header">
            <h2 className="card-title">📥 Import Manuale JSON</h2>
            <span className="badge badge-gray">Opzionale</span>
          </div>
          <div className="alert alert-info" style={{ marginBottom: 14 }}>
            Usa questa sezione solo per dati da fonti esterne. Per FotMob usa <strong>Dati Automatici</strong>.
            Le squadre vengono create automaticamente.
          </div>
          <div className="form-group">
            <label className="form-label">Array JSON partite</label>
            <textarea
              className="form-input"
              style={{ height: 160, fontFamily: 'monospace', fontSize: 12, resize: 'vertical' }}
              placeholder='[{"matchId":"...","homeTeamId":"inter","awayTeamId":"milan","date":"2024-01-15","homeGoals":2,"awayGoals":1,"competition":"Serie A"}]'
              value={importJson}
              onChange={e => setImportJson(e.target.value)}
            />
          </div>
          <button className="btn btn-primary" onClick={handleBulkImport} disabled={!importJson}>
            📥 Importa Dati
          </button>
          {importResult && (
            <div className={`alert ${importResult.success ? 'alert-success' : 'alert-danger'}`} style={{ marginTop: 12 }}>
              {importResult.success
                ? `✅ Importate ${importResult.data?.imported ?? importResult.imported} partite!`
                : `❌ Errore: ${importResult.error}`}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default DataManager;
