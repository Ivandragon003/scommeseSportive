import React, { useEffect, useState } from 'react';
import axios from 'axios';

const API = axios.create({ baseURL: '/api', timeout: 3600000 });

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
      weekday: 'short', day: '2-digit', month: '2-digit',
      hour: '2-digit', minute: '2-digit',
    });
  } catch { return iso; }
};

/* Stili locali minimi — solo ciò che non esiste nel global */
const localStyles = `
  /* COMP PILLS */
  .sc-comp-grid { display: flex; flex-wrap: wrap; gap: 8px; }
  .sc-comp {
    padding: 8px 16px; border-radius: var(--radius-pill);
    border: 1px solid var(--border); background: var(--surface2);
    cursor: pointer; font-size: 13px; font-weight: 600;
    color: var(--text-2); transition: all var(--transition);
    font-family: 'Syne', sans-serif;
  }
  .sc-comp:hover { border-color: var(--border-hover); color: var(--text); background: var(--surface3); }
  .sc-comp.on  { background: var(--blue-dim); color: var(--blue); border-color: var(--blue-border); box-shadow: 0 0 10px rgba(76,201,240,0.12); }

  /* YEAR GRID */
  .sc-year-grid { display: flex; gap: 12px; }
  .sc-year {
    flex: 1; padding: 16px 10px; border-radius: var(--radius);
    border: 1px solid var(--border); background: var(--surface2);
    cursor: pointer; text-align: center;
    transition: all var(--transition);
  }
  .sc-year:hover { border-color: var(--border-hover); background: var(--surface3); transform: translateY(-3px); }
  .sc-year.on  { border-color: var(--blue-border); background: var(--blue-dim); box-shadow: 0 0 14px rgba(76,201,240,0.12); }
  .sc-year-num { font-size: 26px; font-weight: 800; color: var(--blue); display: block; font-family: 'DM Mono', monospace; }
  .sc-year-lbl { font-size: 11px; color: var(--text-2); text-transform: uppercase; letter-spacing: 1px; font-weight: 700; margin-top: 3px; }

  /* BIG BUTTON */
  .sc-big-btn {
    width: 100%; padding: 16px; border-radius: var(--radius-sm);
    border: 1px solid var(--blue-border); background: var(--blue-dim);
    color: var(--blue); font-size: 14px; font-weight: 700;
    cursor: pointer; transition: all var(--transition);
    display: flex; align-items: center; justify-content: center; gap: 10px;
    font-family: 'Syne', sans-serif;
  }
  .sc-big-btn:hover:not(:disabled) {
    background: var(--blue-hover); border-color: var(--blue);
    transform: translateY(-2px); box-shadow: var(--shadow-glow-blue);
  }
  .sc-big-btn:disabled { opacity: 0.4; cursor: not-allowed; transform: none; box-shadow: none; }

  /* RESULT ROW */
  .sc-result-row {
    display: flex; justify-content: space-between; align-items: center;
    padding: 9px 0; border-bottom: 1px solid var(--border);
    font-size: 13px;
  }
  .sc-result-row:last-child { border-bottom: none; }

  /* CHECKBOX */
  .sc-check {
    display: flex; gap: 10px; align-items: center;
    cursor: pointer; font-size: 13px; font-weight: 600;
    color: var(--text-2); margin-bottom: 10px;
    transition: color var(--transition);
  }
  .sc-check:hover { color: var(--text); }
  .sc-check input { accent-color: var(--blue); width: 16px; height: 16px; cursor: pointer; }
  .sc-check input:disabled { opacity: 0.35; }
`;

