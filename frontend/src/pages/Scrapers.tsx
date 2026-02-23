import React, { useState, useEffect } from 'react';
import axios from 'axios';

const API = axios.create({ baseURL: '/api', timeout: 900000 });

const COMPETITIONS = ['Serie A', 'Premier League', 'La Liga', 'Bundesliga', 'Ligue 1'];

const generateSeasons = (n: number): string[] => {
  const now = new Date();
  const start = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  return Array.from({ length: n }, (_, i) => `${start - i}/${start - i + 1}`).reverse();
};

const formatDate = (iso: string) => {
  try { return new Date(iso).toLocaleString('it-IT', { weekday: 'short', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }); }
  catch { return iso; }
};

export default function Scrapers() {
  const [activeTab, setActiveTab] = useState<'fotmob' | 'odds'>('fotmob');

  // fotmob
  const [fotmobComp, setFotmobComp] = useState('Serie A');
  const [fotmobYears, setFotmobYears] = useState(2);
  const [fotmobImportPlayers, setFotmobImportPlayers] = useState(false);
  const [fotmobLoading, setFotmobLoading] = useState(false);
  const [fotmobResult, setFotmobResult] = useState<any>(null);
  const [fotmobError, setFotmobError] = useState<string | null>(null);

  // odds
  const [oddsKey, setOddsKey] = useState(() => {
    try { return localStorage.getItem('oddsApiKey') ?? ''; } catch { return ''; }
  });
  const [oddsComp, setOddsComp] = useState('Serie A');
  const [oddsLoading, setOddsLoading] = useState(false);
  const [oddsMatches, setOddsMatches] = useState<any[]>([]);
  const [oddsError, setOddsError] = useState<string | null>(null);
  const [remainingReq, setRemainingReq] = useState<number | null>(null);

  useEffect(() => {
    try { localStorage.setItem('oddsApiKey', oddsKey); } catch {}
  }, [oddsKey]);

  const handleFotmob = async (mode: 'single' | 'top5') => {
    setFotmobLoading(true); setFotmobError(null); setFotmobResult(null);
    try {
      const res = await API.post('/scraper/fotmob', {
        mode,
        competition: fotmobComp,
        yearsBack: fotmobYears,
        importPlayers: fotmobImportPlayers,
      });
      setFotmobResult(res.data.data);
    } catch (e: any) { setFotmobError(e.response?.data?.error ?? e.message); }
    setFotmobLoading(false);
  };

  const handleOdds = async () => {
    if (!oddsKey.trim()) { setOddsError('Inserisci la API key'); return; }
    setOddsLoading(true); setOddsError(null); setOddsMatches([]);
    try {
      const res = await API.post('/scraper/odds', { apiKey: oddsKey, competition: oddsComp, markets: ['h2h', 'totals'] });
      setOddsMatches(res.data.data.matches ?? []);
      setRemainingReq(res.data.data.remainingRequests ?? null);
    } catch (e: any) { setOddsError(e.response?.data?.error ?? e.message); }
    setOddsLoading(false);
  };

  const seasons = generateSeasons(fotmobYears);

  return (
    <div>
      <style>{`
        .sc-tab-bar { display:flex; border-bottom:2px solid var(--border); margin-bottom:20px; }
        .sc-tab { padding:11px 22px; border:none; background:none; cursor:pointer; font-size:14px; color:var(--text-secondary); border-bottom:2px solid transparent; margin-bottom:-2px; transition:all 0.15s; display:flex; align-items:center; gap:8px; }
        .sc-tab:hover { color:var(--primary); }
        .sc-tab.on { color:var(--primary); border-bottom-color:var(--primary); font-weight:600; }
        .sc-comp-grid { display:flex; flex-wrap:wrap; gap:7px; }
        .sc-comp { padding:7px 14px; border-radius:20px; border:1px solid var(--border); background:#fff; cursor:pointer; font-size:13px; color:var(--text-secondary); transition:all 0.15s; font-weight:500; }
        .sc-comp:hover { border-color:var(--primary); color:var(--primary); }
        .sc-comp.on { background:var(--primary); color:#fff; border-color:var(--primary); }
        .sc-year-grid { display:flex; gap:10px; }
        .sc-year { flex:1; padding:14px 8px; border-radius:10px; border:1px solid var(--border); background:#fff; cursor:pointer; text-align:center; transition:all 0.15s; }
        .sc-year:hover { border-color:var(--primary); }
        .sc-year.on { border-color:var(--primary); background:var(--primary-light); }
        .sc-year-num { font-size:22px; font-weight:800; color:var(--primary); display:block; }
        .sc-year-lbl { font-size:11px; color:var(--text-secondary); }
        .sc-how { background:var(--bg); border-radius:8px; padding:14px 16px; display:grid; grid-template-columns:1fr 1fr; gap:10px; margin-bottom:20px; }
        .sc-how-item { display:flex; gap:10px; align-items:flex-start; }
        .sc-how-icon { font-size:18px; flex-shrink:0; }
        .sc-how-text { font-size:13px; color:var(--text-secondary); line-height:1.4; }
        .sc-big-btn { width:100%; padding:15px; border-radius:10px; border:none; background:var(--primary); color:#fff; font-size:15px; font-weight:700; cursor:pointer; transition:all 0.2s; display:flex; align-items:center; justify-content:center; gap:10px; }
        .sc-big-btn:hover:not(:disabled) { background:var(--primary-dark); transform:translateY(-1px); box-shadow:0 4px 14px rgba(26,115,232,0.3); }
        .sc-big-btn:disabled { opacity:0.6; cursor:not-allowed; transform:none; box-shadow:none; }
        .sc-result-row { display:flex; justify-content:space-between; padding:7px 0; border-bottom:1px solid var(--border); font-size:13px; }
        .sc-result-row:last-child { border-bottom:none; }
        .sc-data-row { display:grid; grid-template-columns:2fr 1fr 2fr; gap:16px; padding:10px 14px; align-items:center; }
        .sc-data-row:nth-child(even) { background:var(--bg); }
        .sc-key-row { display:flex; gap:10px; align-items:center; }
        .sc-saved { background:#e6f4ea; color:#1e8e3e; border-radius:6px; padding:5px 10px; font-size:12px; font-weight:600; white-space:nowrap; }
        @keyframes spin { to { transform:rotate(360deg); } }
        .sc-spin { display:inline-block; animation:spin 0.8s linear infinite; }
      `}</style>

      <h1 className="page-title">🌐 Dati Automatici</h1>
      <p className="page-subtitle">Scarica statistiche storiche e quote live in automatico</p>

      <div className="sc-tab-bar">
        <button className={`sc-tab ${activeTab === 'fotmob' ? 'on' : ''}`} onClick={() => setActiveTab('fotmob')}>
          📊 Statistiche FotMob
          <span className="badge badge-green" style={{ fontSize: 11 }}>Gratuito</span>
        </button>
        <button className={`sc-tab ${activeTab === 'odds' ? 'on' : ''}`} onClick={() => setActiveTab('odds')}>
          💰 Quote Live (Odds API)
        </button>
      </div>

      {/* ===== FOTMOB ===== */}
      {activeTab === 'fotmob' && (
        <div>
          <div className="card">
            <div className="card-header">
              <div>
                <div className="card-title">📊 Download da FotMob</div>
                <div className="card-subtitle">Playwright + import incrementale automatico</div>
              </div>
            </div>

            <div className="sc-how">
              {[
                { icon: '🤖', text: 'Playwright usa endpoint FotMob in modo robusto' },
                { icon: '📥', text: 'Scarica match stats, raw JSON e shotmap giocatori' },
                { icon: '💾', text: 'Aggiorna squadre, partite e statistiche giocatori' },
                { icon: '🔄', text: 'Import singolo o top-5 insieme, con merge incrementale' },
              ].map((item, i) => (
                <div key={i} className="sc-how-item">
                  <span className="sc-how-icon">{item.icon}</span>
                  <span className="sc-how-text">{item.text}</span>
                </div>
              ))}
            </div>

            <div className="form-row" style={{ marginBottom: 20 }}>
              <div className="form-group">
                <label className="form-label">Campionato</label>
                <div className="sc-comp-grid">
                  {COMPETITIONS.map(c => (
                    <button key={c} className={`sc-comp ${fotmobComp === c ? 'on' : ''}`} onClick={() => setFotmobComp(c)}>
                      {c}
                    </button>
                  ))}
                </div>
                <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
                  Top-5 supportati: Serie A, Premier League, La Liga, Bundesliga, Ligue 1.
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Stagioni da scaricare</label>
                <div className="sc-year-grid">
                  {[1, 2, 3].map(n => (
                    <button key={n} className={`sc-year ${fotmobYears === n ? 'on' : ''}`} onClick={() => setFotmobYears(n)}>
                      <span className="sc-year-num">{n}</span>
                      <span className="sc-year-lbl">{n === 1 ? 'stagione' : 'stagioni'}</span>
                    </button>
                  ))}
                </div>
                <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
                  Stagioni: <strong>{seasons.join(' · ')}</strong>
                </div>
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={fotmobImportPlayers}
                  onChange={e => setFotmobImportPlayers(e.target.checked)}
                />
                Aggiorna anche statistiche giocatori (piu lento, possibili 403 FotMob)
              </label>
            </div>

            <div style={{ display: 'grid', gap: 10 }}>
              <button className="sc-big-btn" onClick={() => handleFotmob('single')} disabled={fotmobLoading}>
                {fotmobLoading
                  ? <><span className="sc-spin">⟳</span> Download in corso...</>
                  : `⬇️ Scarica solo ${fotmobComp}`}
              </button>
              <button className="sc-big-btn" onClick={() => handleFotmob('top5')} disabled={fotmobLoading}>
                {fotmobLoading
                  ? <><span className="sc-spin">⟳</span> Download in corso...</>
                  : '🌍 Scarica Top-5 insieme'}
              </button>
            </div>

            {fotmobLoading && (
              <div className="alert alert-info" style={{ marginTop: 12 }}>
                ⏱ Import in corso da FotMob via Playwright.
              </div>
            )}

            {fotmobError && (
              <div className="alert alert-danger" style={{ marginTop: 14 }}>
                <strong>❌ Errore:</strong> {fotmobError}
              </div>
            )}

            {fotmobResult && (
              <div className={`alert ${fotmobResult.isUpToDate ? 'alert-info' : 'alert-success'}`} style={{ marginTop: 14 }}>
                <div style={{ fontWeight: 700, marginBottom: 10, fontSize: 15 }}>
                  {fotmobResult.isUpToDate ? '✅ Database già aggiornato' : '✅ Import completato!'}
                </div>
                {[
                  ['Modalità', fotmobResult.mode],
                  ['Campionati', fotmobResult.competitions?.join(', ')],
                  ['Stagioni', fotmobResult.seasons?.join(', ')],
                  ['Nuove partite importate', fotmobResult.newMatchesImported ?? fotmobResult.imported],
                  ['Partite future importate', fotmobResult.upcomingMatchesImported ?? 0],
                  ['Partite gia presenti aggiornate', fotmobResult.existingMatchesUpdated ?? 0],
                  ['Squadre create', fotmobResult.teamsCreated],
                  ['Giocatori aggiornati', fotmobResult.playersUpdated],
                  ['Squadre con medie ricalcolate', fotmobResult.teamsRecomputed],
                ].map(([k, v]) => (
                  <div key={k as string} className="sc-result-row">
                    <span style={{ color: 'var(--text-secondary)' }}>{k}</span>
                    <strong>{v}</strong>
                  </div>
                ))}
                {!fotmobResult.isUpToDate && (
                  <div style={{ marginTop: 10, padding: '8px 12px', background: 'rgba(52,168,83,0.1)', borderRadius: 6, fontSize: 13 }}>
                    ➡️ Prossimo passo: vai su <strong>Gestione Dati → Modello AI</strong> e addestra Dixon-Coles
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-header"><div className="card-title">📋 Dati disponibili da FotMob</div></div>
            <div style={{ borderRadius: 8, overflow: 'hidden', border: '1px solid var(--border)' }}>
              {[
                ['Risultato (gol)', '✅', 'Modello Dixon-Coles (attacco/difesa)'],
                ['xG', '✅', 'Calibrazione parametro lambda'],
                ['Tiri / tiri in porta', '✅', 'Mercati over/under tiri'],
                ['Possesso, falli, cartellini', '✅', 'Modelli falli/cartellini'],
                ['Shotmap giocatori', '✅', 'Aggiornamento player stats'],
                ['Dati grezzi match', '✅', 'Conservati in JSON per estensioni future'],
              ].map(([campo, disp, uso], i) => (
                <div key={campo} className="sc-data-row" style={i % 2 === 0 ? {} : { background: 'var(--bg)' }}>
                  <span style={{ fontWeight: 500, fontSize: 13 }}>{campo}</span>
                  <span className="badge badge-green" style={{ fontSize: 11 }}>{disp}</span>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{uso}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ===== ODDS ===== */}
      {activeTab === 'odds' && (
        <div>
          <div className="card">
            <div className="card-header">
              <div>
                <div className="card-title">💰 Quote Live — The Odds API</div>
                <div className="card-subtitle">40+ bookmaker incluso Eurobet · Piano gratuito: 500 req/mese</div>
              </div>
              {remainingReq !== null && (
                <span className="badge badge-gray">{remainingReq}/500 richieste rimanenti</span>
              )}
            </div>

            <div className="sc-how">
              {[
                { icon: '🔑', text: 'Registrati gratis su the-odds-api.com e ottieni la API key' },
                { icon: '📡', text: 'Aggrega quote da 40+ bookmaker incluso Eurobet in tempo reale' },
                { icon: '💳', text: '500 richieste/mese gratis (~4 aggiornamenti/settimana per campionato)' },
                { icon: '💾', text: 'La API key viene salvata automaticamente nel browser' },
              ].map((item, i) => (
                <div key={i} className="sc-how-item">
                  <span className="sc-how-icon">{item.icon}</span>
                  <span className="sc-how-text">{item.text}</span>
                </div>
              ))}
            </div>

            <div className="form-group" style={{ marginBottom: 20 }}>
              <label className="form-label">
                API Key
                <a href="https://the-odds-api.com" target="_blank" rel="noreferrer" style={{ marginLeft: 8, fontSize: 11, color: 'var(--primary)', fontWeight: 400 }}>
                  → Registrati gratis
                </a>
              </label>
              <div className="sc-key-row">
                <input
                  className="form-input"
                  type="password"
                  value={oddsKey}
                  onChange={e => setOddsKey(e.target.value)}
                  placeholder="Incolla qui la tua API key..."
                  style={{ flex: 1 }}
                />
                {oddsKey && <span className="sc-saved">✓ Salvata</span>}
              </div>
            </div>

            <div className="form-group" style={{ marginBottom: 20 }}>
              <label className="form-label">Campionato</label>
              <div className="sc-comp-grid">
                {['Serie A', 'Premier League', 'La Liga'].map(c => (
                  <button key={c} className={`sc-comp ${oddsComp === c ? 'on' : ''}`} onClick={() => setOddsComp(c)}>
                    {c}
                  </button>
                ))}
              </div>
            </div>

            <button className="sc-big-btn" onClick={handleOdds} disabled={oddsLoading}>
              {oddsLoading ? <><span className="sc-spin">⟳</span> Scaricando quote...</> : '💰 Scarica Quote Live'}
            </button>

            {oddsError && (
              <div className="alert alert-danger" style={{ marginTop: 14 }}>
                ❌ {oddsError}
                {oddsError.includes('401') && <div style={{ marginTop: 6, fontSize: 12 }}>API key non valida. Verifica su the-odds-api.com</div>}
              </div>
            )}
          </div>

          {oddsMatches.length > 0 && (
            <div className="card">
              <div className="card-header">
                <div className="card-title">{oddsComp} — {oddsMatches.length} partite</div>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Data</th><th>Partita</th>
                      <th style={{ textAlign: 'center' }}>1</th>
                      <th style={{ textAlign: 'center' }}>X</th>
                      <th style={{ textAlign: 'center' }}>2</th>
                      <th style={{ textAlign: 'center' }}>O2.5</th>
                      <th style={{ textAlign: 'center' }}>U2.5</th>
                      <th>Margine</th>
                    </tr>
                  </thead>
                  <tbody>
                    {oddsMatches.map((m, i) => {
                      const odds = m.eurobetOdds && Object.keys(m.eurobetOdds).length > 0 ? m.eurobetOdds : m.bestOdds;
                      return (
                        <tr key={i}>
                          <td style={{ fontSize: 12, color: 'var(--text-secondary)', whiteSpace: 'nowrap' }}>{formatDate(m.commenceTime)}</td>
                          <td><strong>{m.homeTeam}</strong><span style={{ margin: '0 6px', color: 'var(--text-secondary)' }}>vs</span><strong>{m.awayTeam}</strong></td>
                          <td style={{ textAlign: 'center' }}><span className="badge badge-blue">{odds.homeWin?.toFixed(2) ?? '—'}</span></td>
                          <td style={{ textAlign: 'center', color: 'var(--text-secondary)' }}>{odds.draw?.toFixed(2) ?? '—'}</td>
                          <td style={{ textAlign: 'center' }}><span className="badge badge-blue">{odds.awayWin?.toFixed(2) ?? '—'}</span></td>
                          <td style={{ textAlign: 'center' }}>{odds.over25?.toFixed(2) ?? '—'}</td>
                          <td style={{ textAlign: 'center' }}>{odds.under25?.toFixed(2) ?? '—'}</td>
                          <td style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                            {m.margins && Object.values(m.margins).length > 0 ? Object.values(m.margins)[0] as string : '—'}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
