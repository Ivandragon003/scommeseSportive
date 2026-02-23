import React, { useState, useEffect } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { getTeams, getBudget, placeBet } from '../utils/api';
import axios from 'axios';

interface PredictionsProps { activeUser: string; }

const fmtPct = (n: number) => (n * 100).toFixed(2) + '%';
const fmtN = (n: number, d = 2) => n.toFixed(d);

const ODDS_GROUPS = [
  { title: 'Goal', keys: ['homeWin', 'draw', 'awayWin', 'btts', 'bttsNo', 'over25', 'under25', 'over15', 'over35', 'over45'] },
  { title: 'Cartellini', keys: ['cards_over35', 'cards_over45', 'cards_over55', 'cards_under35', 'cards_under45'] },
  { title: 'Falli', keys: ['fouls_over235', 'fouls_under235', 'fouls_over205', 'fouls_over265'] },
  { title: 'Tiri', keys: ['shots_over225', 'shots_over255', 'shots_under225', 'sot_over75', 'sot_over95'] },
];

const MARKET_LABELS: Record<string, string> = {
  homeWin: 'Casa (1)', draw: 'Pareggio (X)', awayWin: 'Ospite (2)',
  btts: 'Goal/Goal Sì', bttsNo: 'Goal/Goal No',
  over15: 'Over 1.5', over25: 'Over 2.5', over35: 'Over 3.5', over45: 'Over 4.5',
  under25: 'Under 2.5', under35: 'Under 3.5',
  cards_over35: 'Cartellini O3.5', cards_over45: 'Cartellini O4.5',
  cards_over55: 'Cartellini O5.5', cards_under35: 'Cartellini U3.5',
  cards_under45: 'Cartellini U4.5', fouls_over205: 'Falli O20.5',
  fouls_over235: 'Falli O23.5', fouls_over265: 'Falli O26.5',
  fouls_under235: 'Falli U23.5', shots_over225: 'Tiri O22.5',
  shots_over255: 'Tiri O25.5', shots_under225: 'Tiri U22.5',
  sot_over75: 'Tiri Porta O7.5', sot_over95: 'Tiri Porta O9.5',
};

const ProbBar: React.FC<{ label: string; value: number; color?: string }> = ({ label, value, color = '#1a73e8' }) => (
  <div className="prob-row">
    <span className="prob-label">{label}</span>
    <div className="prob-bar-container">
      <div className="prob-bar" style={{ width: `${Math.min(100, value * 100)}%`, background: color }}>
        {(value * 100).toFixed(2)}%
      </div>
    </div>
  </div>
);

const DistChart: React.FC<{ dist: Record<string, number>; expected: number; title: string; color?: string }> = ({
  dist, expected, title, color = '#1a73e8'
}) => {
  const data = Object.entries(dist)
    .map(([k, v]) => ({ k: parseInt(k), pct: parseFloat((v * 100).toFixed(2)) }))
    .filter(d => d.pct >= 0.05).sort((a, b) => a.k - b.k);

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
        <span style={{ fontSize: 13, fontWeight: 600 }}>{title}</span>
        <span style={{ fontSize: 12, color: '#5f6368' }}>μ = <strong>{fmtN(expected)}</strong></span>
      </div>
      <ResponsiveContainer width="100%" height={130}>
        <BarChart data={data} margin={{ top: 2, right: 4, bottom: 2, left: 0 }}>
          <CartesianGrid strokeDasharray="2 2" stroke="#f0f0f0" />
          <XAxis dataKey="k" tick={{ fontSize: 10 }} />
          <YAxis tickFormatter={v => `${v}%`} tick={{ fontSize: 10 }} width={32} />
          <Tooltip formatter={(v: any) => [`${v}%`, 'P']} labelFormatter={(l: any) => `${l} eventi`} />
          <ReferenceLine x={Math.round(expected)} stroke="#aaa" strokeDasharray="3 3" />
          <Bar dataKey="pct" fill={color} radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
};