export default function Scrapers() {
  const [activeTab, setActiveTab] = useState<ActiveTab>('fotmob');

  // FotMob state
  const [fotmobComp, setFotmobComp] = useState('Serie A');
  const [fotmobYears, setFotmobYears] = useState(2);
  const [fotmobIncludeDetails, setFotmobIncludeDetails] = useState(false);
  const [fotmobForceRefresh, setFotmobForceRefresh] = useState(false);
  const [fotmobImportPlayers, setFotmobImportPlayers] = useState(false);
  const [fotmobLoading, setFotmobLoading] = useState(false);
  const [fotmobResult, setFotmobResult] = useState<any>(null);
  const [fotmobError, setFotmobError] = useState<string | null>(null);

  // Scraper status
  const [scraperStatus, setScraperStatus] = useState<any>(null);

  // Odds state
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
    if (typeof data?.lastUpdatedAt === 'string' && data.lastUpdatedAt) setOddsLastUpdatedAt(data.lastUpdatedAt);
  };

  useEffect(() => {
    let active = true;
    const loadOddsStatus = async () => {
      try {
        const res = await API.get('/scraper/odds/status');
        if (!active) return;
        applyOddsState(res.data?.data);
      } catch {}
    };
    loadOddsStatus();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    const fetchStatus = async () => {
      try {
        const res = await API.get('/scraper/status');
        if (active) setScraperStatus(res.data?.data ?? null);
      } catch (err) {
        console.error('Failed to fetch scraper status:', err);
      }
    };
    fetchStatus();
    const interval = setInterval(fetchStatus, 5000); // Every 5 seconds
    return () => { active = false; clearInterval(interval); };
  }, []);

  const handleFotmob = async (mode: FotmobMode) => {
    setFotmobLoading(true);
    setFotmobError(null);
    setFotmobResult(null);
    try {
      const res = await API.post('/scraper/fotmob', {
        mode, competition: fotmobComp, yearsBack: fotmobYears,
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
      const res = await API.post('/scraper/odds', { competition: 'Serie A', markets: ['h2h', 'totals'] });
      applyOddsState(res.data?.data);
    } catch (e: any) {
      setOddsError(e.response?.data?.error ?? e.message);
    }
    setOddsLoading(false);
  };

  const seasons = generateSeasons(fotmobYears);

  return (
    <>
      <style>{localStyles}</style>
      <div style={{ padding: '40px 32px', minHeight: '100vh' }}>

        {/* HEADER */}
        <div style={{ marginBottom: 32 }}>
          <h1 className="fp-page-title fp-gradient-green">
            Dati Automatici
          </h1>
          <p style={{ fontSize: 12, color: 'var(--text-2)', margin: 0, fontFamily: 'DM Mono, monospace' }}>
            Scarica statistiche storiche e quote live in automatico
          </p>
        </div>

        {/* AUTO SYNC STATUS */}
        {scraperStatus && (
          <div className="fp-card" style={{ marginBottom: 24, padding: 16, background: 'var(--bg-1)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div style={{ fontSize: 18 }}>
                {scraperStatus.isUpdating ? '⏳' : '✅'}
              </div>
              <div>
                <div style={{ fontWeight: 600, color: 'var(--text-1)' }}>
                  {scraperStatus.isUpdating ? 'Aggiornamento automatico in corso...' : 'Sistema aggiornato'}
                </div>
                {scraperStatus.lastUpdate && (
                  <div style={{ fontSize: 12, color: 'var(--text-2)', marginTop: 4 }}>
                    Ultimo aggiornamento: {formatDate(scraperStatus.lastUpdate.at)} - {scraperStatus.lastUpdate.message}
                  </div>
                )}
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 2 }}>
                  Auto-sync: {scraperStatus.autoSyncEnabled ? 'Abilitato (top 5 leghe)' : 'Disabilitato'}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* TABS */}
        <div className="fp-tabs" style={{ marginBottom: 24 }}>
          <button className={`fp-tab${activeTab === 'fotmob' ? ' active' : ''}`} onClick={() => setActiveTab('fotmob')}>
            📊 Statistiche FotMob
            <span className="fp-badge fp-badge-green" style={{ fontSize: 10, marginLeft: 6 }}>Gratuito</span>
          </button>
          <button className={`fp-tab${activeTab === 'odds' ? ' active' : ''}`} onClick={() => setActiveTab('odds')}>
            📈 Quote Live (Odds API)
          </button>
        </div>

        {/* ── FOTMOB ── */}
        {activeTab === 'fotmob' && (
          <div className="fp-card">
            <div className="fp-card-head">
              <div>
                <div className="fp-card-title">📥 Download da FotMob</div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>Import incrementale automatico</div>
              </div>
            </div>
            <div className="fp-card-body">

              {/* Competizione */}
              <div style={{ marginBottom: 24 }}>
                <label className="fp-label" style={{ display: 'block', marginBottom: 10 }}>Campionato</label>
                <div className="sc-comp-grid">
                  {COMPETITIONS.map(c => (
                    <button key={c} className={`sc-comp${fotmobComp === c ? ' on' : ''}`} onClick={() => setFotmobComp(c)}>
                      {c}
                    </button>
                  ))}
                </div>
              </div>

              {/* Stagioni */}
              <div style={{ marginBottom: 24 }}>
                <label className="fp-label" style={{ display: 'block', marginBottom: 10 }}>Stagioni da scaricare</label>
                <div className="sc-year-grid">
                  {[1, 2, 3].map(n => (
                    <button key={n} className={`sc-year${fotmobYears === n ? ' on' : ''}`} onClick={() => setFotmobYears(n)}>
                      <span className="sc-year-num">{n}</span>
                      <span className="sc-year-lbl">{n === 1 ? 'stagione' : 'stagioni'}</span>
                    </button>
                  ))}
                </div>
                <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-2)', fontFamily: 'DM Mono, monospace' }}>
                  Stagioni: <strong style={{ color: 'var(--text)' }}>{seasons.join(' · ')}</strong>
                </div>
              </div>

              {/* Opzioni */}
              <div style={{ marginBottom: 24, padding: '16px 20px', background: 'var(--surface2)', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)' }}>
                <label className="fp-label" style={{ display: 'block', marginBottom: 12 }}>Opzioni import</label>
                <label className="sc-check">
                  <input type="checkbox" checked={fotmobIncludeDetails} onChange={e => {
                    setFotmobIncludeDetails(e.target.checked);
                    if (!e.target.checked) setFotmobImportPlayers(false);
                  }} />
                  Importa statistiche match avanzate
                </label>
                <label className="sc-check">
                  <input type="checkbox" checked={fotmobImportPlayers} disabled={!fotmobIncludeDetails}
                    onChange={e => {
                      if (e.target.checked) setFotmobIncludeDetails(true);
                      setFotmobImportPlayers(e.target.checked);
                    }} />
                  Aggiorna anche statistiche giocatori
                </label>
                <label className="sc-check" style={{ marginBottom: 0 }}>
                  <input type="checkbox" checked={fotmobForceRefresh} onChange={e => setFotmobForceRefresh(e.target.checked)} />
                  Forza refresh completo (ignora cache)
                </label>
              </div>

              {/* Buttons */}
              <div style={{ display: 'grid', gap: 10 }}>
                <button className="sc-big-btn" onClick={() => handleFotmob('single')} disabled={fotmobLoading}>
                  {fotmobLoading ? '⏳ Download in corso...' : `⬇ Scarica solo ${fotmobComp}`}
                </button>
                <button className="sc-big-btn" onClick={() => handleFotmob('top5')} disabled={fotmobLoading}>
                  {fotmobLoading ? '⏳ Download in corso...' : '⬇ Scarica Top-5 insieme'}
                </button>
              </div>

              {fotmobError && (
                <div className="fp-alert fp-alert-danger" style={{ marginTop: 16 }}>
                  ⚠ Errore: {fotmobError}
                </div>
              )}

              {fotmobResult && (
                <div className={`fp-alert ${fotmobResult.isUpToDate ? 'fp-alert-info' : 'fp-alert-success'}`} style={{ marginTop: 16 }}>
                  <div style={{ fontWeight: 800, marginBottom: 12, fontSize: 14 }}>
                    {fotmobResult.isUpToDate ? '✓ Database già aggiornato' : '✓ Import completato con successo'}
                  </div>
                  {[
                    ['Modalità', fotmobResult.mode],
                    ['Campionati', fotmobResult.competitions?.join(', ')],
                    ['Stagioni', fotmobResult.seasons?.join(', ')],
                    ['Nuove partite importate', fotmobResult.newMatchesImported ?? fotmobResult.imported],
                    ['Partite future importate', fotmobResult.upcomingMatchesImported ?? 0],
                    ['Partite aggiornate', fotmobResult.existingMatchesUpdated ?? 0],
                    ['Partite eliminate pre-refresh', fotmobResult.deletedMatchesByCompetition
                      ? Object.entries(fotmobResult.deletedMatchesByCompetition)
                          .map(([comp, v]) => `${comp}: ${String(v)}`)
                          .join(' | ')
                      : undefined],
                    ['Squadre create', fotmobResult.teamsCreated],
                    ['Giocatori aggiornati', fotmobResult.playersUpdated],
                    ['Squadre ricalcolate', fotmobResult.teamsRecomputed],
                    ['Transfermarkt sync', fotmobResult.transfermarkt
                      ? Object.entries(fotmobResult.transfermarkt?.competitions ?? {})
                          .map(([comp, info]: [string, any]) => (
                            info?.ok
                              ? `${comp}: ${info.updatedTeams ?? 0}/${info.totalScraped ?? 0} squadre`
                              : `${comp}: errore`
                          ))
                          .join(' | ')
                      : undefined],
                    ['Training automatico', fotmobResult.autoModelFit
                      ? Object.entries(fotmobResult.autoModelFit)
                          .map(([comp, info]: [string, any]) => (
                            info?.ok
                              ? `${comp}: ${info.trainingWindow ?? '-'} (partite correnti ${info.completedCurrentSeasonMatches ?? 0})`
                              : `${comp}: fit non eseguito`
                          ))
                          .join(' | ')
                      : undefined],
                  ].map(([k, v]) => v !== undefined && (
                    <div key={String(k)} className="sc-result-row">
                      <span style={{ color: 'inherit', opacity: 0.75 }}>{k}</span>
                      <strong>{String(v ?? '—')}</strong>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── ODDS ── */}
        {activeTab === 'odds' && (
          <div className="fp-card">
            <div className="fp-card-head">
              <div>
                <div className="fp-card-title">📈 Quote Live — The Odds API</div>
                <div style={{ fontSize: 11, color: 'var(--text-3)', marginTop: 3 }}>Recupero automatico lato backend</div>
              </div>
              <span className={`fp-badge ${remainingReq !== null && remainingReq > 100 ? 'fp-badge-green' : remainingReq !== null ? 'fp-badge-gold' : 'fp-badge-gray'}`}>
                {remainingReq !== null ? `${remainingReq}/500 richieste` : 'Richieste: n/d'}
              </span>
            </div>
            <div className="fp-card-body">
              <button className="sc-big-btn" onClick={handleOdds} disabled={oddsLoading}>
                {oddsLoading ? '⏳ Scaricamento quote live...' : '⬇ Scarica quote live'}
              </button>

              {oddsLastUpdatedAt && (
                <div style={{ marginTop: 12, fontSize: 12, color: 'var(--text-2)', fontFamily: 'DM Mono, monospace' }}>
                  Ultimo aggiornamento: <strong style={{ color: 'var(--text)' }}>{formatDate(oddsLastUpdatedAt)}</strong>
                </div>
              )}

              {oddsError && (
                <div className="fp-alert fp-alert-danger" style={{ marginTop: 16 }}>
                  ⚠ {oddsError}
                </div>
              )}

              {!oddsError && !oddsLoading && oddsMatches.length > 0 && (
                <>
                  <div className="fp-alert fp-alert-success" style={{ marginTop: 16 }}>
                    ✓ Quote live aggiornate: <strong>{oddsMatches.length}</strong> partite trovate.
                  </div>
                  <div style={{ marginTop: 16, border: '1px solid var(--border)', borderRadius: 'var(--radius-sm)', overflow: 'hidden' }}>
                    <div style={{
                      padding: '12px 16px', fontWeight: 700, fontSize: 11,
                      textTransform: 'uppercase', letterSpacing: '1.2px',
                      background: 'var(--surface2)', color: 'var(--text-2)',
                      borderBottom: '1px solid var(--border)'
                    }}>
                      Partite scaricate ({oddsMatches.length})
                    </div>
                    <div style={{ maxHeight: 360, overflowY: 'auto' }}>
                      {oddsMatches.map((m: any, i: number) => (
                        <div
                          key={`${m.homeTeam}-${m.awayTeam}-${m.commenceTime}-${i}`}
                          className="sc-result-row"
                          style={{ padding: '12px 16px', transition: 'background var(--transition)' }}
                        >
                          <strong style={{ fontSize: 13 }}>{m.homeTeam} — {m.awayTeam}</strong>
                          <span style={{ color: 'var(--text-2)', fontSize: 12, fontFamily: 'DM Mono, monospace' }}>
                            {formatDate(String(m.commenceTime ?? ''))}
                          </span>
                        </div>
                      ))}
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
