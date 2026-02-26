import React, { useEffect, useState } from 'react';
import axios from 'axios';

const API = axios.create({ baseURL: '/api', timeout: 900000 });

type ActiveTab = 'fotmob' | 'odds';
type FotmobMode = 'single' | 'top5';

const COMPETITIONS = ['Serie A', 'Premier League', 'La Liga', 'Bundesliga', 'Ligue 1'];

const generateSeasons = (n: number): string[] => {
  const now = new Date();
  const start = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
  return Array.from({ length: n }, (_, i) => `${start - i}/${start - i + 1}`).reverse();
};

const formatDate = (iso: string) => {
  try {
    return new Date(iso).toLocaleString('it-IT', {
      weekday: 'short',
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
};

export default function Scrapers() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('fotmob');

  // FotMob
  const [fotmobComp, setFotmobComp] = useState('Serie A');
  const [fotmobYears, setFotmobYears] = useState(2);
  const [fotmobIncludeDetails, setFotmobIncludeDetails] = useState(true);
  const [fotmobForceRefresh, setFotmobForceRefresh] = useState(false);
  const [fotmobImportPlayers, setFotmobImportPlayers] = useState(false);
  const [fotmobLoading, setFotmobLoading] = useState(false);
  const [fotmobResult, setFotmobResult] = useState<any>(null);
  const [fotmobError, setFotmobError] = useState<string | null>(null);

  // Odds
  const [oddsLoading, setOddsLoading] = useState(false);
  const [oddsError, setOddsError] = useState<string | null>(null);
  const [remainingReq, setRemainingReq] = useState<number | null>(null);
  const [oddsLastUpdatedAt, setOddsLastUpdatedAt] = useState<string | null>(null);
  const [oddsMatches, setOddsMatches] = useState<any[]>([]);

  const applyOddsState = (data: any) => {
    const matches = Array.isArray(data?.matches) ? data.matches : [];
    setOddsMatches(matches);

    const nextRemaining = Number(data?.remainingRequests);
    setRemainingReq(Number.isFinite(nextRemaining) && nextRemaining >= 0 ? nextRemaining : null);

    if (typeof data?.lastUpdatedAt === 'string' && data.lastUpdatedAt) {
      setOddsLastUpdatedAt(data.lastUpdatedAt);
    }
  };

  useEffect(() => {
    let active = true;

    const loadOddsStatus = async () => {
      try {
        const res = await API.get('/scraper/odds/status');
        if (!active) return;
        applyOddsState(res.data?.data);
      } catch {
        // Keep UI usable even if status endpoint is temporarily unavailable.
      }
    };

    loadOddsStatus();

    return () => {
      active = false;
    };
  }, []);

  const handleFotmob = async (mode: FotmobMode) => {
    setFotmobLoading(true);
    setFotmobError(null);
    setFotmobResult(null);
    try {
      const res = await API.post('/scraper/fotmob', {
        mode,
        competition: fotmobComp,
        yearsBack: fotmobYears,
        includeMatchDetails: fotmobIncludeDetails,
        forceRefresh: fotmobForceRefresh,
        importPlayers: fotmobImportPlayers,
      });
      setFotmobResult(res.data.data);
    } catch (e: any) {
      setFotmobError(e.response?.data?.error ?? e.message);
    }
    setFotmobLoading(false);
  };

  const handleOdds = async () => {
    setOddsLoading(true);
    setOddsError(null);
    try {
      const res = await API.post('/scraper/odds', {
        competition: 'Serie A',
        markets: ['h2h', 'totals'],
      });
      applyOddsState(res.data?.data);
    } catch (e: any) {
      setOddsError(e.response?.data?.error ?? e.message);
    }
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
        .sc-big-btn { width:100%; padding:15px; border-radius:10px; border:none; background:var(--primary); color:#fff; font-size:15px; font-weight:700; cursor:pointer; transition:all 0.2s; display:flex; align-items:center; justify-content:center; gap:10px; }
        .sc-big-btn:hover:not(:disabled) { background:var(--primary-dark); transform:translateY(-1px); box-shadow:0 4px 14px rgba(26,115,232,0.3); }
        .sc-big-btn:disabled { opacity:0.6; cursor:not-allowed; transform:none; box-shadow:none; }
        .sc-result-row { display:flex; justify-content:space-between; padding:7px 0; border-bottom:1px solid var(--border); font-size:13px; }
        .sc-result-row:last-child { border-bottom:none; }
      `}</style>

      <h1 className="page-title">Dati Automatici</h1>
      <p className="page-subtitle">Scarica statistiche storiche e quote live in automatico</p>

      <div className="sc-tab-bar">
        <button className={`sc-tab ${activeTab === 'fotmob' ? 'on' : ''}`} onClick={() => setActiveTab('fotmob')}>
          Statistiche FotMob
          <span className="badge badge-green" style={{ fontSize: 11 }}>Gratuito</span>
        </button>
        <button className={`sc-tab ${activeTab === 'odds' ? 'on' : ''}`} onClick={() => setActiveTab('odds')}>
          Quote Live (Odds API)
        </button>
      </div>

      {activeTab === 'fotmob' && (
        <div>
          <div className="card">
            <div className="card-header">
              <div>
                <div className="card-title">Download da FotMob</div>
                <div className="card-subtitle">Import incrementale automatico</div>
              </div>
            </div>

            <div className="form-row" style={{ marginBottom: 20 }}>
              <div className="form-group">
                <label className="form-label">Campionato</label>
                <div className="sc-comp-grid">
                  {COMPETITIONS.map((c) => (
                    <button key={c} className={`sc-comp ${fotmobComp === c ? 'on' : ''}`} onClick={() => setFotmobComp(c)}>
                      {c}
                    </button>
                  ))}
                </div>
              </div>
              <div className="form-group">
                <label className="form-label">Stagioni da scaricare</label>
                <div className="sc-year-grid">
                  {[1, 2, 3].map((n) => (
                    <button key={n} className={`sc-year ${fotmobYears === n ? 'on' : ''}`} onClick={() => setFotmobYears(n)}>
                      <span className="sc-year-num">{n}</span>
                      <span className="sc-year-lbl">{n === 1 ? 'stagione' : 'stagioni'}</span>
                    </button>
                  ))}
                </div>
                <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text-secondary)' }}>
                  Stagioni: <strong>{seasons.join(' - ')}</strong>
                </div>
              </div>
            </div>

            <div style={{ marginBottom: 16 }}>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', fontSize: 13, marginBottom: 8 }}>
                <input
                  type="checkbox"
                  checked={fotmobIncludeDetails}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    setFotmobIncludeDetails(checked);
                    if (!checked) setFotmobImportPlayers(false);
                  }}
                />
                Importa statistiche match avanzate
              </label>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', fontSize: 13 }}>
                <input
                  type="checkbox"
                  checked={fotmobImportPlayers}
                  disabled={!fotmobIncludeDetails}
                  onChange={(e) => {
                    const checked = e.target.checked;
                    if (checked) setFotmobIncludeDetails(true);
                    setFotmobImportPlayers(checked);
                  }}
                />
                Aggiorna anche statistiche giocatori
              </label>
              <label style={{ display: 'flex', gap: 8, alignItems: 'center', cursor: 'pointer', fontSize: 13, marginTop: 8 }}>
                <input type="checkbox" checked={fotmobForceRefresh} onChange={(e) => setFotmobForceRefresh(e.target.checked)} />
                Forza refresh completo
              </label>
            </div>

            <div style={{ display: 'grid', gap: 10 }}>
              <button className="sc-big-btn" onClick={() => handleFotmob('single')} disabled={fotmobLoading}>
                {fotmobLoading ? 'Download in corso...' : `Scarica solo ${fotmobComp}`}
              </button>
              <button className="sc-big-btn" onClick={() => handleFotmob('top5')} disabled={fotmobLoading}>
                {fotmobLoading ? 'Download in corso...' : 'Scarica Top-5 insieme'}
              </button>
            </div>

            {fotmobError && (
              <div className="alert alert-danger" style={{ marginTop: 14 }}>
                Errore: {fotmobError}
              </div>
            )}

            {fotmobResult && (
              <div className={`alert ${fotmobResult.isUpToDate ? 'alert-info' : 'alert-success'}`} style={{ marginTop: 14 }}>
                <div style={{ fontWeight: 700, marginBottom: 10, fontSize: 15 }}>
                  {fotmobResult.isUpToDate ? 'Database gia aggiornato' : 'Import completato'}
                </div>
                {[
                  ['Modalita', fotmobResult.mode],
                  ['Campionati', fotmobResult.competitions?.join(', ')],
                  ['Stagioni', fotmobResult.seasons?.join(', ')],
                  ['Nuove partite importate', fotmobResult.newMatchesImported ?? fotmobResult.imported],
                  ['Partite future importate', fotmobResult.upcomingMatchesImported ?? 0],
                  ['Partite gia presenti aggiornate', fotmobResult.existingMatchesUpdated ?? 0],
                  ['Squadre create', fotmobResult.teamsCreated],
                  ['Giocatori aggiornati', fotmobResult.playersUpdated],
                  ['Squadre con medie ricalcolate', fotmobResult.teamsRecomputed],
                ].map(([k, v]) => (
                  <div key={String(k)} className="sc-result-row">
                    <span style={{ color: 'var(--text-secondary)' }}>{k}</span>
                    <strong>{String(v ?? '-')}</strong>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {activeTab === 'odds' && (
        <div className="card">
          <div className="card-header">
            <div>
              <div className="card-title">Quote Live - The Odds API</div>
              <div className="card-subtitle">Recupero automatico lato backend</div>
            </div>
            <span className="badge badge-gray">
              {remainingReq !== null ? `${remainingReq}/500 richieste rimanenti` : 'Richieste rimanenti: n/d'}
            </span>
          </div>

          <button className="sc-big-btn" onClick={handleOdds} disabled={oddsLoading}>
            {oddsLoading ? 'Scaricamento quote live...' : 'Scarica quote live'}
          </button>

          {oddsLastUpdatedAt && (
            <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-secondary)' }}>
              Ultimo aggiornamento: <strong>{formatDate(oddsLastUpdatedAt)}</strong>
            </div>
          )}

          {oddsError && (
            <div className="alert alert-danger" style={{ marginTop: 14 }}>
              {oddsError}
            </div>
          )}

          {!oddsError && !oddsLoading && oddsMatches.length > 0 && (
            <>
              <div className="alert alert-success" style={{ marginTop: 14 }}>
                Quote live aggiornate: {oddsMatches.length} partite trovate.
              </div>
              <div style={{ marginTop: 12, border: '1px solid var(--border)', borderRadius: 10, overflow: 'hidden' }}>
                <div style={{ padding: '10px 12px', fontWeight: 700, background: 'var(--bg-subtle, #f8fafc)' }}>
                  Partite scaricate
                </div>
                <div style={{ maxHeight: 340, overflowY: 'auto' }}>
                  {oddsMatches.map((m: any, i: number) => (
                    <div key={`${m.homeTeam}-${m.awayTeam}-${m.commenceTime}-${i}`} className="sc-result-row" style={{ padding: '10px 12px' }}>
                      <strong>{m.homeTeam} - {m.awayTeam}</strong>
                      <span style={{ color: 'var(--text-secondary)' }}>{formatDate(String(m.commenceTime ?? ''))}</span>
                    </div>
                  ))}
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}