const Predictions: React.FC<PredictionsProps> = ({ activeUser }) => {
  const [teams, setTeams] = useState<any[]>([]);
  const [homeTeam, setHomeTeam] = useState('');
  const [awayTeam, setAwayTeam] = useState('');
  const [competition, setCompetition] = useState('');
  const [isDerby, setIsDerby] = useState(false);
  const [isHighStakes, setIsHighStakes] = useState(false);
  const [loading, setLoading] = useState(false);
  const [pred, setPred] = useState<any>(null);
  const [tab, setTab] = useState('1x2');
  const [budget, setBudget] = useState<any>(null);
  const [stakes, setStakes] = useState<Record<string, string>>({});
  const [betDone, setBetDone] = useState<Record<string, boolean>>({});
  const [odds, setOdds] = useState<Record<string, string>>({});

  useEffect(() => {
    getTeams().then(r => setTeams(r.data ?? []));
    getBudget(activeUser).then(r => setBudget(r.data));
  }, [activeUser]);

  const comps = Array.from(new Set(teams.map((t: any) => t.competition).filter(Boolean)));
  const filteredTeams = competition ? teams.filter(t => t.competition === competition) : teams;

  const handlePredict = async () => {
    if (!homeTeam || !awayTeam) return;
    setLoading(true); setPred(null);
    const bookmakerOdds: Record<string, number> = {};
    Object.entries(odds).forEach(([k, v]) => { const n = parseFloat(v); if (!isNaN(n) && n > 1) bookmakerOdds[k] = n; });
    try {
      const res = await axios.post('/api/predict', {
        homeTeamId: homeTeam, awayTeamId: awayTeam,
        competition: competition || undefined,
        bookmakerOdds: Object.keys(bookmakerOdds).length > 0 ? bookmakerOdds : undefined,
        isDerby, isHighStakes,
      });
      if (res.data?.data) {
        setPred(res.data.data);
        const st: Record<string, string> = {};
        for (const o of res.data.data.valueOpportunities ?? []) {
          if (budget?.available_budget)
            st[o.selection] = ((o.suggestedStakePercent / 100) * budget.available_budget).toFixed(2);
        }
        setStakes(st);
      }
    } catch (e: any) { alert(e.response?.data?.error ?? e.message); }
    setLoading(false);
  };

  const handleBet = async (opp: any) => {
    const stake = parseFloat(stakes[opp.selection] ?? '0');
    if (!stake) { alert('Inserisci importo'); return; }
    await placeBet({
      userId: activeUser, matchId: pred.matchId,
      marketName: opp.marketName, selection: opp.selection,
      odds: opp.bookmakerOdds, stake,
      ourProbability: opp.ourProbability / 100,
      expectedValue: opp.expectedValue / 100,
    });
    setBetDone(p => ({ ...p, [opp.selection]: true }));
    getBudget(activeUser).then(r => setBudget(r.data));
  };

  const gp = pred?.goalProbabilities;
  const cp = pred?.cardsPrediction;
  const fp = pred?.foulsPrediction;
  const sp = pred?.shotsPrediction;
  const pp: any[] = pred?.playerShotsPredictions ?? [];
  const vb: any[] = pred?.valueOpportunities ?? [];

  const TABS = [
    { id: '1x2', label: '1X2 & Goal' },
    { id: 'handicap', label: 'Handicap' },
    { id: 'scores', label: 'Risultati Esatti' },
    { id: 'cards', label: '🟨 Cartellini' },
    { id: 'fouls', label: '⚠️ Falli' },
    { id: 'shots', label: '🎯 Tiri Squadra' },
    { id: 'players', label: `👤 Tiri Giocatori${pp.length ? ` (${pp.length})` : ''}` },
    { id: 'value', label: `💰 Value (${vb.length})` },
  ];

  return (
    <div>
      <h1 className="page-title">🔮 Analisi Partita</h1>
      <p className="page-subtitle">
        Goal: Dixon-Coles (Poisson+τ) &nbsp;·&nbsp; Cartellini/Falli: Binomiale Negativa &nbsp;·&nbsp; Tiri giocatori: ZIP
      </p>

      <div className="card">
        <div className="card-header"><h2 className="card-title">Configura Partita</h2></div>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Competizione</label>
            <select className="form-select" value={competition} onChange={e => setCompetition(e.target.value)}>
              <option value="">Tutte</option>
              {comps.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div style={{ display: 'flex', gap: 20, alignItems: 'flex-end', paddingBottom: 14 }}>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer', fontSize: 13 }}>
              <input type="checkbox" checked={isDerby} onChange={e => setIsDerby(e.target.checked)} />
              Derby <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>(+22% gialli)</span>
            </label>
            <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer', fontSize: 13 }}>
              <input type="checkbox" checked={isHighStakes} onChange={e => setIsHighStakes(e.target.checked)} />
              Alta posta <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>(+12% gialli)</span>
            </label>
          </div>
        </div>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Squadra Casa</label>
            <select className="form-select" value={homeTeam} onChange={e => setHomeTeam(e.target.value)}>
              <option value="">-- Seleziona --</option>
              {filteredTeams.map(t => <option key={t.team_id} value={t.team_id}>{t.name}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Squadra Ospite</label>
            <select className="form-select" value={awayTeam} onChange={e => setAwayTeam(e.target.value)}>
              <option value="">-- Seleziona --</option>
              {filteredTeams.filter(t => t.team_id !== homeTeam).map(t => <option key={t.team_id} value={t.team_id}>{t.name}</option>)}
            </select>
          </div>
        </div>

        <details style={{ marginBottom: 14 }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600, padding: '8px 0', fontSize: 14 }}>
            💱 Quote Bookmaker — clicca per inserire (calcola EV e Kelly)
          </summary>
          <div style={{ paddingTop: 12 }}>
            {ODDS_GROUPS.map(g => (
              <div key={g.title} style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                  {g.title}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8 }}>
                  {g.keys.map(k => (
                    <div className="form-group" key={k} style={{ marginBottom: 0 }}>
                      <label className="form-label" style={{ fontSize: 11 }}>{MARKET_LABELS[k] ?? k}</label>
                      <input className="form-input" type="number" placeholder="1.85" step="0.01" min="1.01"
                        value={odds[k] ?? ''} onChange={e => setOdds(p => ({ ...p, [k]: e.target.value }))} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </details>

        <button className="btn btn-primary btn-lg" onClick={handlePredict} disabled={loading || !homeTeam || !awayTeam}>
          {loading ? '⏳ Calcolo in corso...' : '🔮 Analizza Partita'}
        </button>
      </div>

      {pred && (
        <>
          <div className="match-header">
            <div style={{ textAlign: 'right', flex: 1 }}>
              <div className="team-name">{pred.homeTeam}</div>
              <div className="expected-goals" style={{ justifyContent: 'flex-end' }}>
                <span className="xg-chip">λ = {pred.lambdaHome}</span>
              </div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div className="vs">VS</div>
              <div className="match-meta">Confidenza: {(pred.modelConfidence * 100).toFixed(0)}%</div>
            </div>
            <div style={{ textAlign: 'left', flex: 1 }}>
              <div className="team-name">{pred.awayTeam}</div>
              <div className="expected-goals">
                <span className="xg-chip">λ = {pred.lambdaAway}</span>
              </div>
            </div>
          </div>

          <div className="tabs" style={{ overflowX: 'auto' }}>
            {TABS.map(t => (
              <button key={t.id} className={`tab ${tab === t.id ? 'active' : ''}`}
                onClick={() => setTab(t.id)} style={{ whiteSpace: 'nowrap' }}>
                {t.label}
              </button>
            ))}
          </div>

          {tab === '1x2' && gp && (
            <div className="grid-2">
              <div className="card">
                <div className="card-header"><h2 className="card-title">1X2</h2></div>
                <ProbBar label={pred.homeTeam} value={gp.homeWin} color="var(--primary)" />
                <ProbBar label="Pareggio" value={gp.draw} color="var(--neutral)" />
                <ProbBar label={pred.awayTeam} value={gp.awayWin} color="var(--danger)" />
              </div>
              <div className="card">
                <div className="card-header"><h2 className="card-title">Mercati Goal</h2></div>
                <ProbBar label="Goal/Goal" value={gp.btts} color="var(--secondary)" />
                <ProbBar label="Over 0.5" value={gp.over05} color="var(--primary)" />
                <ProbBar label="Over 1.5" value={gp.over15} color="var(--primary)" />
                <ProbBar label="Over 2.5" value={gp.over25} color="var(--primary)" />
                <ProbBar label="Over 3.5" value={gp.over35} color="var(--warning)" />
                <ProbBar label="Over 4.5" value={gp.over45} color="var(--danger)" />
              </div>
            </div>
          )}

          {tab === 'handicap' && gp?.handicap && (
            <div className="card">
              <div className="card-header"><h2 className="card-title">Handicap Europeo & Asian</h2></div>
              <div className="grid-2">
                <div>
                  {Object.entries(gp.handicap).filter(([k]) => k.startsWith('home')).map(([k, v]) => (
                    <ProbBar key={k} label={k.replace('home', 'Casa ')} value={v as number} color="var(--primary)" />
                  ))}
                </div>
                <div>
                  {Object.entries(gp.handicap).filter(([k]) => k.startsWith('away')).map(([k, v]) => (
                    <ProbBar key={k} label={k.replace('away', 'Ospite ')} value={v as number} color="var(--danger)" />
                  ))}
                </div>
              </div>
              <div style={{ marginTop: 20 }}>
                <div style={{ fontWeight: 600, marginBottom: 10 }}>Asian Handicap (casa)</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
                  {gp.asianHandicap && Object.entries(gp.asianHandicap).slice(0, 12).map(([k, v]) => (
                    <div key={k} style={{ display: 'flex', justifyContent: 'space-between', padding: '6px 10px', background: 'var(--bg)', borderRadius: 4, fontSize: 13 }}>
                      <span>AH {k}</span><span style={{ fontWeight: 600 }}>{fmtPct(v as number)}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {tab === 'scores' && gp?.exactScore && (
            <div className="card">
              <div className="card-header"><h2 className="card-title">Risultati Esatti</h2></div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 8 }}>
                {Object.entries(gp.exactScore)
                  .sort(([, a], [, b]) => (b as number) - (a as number))
                  .slice(0, 18)
                  .map(([score, prob]) => {
                    const p = (prob as number) * 100;
                    return (
                      <div key={score} style={{
                        padding: '10px', borderRadius: 6, textAlign: 'center',
                        border: '1px solid var(--border)',
                        background: p > 10 ? '#e8f0fe' : p > 5 ? '#f0fdf4' : '#fff'
                      }}>
                        <div style={{ fontSize: 18, fontWeight: 700 }}>{score}</div>
                        <div style={{ fontSize: 13, color: 'var(--primary)', fontWeight: 600 }}>{p.toFixed(2)}%</div>
                      </div>
                    );
                  })}
              </div>
            </div>
          )}

          {tab === 'cards' && cp && (
            <div>
              <div className="alert alert-info">
                <strong>Binomiale Negativa</strong> — La varianza dei cartellini ({fmtN(cp.totalYellow.variance)}) &gt; media ({fmtN(cp.totalYellow.expected)}):
                overdispersion che la Poisson non può modellare. Parametro r calibrato su dati storici.
                {cp.confidenceLevel < 0.7 && <span style={{ color: 'var(--warning)' }}> · ⚠️ Dati limitati (confidenza {(cp.confidenceLevel*100).toFixed(0)}%)</span>}
              </div>
              <div className="grid-2">
                <div className="card">
                  <div className="card-header">
                    <h2 className="card-title">Gialli Totali</h2>
                    <div>
                      <span className="badge badge-blue">μ = {fmtN(cp.totalYellow.expected)}</span>
                      {' '}<span className="badge badge-gray">σ² = {fmtN(cp.totalYellow.variance)}</span>
                    </div>
                  </div>
                  <DistChart dist={cp.totalYellow.distribution} expected={cp.totalYellow.expected}
                    title="P(gialli = k) — NegBin" color="#fbbc04" />
                  {['over15','over25','over35','over45','over55','over65'].map(k => (
                    <ProbBar key={k} label={`Over ${k.replace('over','').replace(/(\d)(\d)/,'$1.$2')}`}
                      value={(cp.overUnder as any)[k]} color="var(--warning)" />
                  ))}
                </div>
                <div className="card">
                  <div className="card-header"><h2 className="card-title">Per Squadra & Rossi</h2></div>
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13 }}>{pred.homeTeam}</div>
                    <ProbBar label="Over 1.5" value={cp.homeYellow.over15} color="var(--primary)" />
                    <ProbBar label="Over 2.5" value={cp.homeYellow.over25} color="var(--primary)" />
                    <ProbBar label="Over 3.5" value={cp.homeYellow.over35} color="var(--primary)" />
                  </div>
                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontWeight: 600, marginBottom: 6, fontSize: 13 }}>{pred.awayTeam}</div>
                    <ProbBar label="Over 1.5" value={cp.awayYellow.over15} color="var(--danger)" />
                    <ProbBar label="Over 2.5" value={cp.awayYellow.over25} color="var(--danger)" />
                    <ProbBar label="Over 3.5" value={cp.awayYellow.over35} color="var(--danger)" />
                  </div>
                  <div style={{ padding: 12, background: 'var(--bg)', borderRadius: 6, fontSize: 13 }}>
                    <strong>🔴 Rossi</strong> — media attesa: {fmtN(cp.totalRed.expected, 3)} &nbsp;·&nbsp;
                    P(≥1 rosso): <strong>{(cp.totalRed.probAtLeastOne * 100).toFixed(1)}%</strong>
                  </div>
                  <div style={{ marginTop: 12, padding: 12, background: 'var(--bg)', borderRadius: 6 }}>
                    <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 13 }}>Cartellini Pesati (1G=1, 1R=2)</div>
                    <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 6 }}>μ = {fmtN(cp.totalCardsWeighted.expected)}</div>
                    <ProbBar label="Over 3.5" value={cp.totalCardsWeighted.over35} color="var(--danger)" />
                    <ProbBar label="Over 4.5" value={cp.totalCardsWeighted.over45} color="var(--danger)" />
                    <ProbBar label="Over 5.5" value={cp.totalCardsWeighted.over55} color="var(--danger)" />
                  </div>
                </div>
              </div>
            </div>
          )}

          {tab === 'fouls' && fp && (
            <div className="card">
              <div className="card-header">
                <h2 className="card-title">Falli — Binomiale Negativa</h2>
                <div>
                  <span className="badge badge-blue">μ = {fmtN(fp.totalFouls.expected)}</span>
                  {' '}<span className="badge badge-gray">σ² = {fmtN(fp.totalFouls.variance)}</span>
                </div>
              </div>
              <div className="alert alert-info" style={{ marginBottom: 14 }}>
                Casa: {fmtN(fp.homeFouls.expected)} falli attesi &nbsp;·&nbsp; Ospite: {fmtN(fp.awayFouls.expected)} falli attesi
                &nbsp;·&nbsp; Rapporto σ²/μ = {fmtN(fp.totalFouls.variance / fp.totalFouls.expected, 2)}x (overdispersion)
              </div>
              <DistChart dist={fp.totalFouls.distribution} expected={fp.totalFouls.expected}
                title="P(falli totali = k) — Binomiale Negativa" color="#5f6368" />
              <div className="grid-2">
                {Object.entries(fp.overUnder).filter(([k]) => k.startsWith('over')).map(([k, v]) => (
                  <ProbBar key={k} label={`Over ${k.replace('over','').replace(/(\d)(\d)(\d)/,'$1$2.$3')}`}
                    value={v as number} color="var(--neutral)" />
                ))}
              </div>
            </div>
          )}

          {tab === 'shots' && sp && (
            <div>
              <div className="grid-2">
                <div className="card">
                  <div className="card-header">
                    <h2 className="card-title">{pred.homeTeam}</h2>
                    <span className="badge badge-blue">μ tiri = {fmtN(sp.home.totalShots.expected)}</span>
                  </div>
                  <DistChart dist={sp.home.totalShots.distribution} expected={sp.home.totalShots.expected}
                    title="Tiri totali" color="var(--primary)" />
                  <DistChart dist={sp.home.shotsOnTarget.distribution} expected={sp.home.shotsOnTarget.expected}
                    title="Tiri in porta" color="var(--secondary)" />
                </div>
                <div className="card">
                  <div className="card-header">
                    <h2 className="card-title">{pred.awayTeam}</h2>
                    <span className="badge badge-red">μ tiri = {fmtN(sp.away.totalShots.expected)}</span>
                  </div>
                  <DistChart dist={sp.away.totalShots.distribution} expected={sp.away.totalShots.expected}
                    title="Tiri totali" color="var(--danger)" />
                  <DistChart dist={sp.away.shotsOnTarget.distribution} expected={sp.away.shotsOnTarget.expected}
                    title="Tiri in porta" color="var(--warning)" />
                </div>
              </div>
              <div className="card">
                <div className="card-header">
                  <h2 className="card-title">Totali Combinati</h2>
                  <span className="badge badge-blue">
                    Tiri: {fmtN(sp.combined.totalShots.expected)} &nbsp;·&nbsp; In porta: {fmtN(sp.combined.totalOnTarget.expected)}
                  </span>
                </div>
                <div className="grid-2">
                  <div>
                    <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 13 }}>Tiri Totali</div>
                    {Object.entries(sp.combined.overUnder).filter(([k]) => k.startsWith('over')).map(([k, v]) => (
                      <ProbBar key={k} label={`Over ${k.replace('over', '')}`} value={v as number} color="var(--primary)" />
                    ))}
                  </div>
                  <div>
                    <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 13 }}>Tiri in Porta</div>
                    {Object.entries(sp.combined.onTargetOverUnder).filter(([k]) => k.startsWith('over')).map(([k, v]) => (
                      <ProbBar key={k} label={`Over ${k.replace('over', '')}`} value={v as number} color="var(--secondary)" />
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {tab === 'players' && (
            <div>
              {pp.length === 0 ? (
                <div className="alert alert-info">
                  <strong>Modello ZIP (Zero-Inflated Poisson)</strong><br /><br />
                  P(X=0) = π + (1-π)e^(-λ) &nbsp;·&nbsp; E(X) = (1-π)λ &nbsp;·&nbsp; Var(X) = (1-π)λ(1+πλ)<br /><br />
                  Il parametro π cattura la probabilità strutturale di zero tiri (giocatore fuori, neutralizzato, non in forma).
                  Questo distingue il "vero" zero da chi semplicemente non ha tirato per caso.<br /><br />
                  I parametri π e λ vengono stimati con algoritmo EM (Expectation-Maximization) su dati storici per giocatore.<br /><br />
                  Per usare questo modello, passa i profili giocatori nell'API o caricali dalla sezione Gestione Dati.
                </div>
              ) : pp.map((p: any) => (
                <div className="card" key={p.playerId}>
                  <div className="card-header">
                    <div>
                      <h2 className="card-title">{p.playerName}</h2>
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                        {p.position} · Confidenza: {(p.confidenceLevel * 100).toFixed(0)}% ({p.sampleSize} partite)
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontWeight: 700, fontSize: 18 }}>{fmtN(p.expectedShots)}</div>
                      <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>tiri attesi</div>
                      <div style={{ fontSize: 11, color: 'var(--secondary)' }}>{fmtN(p.expectedOnTarget)} in porta</div>
                    </div>
                  </div>
                  <div className="grid-2">
                    <DistChart dist={p.shotDistribution} expected={p.expectedShots}
                      title="Distribuzione tiri (ZIP)" color="var(--primary)" />
                    <div>
                      <ProbBar label="≥1 tiro (Over 0.5)" value={p.markets.over05shots} color="var(--primary)" />
                      <ProbBar label="≥2 tiri (Over 1.5)" value={p.markets.over15shots} color="var(--primary)" />
                      <ProbBar label="≥3 tiri (Over 2.5)" value={p.markets.over25shots} color="var(--warning)" />
                      <ProbBar label="0 tiri" value={p.markets.zeroShots} color="var(--neutral)" />
                      <div style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8 }}>
                        <ProbBar label="≥1 in porta" value={p.markets.over05onTarget} color="var(--secondary)" />
                        <ProbBar label="≥2 in porta" value={p.markets.over15onTarget} color="var(--secondary)" />
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === 'value' && (
            <div>
              {vb.length === 0 ? (
                <div className="alert alert-info">Inserisci le quote del bookmaker per calcolare il valore atteso.</div>
              ) : (
                <>
                  <div className="alert alert-success">
                    ✅ {vb.length} scommesse a EV positivo (soglia EV &gt; 2%). Le probabilità usano il modello specifico per ogni mercato.
                  </div>
                  {vb.map((o: any) => (
                    <div key={o.selection} className={`value-bet-card ${o.confidence === 'MEDIUM' ? 'medium' : o.confidence === 'LOW' ? 'low' : ''}`}>
                      <div className="vb-header">
                        <div>
                          <div className="vb-market">{o.marketName}</div>
                          <span className={`badge badge-${o.confidence === 'HIGH' ? 'green' : o.confidence === 'MEDIUM' ? 'blue' : 'yellow'}`}>{o.confidence}</span>
                        </div>
                        <div className="vb-ev">EV: +{o.expectedValue}%</div>
                      </div>
                      {[['P. Nostra', o.ourProbability + '%'], ['P. BK implicita', o.impliedProbability + '%'],
                        ['Edge', '+' + o.edge + '%'], ['Quota', o.bookmakerOdds], ['Kelly 1/4', o.kellyFraction + '%']
                      ].map(([k, v]) => (
                        <div className="vb-row" key={k as string}><span className="key">{k}</span><span className="val">{v}</span></div>
                      ))}
                      <div className="vb-footer">
                        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                          <span style={{ fontSize: 13 }}>Puntata (€):</span>
                          <input className="form-input" type="number" style={{ width: 90 }}
                            value={stakes[o.selection] ?? ''} placeholder={`${o.suggestedStakePercent}%`}
                            onChange={e => setStakes(p => ({ ...p, [o.selection]: e.target.value }))} />
                          {budget && <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                            suggerito: €{((o.suggestedStakePercent / 100) * (budget.available_budget ?? 0)).toFixed(2)}
                          </span>}
                        </div>
                        {betDone[o.selection] ? (
                          <span className="badge badge-green">✅ Registrata</span>
                        ) : (
                          <button className="btn btn-success btn-sm" onClick={() => handleBet(o)}>💰 Registra</button>
                        )}
                      </div>
                    </div>
                  ))}
                </>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default Predictions;
