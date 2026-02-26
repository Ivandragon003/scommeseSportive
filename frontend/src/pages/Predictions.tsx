import React, { useState, useEffect, useMemo } from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { getTeams, getBudget, getMatches, getUpcomingMatches, getEurobetOddsForMatch, placeBet } from '../utils/api';
import axios from 'axios';

interface PredictionsProps { activeUser: string; }

const fmtPct = (n: number) => (n * 100).toFixed(2) + '%';
const fmtN = (n: number, d = 2) => n.toFixed(d);

const currentSeason = () => {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth() + 1;
  const start = month >= 7 ? year : year - 1;
  return `${start}/${start + 1}`;
};

const formatKickoff = (dateIso?: string) => {
  if (!dateIso) return '-';
  const d = new Date(dateIso);
  if (Number.isNaN(d.getTime())) return String(dateIso);
  return new Intl.DateTimeFormat('it-IT', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
};

const normalizeCompetitionName = (value?: string) =>
  String(value ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

const isSerieACompetition = (value?: string) => normalizeCompetitionName(value) === 'serie a';

const dateToDayKey = (dateIso?: string) => {
  if (!dateIso) return 'unknown';
  const d = new Date(dateIso);
  if (Number.isNaN(d.getTime())) return 'unknown';
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

const formatDayLabel = (dayKey: string) => {
  if (dayKey === 'unknown') return 'Data non disponibile';
  const d = new Date(`${dayKey}T00:00:00`);
  if (Number.isNaN(d.getTime())) return dayKey;
  const label = new Intl.DateTimeFormat('it-IT', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  }).format(d);
  return label.charAt(0).toUpperCase() + label.slice(1);
};

const buildSerieAMatchdayMap = (matches: any[]): Record<string, number> => {
  const ordered = [...(matches ?? [])]
    .filter((m: any) => isSerieACompetition(m.competition))
    .sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime());

  const out: Record<string, number> = {};
  const MATCHES_PER_ROUND = 10;
  ordered.forEach((m: any, idx: number) => {
    const id = String(m.match_id ?? '');
    if (!id) return;
    out[id] = Math.floor(idx / MATCHES_PER_ROUND) + 1;
  });
  return out;
};

const ODDS_GROUPS = [
  { title: 'Goal', keys: ['homeWin', 'draw', 'awayWin', 'btts', 'bttsNo', 'over15', 'over25', 'over35', 'over45', 'under25', 'under35'] },
  { title: 'Cartellini', keys: ['yellow_over_3.5', 'yellow_over_4.5', 'yellow_over_5.5', 'yellow_under_3.5', 'yellow_under_4.5'] },
  { title: 'Falli', keys: ['fouls_over_20.5', 'fouls_over_23.5', 'fouls_over_26.5', 'fouls_under_23.5'] },
  { title: 'Tiri', keys: ['shots_total_over_23.5', 'shots_total_over_25.5', 'shots_total_under_23.5', 'sot_total_over_7.5', 'sot_total_over_9.5'] },
];

const MARKET_LABELS: Record<string, string> = {
  homeWin: 'Casa (1)', draw: 'Pareggio (X)', awayWin: 'Ospite (2)',
  btts: 'Goal/Goal Si', bttsNo: 'Goal/Goal No',
  over15: 'Over 1.5', over25: 'Over 2.5', over35: 'Over 3.5', over45: 'Over 4.5',
  under25: 'Under 2.5', under35: 'Under 3.5',
  cards_over35: 'Cartellini O3.5', cards_over45: 'Cartellini O4.5',
  cards_over55: 'Cartellini O5.5', cards_under35: 'Cartellini U3.5',
  cards_under45: 'Cartellini U4.5', fouls_over205: 'Falli O20.5',
  fouls_over235: 'Falli O23.5', fouls_over265: 'Falli O26.5',
  fouls_under235: 'Falli U23.5', shots_over225: 'Tiri O22.5',
  shots_over255: 'Tiri O25.5', shots_under225: 'Tiri U22.5',
  sot_over75: 'Tiri Porta O7.5', sot_over95: 'Tiri Porta O9.5',
  'yellow_over_3.5': 'Gialli O3.5', 'yellow_over_4.5': 'Gialli O4.5', 'yellow_over_5.5': 'Gialli O5.5',
  'yellow_under_3.5': 'Gialli U3.5', 'yellow_under_4.5': 'Gialli U4.5',
  'fouls_over_20.5': 'Falli O20.5', 'fouls_over_23.5': 'Falli O23.5', 'fouls_over_26.5': 'Falli O26.5', 'fouls_under_23.5': 'Falli U23.5',
  'shots_total_over_23.5': 'Tiri Totali O23.5', 'shots_total_over_25.5': 'Tiri Totali O25.5', 'shots_total_under_23.5': 'Tiri Totali U23.5',
  'sot_total_over_7.5': 'Tiri Porta Totali O7.5', 'sot_total_over_9.5': 'Tiri Porta Totali O9.5',
};

const formatLineFromToken = (raw: string) => {
  const cleaned = String(raw ?? '').trim().replace(',', '.');
  if (/^\d+\.\d+$/.test(cleaned)) return cleaned;
  if (/^\d+$/.test(cleaned) && cleaned.length >= 2) return `${cleaned.slice(0, -1)}.${cleaned.slice(-1)}`;
  return cleaned;
};

const inferDynamicMarketLabel = (key: string): string | null => {
  const m = key.match(/^(shots_total|shots_home|shots_away|fouls|yellow|cards_total|sot_total)_(over|under)_([0-9]+(?:[.,][0-9]+)?)$/i);
  if (m) {
    const domainLabel: Record<string, string> = {
      shots_total: 'Tiri Totali',
      shots_home: 'Tiri Casa',
      shots_away: 'Tiri Ospite',
      fouls: 'Falli Totali',
      yellow: 'Gialli Totali',
      cards_total: 'Cartellini Pesati',
      sot_total: 'Tiri in Porta Totali',
    };
    const side = m[2].toLowerCase() === 'over' ? 'Over' : 'Under';
    return `${domainLabel[m[1].toLowerCase()] ?? m[1]} ${side} ${formatLineFromToken(m[3])}`;
  }
  return null;
};

const marketLabel = (key: string): string => MARKET_LABELS[key] ?? inferDynamicMarketLabel(key) ?? key;

const collectOddsKeysFromPrediction = (prediction: any): string[] => {
  const probs = prediction?.probabilities ?? {};
  const keys = new Set<string>([
    'homeWin', 'draw', 'awayWin', 'btts', 'bttsNo',
    'over05', 'over15', 'over25', 'over35', 'over45',
    'under15', 'under25', 'under35', 'under45',
  ]);

  const addOuPairs = (obj: any, prefix: string) => {
    for (const line of Object.keys(obj ?? {})) {
      keys.add(`${prefix}_over_${line}`);
      keys.add(`${prefix}_under_${line}`);
    }
  };

  addOuPairs(probs.shotsTotal, 'shots_total');
  addOuPairs(probs.shotsHome?.overUnder, 'shots_home');
  addOuPairs(probs.shotsAway?.overUnder, 'shots_away');
  addOuPairs(probs.cards?.overUnderYellow, 'yellow');
  addOuPairs(probs.cards?.overUnderTotal, 'cards_total');
  addOuPairs(probs.fouls?.overUnder, 'fouls');

  // Tiri in porta combinati (linee generate nel backend)
  for (const line of [5.5, 6.5, 7.5, 8.5, 9.5, 10.5, 11.5]) {
    const token = line.toFixed(1);
    keys.add(`sot_total_over_${token}`);
    keys.add(`sot_total_under_${token}`);
  }

  return Array.from(keys);
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
        <span style={{ fontSize: 12, color: '#5f6368' }}>Atteso = <strong>{fmtN(expected)}</strong></span>
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
  const [competition, setCompetition] = useState('Serie A');
  const [season, setSeason] = useState(currentSeason());
  const [isDerby, setIsDerby] = useState(false);
  const [isHighStakes, setIsHighStakes] = useState(false);
  const [loading, setLoading] = useState(false);
  const [upcomingLoading, setUpcomingLoading] = useState(false);
  const [upcomingMatches, setUpcomingMatches] = useState<any[]>([]);
  const [serieAMatchdayMap, setSerieAMatchdayMap] = useState<Record<string, number>>({});
  const [pred, setPred] = useState<any>(null);
  const [tab, setTab] = useState('1x2');
  const [budget, setBudget] = useState<any>(null);
  const [stakes, setStakes] = useState<Record<string, string>>({});
  const [betDone, setBetDone] = useState<Record<string, boolean>>({});
  const [odds, setOdds] = useState<Record<string, string>>({});
  const [oddsStatus, setOddsStatus] = useState('');
  const [oddsStatusTone, setOddsStatusTone] = useState<'info' | 'success' | 'warning' | 'danger'>('info');
  const [oddsPanelOpen, setOddsPanelOpen] = useState(false);

  useEffect(() => {
    getTeams().then(r => setTeams(r.data ?? []));
    getBudget(activeUser).then(r => setBudget(r.data));
  }, [activeUser]);

  const loadUpcomingMatches = async () => {
    setUpcomingLoading(true);
    try {
      const res = await getUpcomingMatches({
        competition: competition || undefined,
        season: season || undefined,
        limit: 380,
      });
      setUpcomingMatches(res.data ?? []);
    } catch (e) {
      console.error('Errore caricamento partite future:', e);
      setUpcomingMatches([]);
    } finally {
      setUpcomingLoading(false);
    }
  };

  const loadSerieAMatchdays = async () => {
    if (!season || season.trim() === '') {
      setSerieAMatchdayMap({});
      return;
    }
    try {
      const res = await getMatches({
        competition: 'Serie A',
        season: season.trim(),
      });
      setSerieAMatchdayMap(buildSerieAMatchdayMap(res.data ?? []));
    } catch (e) {
      console.error('Errore calcolo giornate Serie A:', e);
      setSerieAMatchdayMap({});
    }
  };

  useEffect(() => {
    loadUpcomingMatches();
  }, [competition, season]);

  useEffect(() => {
    loadSerieAMatchdays();
  }, [season]);

  const comps = Array.from(new Set(teams.map((t: any) => t.competition).filter(Boolean)));
  const competitionOptions = Array.from(new Set(['Serie A', ...comps]));
  const groupedUpcomingMatches = useMemo(() => {
    const groups = new Map<string, any[]>();
    for (const m of upcomingMatches) {
      const key = dateToDayKey(m.date);
      const bucket = groups.get(key) ?? [];
      bucket.push(m);
      groups.set(key, bucket);
    }

    return Array.from(groups.entries())
      .sort(([a], [b]) => {
        if (a === 'unknown') return 1;
        if (b === 'unknown') return -1;
        return a.localeCompare(b);
      })
      .map(([dayKey, matches]) => ({
        dayKey,
        dayLabel: formatDayLabel(dayKey),
        matches: [...matches].sort((a: any, b: any) => new Date(a.date).getTime() - new Date(b.date).getTime()),
      }));
  }, [upcomingMatches]);

  const parseOddsFromForm = () => {
    const parsed: Record<string, number> = {};
    Object.entries(odds).forEach(([k, v]) => {
      const n = parseFloat(v);
      if (!Number.isNaN(n) && n > 1) parsed[k] = n;
    });
    return parsed;
  };

  const applyOddsToForm = (incoming: Record<string, number>) => {
    const asStrings: Record<string, string> = {};
    for (const [k, v] of Object.entries(incoming ?? {})) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 1) asStrings[k] = v.toFixed(2);
    }
    setOdds(asStrings);
    setOddsPanelOpen(true);
  };

  const resolveTeamName = (teamId: string, fallback?: string) => {
    if (fallback && fallback.trim()) return fallback.trim();
    const found = teams.find((t: any) => t.team_id === teamId);
    return found?.name ?? teamId;
  };

  const loadEurobetOdds = async (match: any, comp: string) => {
    try {
      setOddsStatus('Recupero quote live in corso...');
      setOddsStatusTone('info');

      const homeName = resolveTeamName(String(match.home_team_id ?? ''), match.home_team_name);
      const awayName = resolveTeamName(String(match.away_team_id ?? ''), match.away_team_name);

      const res = await getEurobetOddsForMatch({
        competition: comp || 'Serie A',
        homeTeam: homeName,
        awayTeam: awayName,
        commenceTime: String(match.date ?? ''),
      });

      const payload = res.data ?? {};
      const selectedOdds = payload.selectedOdds ?? {};
      if (!payload.found || Object.keys(selectedOdds).length === 0) {
        setOddsStatus(payload.message ?? 'Quote non disponibili per questa partita al momento.');
        setOddsStatusTone('warning');
        setOddsPanelOpen(true);
        alert(payload.message ?? 'Quote non disponibili per questa partita al momento.');
        return undefined;
      }

      applyOddsToForm(selectedOdds);
      if (payload.usedSyntheticOdds) {
        setOddsStatus('API esterna non usata/disponibile: caricate quote stimate dal modello interno.');
        setOddsStatusTone('warning');
      } else if (payload.usedFallbackBookmaker) {
        setOddsStatus('Eurobet non disponibile ora: caricate quote del miglior bookmaker disponibile.');
        setOddsStatusTone('warning');
      } else {
        setOddsStatus('Quote Eurobet caricate automaticamente.');
        setOddsStatusTone('success');
      }
      return selectedOdds as Record<string, number>;
    } catch (e: any) {
      setOddsStatus(`Errore nel recupero quote automatiche: ${e.response?.data?.error ?? e.message}`);
      setOddsStatusTone('danger');
      setOddsPanelOpen(true);
      alert(`Errore quote automatiche: ${e.response?.data?.error ?? e.message}`);
      return undefined;
    }
  };

  const runPrediction = async (
    homeTeamId: string,
    awayTeamId: string,
    competitionOverride?: string,
    oddsOverride?: Record<string, number>
  ) => {
    setLoading(true); setPred(null);
    const bookmakerOdds = oddsOverride ?? parseOddsFromForm();
    try {
      const res = await axios.post('/api/predict', {
        homeTeamId, awayTeamId,
        competition: (competitionOverride ?? competition) || undefined,
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
        if ((res.data.data.valueOpportunities ?? []).length > 0) {
          setTab('value');
        }
      }
    } catch (e: any) { alert(e.response?.data?.error ?? e.message); }
    setLoading(false);
  };

  const handleAnalyzeUpcoming = async (match: any) => {
    const nextHome = String(match.home_team_id ?? '');
    const nextAway = String(match.away_team_id ?? '');
    const nextCompetition = String(match.competition ?? competition);
    const nextSeason = String(match.season ?? season);
    if (!nextHome || !nextAway) return;

    setOddsStatus('');
    setOddsStatusTone('info');
    setOdds({});
    if (nextCompetition && nextCompetition !== competition) setCompetition(nextCompetition);
    if (nextSeason && nextSeason !== season) setSeason(nextSeason);
    setTab('1x2');
    const autoOdds = await loadEurobetOdds(match, nextCompetition || competition);
    await runPrediction(nextHome, nextAway, nextCompetition || undefined, autoOdds);
  };

  const handleBet = async (opp: any) => {
    if (!budget) {
      alert('Inizializza prima il bankroll nella sezione Budget.');
      return;
    }
    const stake = parseFloat(stakes[opp.selection] ?? '0');
    if (!stake) { alert('Inserisci importo'); return; }
    try {
      await placeBet({
        userId: activeUser, matchId: pred.matchId,
        marketName: opp.marketName, selection: opp.selection,
        odds: opp.bookmakerOdds, stake,
        ourProbability: opp.ourProbability / 100,
        expectedValue: opp.expectedValue / 100,
      });
      setBetDone(p => ({ ...p, [opp.selection]: true }));
      getBudget(activeUser).then(r => setBudget(r.data));
    } catch (e: any) {
      alert(e?.response?.data?.error ?? e?.message ?? 'Errore nel piazzamento scommessa.');
    }
  };

  const gp = pred?.goalProbabilities;
  const cp = pred?.cardsPrediction;
  const fp = pred?.foulsPrediction;
  const sp = pred?.shotsPrediction;
  const pp: any[] = pred?.playerShotsPredictions ?? [];
  const vb: any[] = pred?.valueOpportunities ?? [];
  const staticOddsKeys = useMemo(() => new Set(ODDS_GROUPS.flatMap(g => g.keys)), []);
  const dynamicOddsKeys = useMemo(() => {
    const keys = new Set<string>([...Object.keys(odds), ...collectOddsKeysFromPrediction(pred)]);
    for (const k of staticOddsKeys) keys.delete(k);
    return Array.from(keys).sort((a, b) => a.localeCompare(b, 'it'));
  }, [odds, pred, staticOddsKeys]);

  const TABS = [
    { id: '1x2', label: '1X2 & Goal' },
    { id: 'handicap', label: 'Handicap' },
    { id: 'scores', label: 'Risultati Esatti' },
    { id: 'cards', label: 'Cartellini' },
    { id: 'fouls', label: 'Falli' },
    { id: 'shots', label: 'Tiri Squadra' },
    { id: 'players', label: `Tiri Giocatori${pp.length ? ` (${pp.length})` : ''}` },
    { id: 'value', label: `Scommesse (${vb.length})` },
  ];

  return (
    <div>
      <h1 className="page-title">Analisi Partita</h1>
      <p className="page-subtitle">
        Goal: Dixon-Coles (Poisson+t) - Cartellini/Falli: Binomiale Negativa - Tiri giocatori: ZIP
      </p>

      <div className="card">
        <div className="card-header"><h2 className="card-title">Configura Filtri e Quote</h2></div>
        <div className="form-row">
          <div className="form-group">
            <label className="form-label">Competizione</label>
            <select className="form-select" value={competition} onChange={e => setCompetition(e.target.value)}>
              <option value="">Tutte</option>
              {competitionOptions.map(c => <option key={c} value={c}>{c}</option>)}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Stagione</label>
            <input
              className="form-input"
              value={season}
              onChange={e => setSeason(e.target.value)}
              placeholder="es. 2025/2026"
            />
            <div style={{ marginTop: 6, fontSize: 11, color: 'var(--text-secondary)' }}>
              Default automatico: {currentSeason()}
            </div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 20, alignItems: 'center', paddingBottom: 14 }}>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer', fontSize: 13 }}>
            <input type="checkbox" checked={isDerby} onChange={e => setIsDerby(e.target.checked)} />
            Derby <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>(+22% gialli)</span>
          </label>
          <label style={{ display: 'flex', gap: 6, alignItems: 'center', cursor: 'pointer', fontSize: 13 }}>
            <input type="checkbox" checked={isHighStakes} onChange={e => setIsHighStakes(e.target.checked)} />
            Alta posta <span style={{ color: 'var(--text-secondary)', fontSize: 11 }}>(+12% gialli)</span>
          </label>
        </div>

        <details
          open={oddsPanelOpen}
          onToggle={(e) => setOddsPanelOpen((e.target as HTMLDetailsElement).open)}
          style={{ marginBottom: 14 }}
        >
          <summary style={{ cursor: 'pointer', fontWeight: 600, padding: '8px 0', fontSize: 14 }}>
            Quote Bookmaker (solo import automatico)
          </summary>
          <div style={{ paddingTop: 12 }}>
            <div style={{ marginBottom: 10, fontSize: 12, color: 'var(--text-secondary)' }}>
              Le quote vengono caricate automaticamente quando premi <strong>Analizza</strong> su una partita.
            </div>
            {ODDS_GROUPS.map(g => (
              <div key={g.title} style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                  {g.title}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 8 }}>
                  {g.keys.map(k => (
                    <div className="form-group" key={k} style={{ marginBottom: 0 }}>
                      <label className="form-label" style={{ fontSize: 11 }}>{marketLabel(k)}</label>
                      <div className="form-input" style={{ display: 'flex', alignItems: 'center', minHeight: 38 }}>
                        {odds[k] ?? '-'}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ))}

            {dynamicOddsKeys.length > 0 && (
              <div style={{ marginBottom: 8 }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-secondary)', textTransform: 'uppercase', letterSpacing: '0.05em', marginBottom: 8 }}>
                  Mercati Extra (dinamici)
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(180px, 1fr))', gap: 8 }}>
                  {dynamicOddsKeys.map(k => (
                    <div className="form-group" key={k} style={{ marginBottom: 0 }}>
                      <label className="form-label" style={{ fontSize: 11 }}>{marketLabel(k)}</label>
                      <div className="form-input" style={{ display: 'flex', alignItems: 'center', minHeight: 38 }}>
                        {odds[k] ?? '-'}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </details>

        {oddsStatus && (
          <div className={`alert alert-${oddsStatusTone}`} style={{ marginBottom: 14 }}>
            {oddsStatus}
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-header">
          <div>
            <h2 className="card-title">Partite da Giocare</h2>
            <div className="card-subtitle">
              {competition || 'Tutte le competizioni'} {season ? `- Stagione ${season}` : ''}
            </div>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={loadUpcomingMatches} disabled={upcomingLoading}>
            {upcomingLoading ? 'Aggiornamento...' : 'Aggiorna'}
          </button>
        </div>

        {upcomingLoading ? (
          <div className="loading-spinner">
            <div className="spinner"></div>
            <div>Caricamento partite future...</div>
          </div>
        ) : groupedUpcomingMatches.length === 0 ? (
          <div className="alert alert-info">
            Nessuna partita futura trovata con questi filtri. Se hai appena importato i dati, premi "Aggiorna".
          </div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table>
              <thead>
                <tr>
                  <th>Data/Ora</th>
                  <th>Casa</th>
                  <th>Ospite</th>
                  <th>Competizione</th>
                  <th>Stagione</th>
                  <th style={{ width: 120 }}>Azione</th>
                </tr>
              </thead>
              <tbody>
                {groupedUpcomingMatches.map(group => (
                  <React.Fragment key={group.dayKey}>
                    <tr>
                      <td colSpan={6} style={{ background: 'var(--bg)', fontWeight: 700, fontSize: 13 }}>
                        {group.dayLabel} - {group.matches.length} partite
                      </td>
                    </tr>
                    {group.matches.map((m: any) => {
                      const matchday = serieAMatchdayMap[String(m.match_id ?? '')];
                      const showMatchday = isSerieACompetition(m.competition ?? competition);
                      return (
                        <tr key={m.match_id}>
                          <td>
                            <div>{formatKickoff(m.date)}</div>
                            {showMatchday && (
                              <div style={{ fontSize: 11, color: 'var(--text-secondary)', marginTop: 2 }}>
                                {matchday ? `Giornata ${matchday}` : 'Giornata -'}
                              </div>
                            )}
                          </td>
                          <td>{m.home_team_name ?? m.home_team_id}</td>
                          <td>{m.away_team_name ?? m.away_team_id}</td>
                          <td>{m.competition ?? '-'}</td>
                          <td>{m.season ?? '-'}</td>
                          <td>
                            <button className="btn btn-primary btn-sm" onClick={() => handleAnalyzeUpcoming(m)} disabled={loading}>
                              Analizza
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {pred && (
        <>
          <div className="match-header">
            <div style={{ textAlign: 'right', flex: 1 }}>
              <div className="team-name">{pred.homeTeam}</div>
              <div className="expected-goals" style={{ justifyContent: 'flex-end' }}>
                <span className="xg-chip">lambda = {pred.lambdaHome}</span>
              </div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div className="vs">VS</div>
              <div className="match-meta">Confidenza: {(pred.modelConfidence * 100).toFixed(0)}%</div>
            </div>
            <div style={{ textAlign: 'left', flex: 1 }}>
              <div className="team-name">{pred.awayTeam}</div>
              <div className="expected-goals">
                <span className="xg-chip">lambda = {pred.lambdaAway}</span>
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
                <strong>Binomiale Negativa</strong> - La varianza dei cartellini ({fmtN(cp.totalYellow.variance)}) &gt; media ({fmtN(cp.totalYellow.expected)}):
                overdispersion che la Poisson non puo modellare. Parametro r calibrato su dati storici.
                {cp.confidenceLevel < 0.7 && <span style={{ color: 'var(--warning)' }}> Dati limitati (confidenza {(cp.confidenceLevel*100).toFixed(0)}%)</span>}
              </div>
              <div className="grid-2">
                <div className="card">
                  <div className="card-header">
                    <h2 className="card-title">Gialli Totali</h2>
                    <div>
                      <span className="badge badge-blue">Media = {fmtN(cp.totalYellow.expected)}</span>
                      {' '}<span className="badge badge-gray">Var = {fmtN(cp.totalYellow.variance)}</span>
                    </div>
                  </div>
                  <DistChart dist={cp.totalYellow.distribution} expected={cp.totalYellow.expected}
                    title="P(gialli = k) - NegBin" color="#fbbc04" />
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
                    <strong>Rossi</strong> - media attesa: {fmtN(cp.totalRed.expected, 3)} &nbsp;&nbsp;
                    P(almeno 1 rosso): <strong>{(cp.totalRed.probAtLeastOne * 100).toFixed(1)}%</strong>
                  </div>
                  <div style={{ marginTop: 12, padding: 12, background: 'var(--bg)', borderRadius: 6 }}>
                    <div style={{ fontWeight: 600, marginBottom: 8, fontSize: 13 }}>Cartellini Pesati (1G=1, 1R=2)</div>
                    <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 6 }}>Media = {fmtN(cp.totalCardsWeighted.expected)}</div>
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
                <h2 className="card-title">Falli - Binomiale Negativa</h2>
                <div>
                  <span className="badge badge-blue">Media = {fmtN(fp.totalFouls.expected)}</span>
                  {' '}<span className="badge badge-gray">Var = {fmtN(fp.totalFouls.variance)}</span>
                </div>
              </div>
              <div className="alert alert-info" style={{ marginBottom: 14 }}>
                Casa: {fmtN(fp.homeFouls.expected)} falli attesi - Ospite: {fmtN(fp.awayFouls.expected)} falli attesi
                - Rapporto var/media = {fmtN(fp.totalFouls.variance / fp.totalFouls.expected, 2)}x (overdispersion)
              </div>
              <DistChart dist={fp.totalFouls.distribution} expected={fp.totalFouls.expected}
                title="P(falli totali = k) - Binomiale Negativa" color="#5f6368" />
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
                    <span className="badge badge-blue">Media tiri = {fmtN(sp.home.totalShots.expected)}</span>
                  </div>
                  <DistChart dist={sp.home.totalShots.distribution} expected={sp.home.totalShots.expected}
                    title="Tiri totali" color="var(--primary)" />
                  <DistChart dist={sp.home.shotsOnTarget.distribution} expected={sp.home.shotsOnTarget.expected}
                    title="Tiri in porta" color="var(--secondary)" />
                </div>
                <div className="card">
                  <div className="card-header">
                    <h2 className="card-title">{pred.awayTeam}</h2>
                    <span className="badge badge-red">Media tiri = {fmtN(sp.away.totalShots.expected)}</span>
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
                    Tiri: {fmtN(sp.combined.totalShots.expected)} - In porta: {fmtN(sp.combined.totalOnTarget.expected)}
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
                  P(X=0) = pi + (1-pi)e^(-lambda) - E(X) = (1-pi)lambda - Var(X) = (1-pi)lambda(1+pi*lambda)<br /><br />
                  Il parametro pi cattura la probabilita strutturale di zero tiri (giocatore fuori, neutralizzato, non in forma).
                  Questo distingue il "vero" zero da chi semplicemente non ha tirato per caso.<br /><br />
                  I parametri pi e lambda vengono stimati con algoritmo EM (Expectation-Maximization) su dati storici per giocatore.<br /><br />
                  Per usare questo modello, passa i profili giocatori nell'API o caricali dalla sezione Gestione Dati.
                </div>
              ) : pp.map((p: any) => (
                <div className="card" key={p.playerId}>
                  <div className="card-header">
                    <div>
                      <h2 className="card-title">{p.playerName}</h2>
                      <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                        {p.position} - Confidenza: {(p.confidenceLevel * 100).toFixed(0)}% ({p.sampleSize} partite)
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
                      <ProbBar label=">=1 tiro (Over 0.5)" value={p.markets.over05shots} color="var(--primary)" />
                      <ProbBar label=">=2 tiri (Over 1.5)" value={p.markets.over15shots} color="var(--primary)" />
                      <ProbBar label=">=3 tiri (Over 2.5)" value={p.markets.over25shots} color="var(--warning)" />
                      <ProbBar label="0 tiri" value={p.markets.zeroShots} color="var(--neutral)" />
                      <div style={{ borderTop: '1px solid var(--border)', marginTop: 8, paddingTop: 8 }}>
                        <ProbBar label=">=1 in porta" value={p.markets.over05onTarget} color="var(--secondary)" />
                        <ProbBar label=">=2 in porta" value={p.markets.over15onTarget} color="var(--secondary)" />
                      </div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}

          {tab === 'value' && (
            <div>
              {!budget && (
                <div className="alert alert-warning" style={{ marginBottom: 12 }}>
                  Per piazzare scommesse inizializza prima il bankroll nella sezione Budget Manager.
                </div>
              )}
              {vb.length === 0 ? (
                <div className="alert alert-info">Inserisci le quote del bookmaker per calcolare EV/Kelly e vedere dove scommettere.</div>
              ) : (
                <>
                  <div className="alert alert-success">
                    {vb.length} scommesse a EV positivo (soglia EV &gt; 2%). Seleziona importo e premi Scommetti per registrarla nel bankroll.
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
                          <span style={{ fontSize: 13 }}>Puntata (EUR):</span>
                          <input className="form-input" type="number" style={{ width: 90 }}
                            value={stakes[o.selection] ?? ''} placeholder={`${o.suggestedStakePercent}%`}
                            onChange={e => setStakes(p => ({ ...p, [o.selection]: e.target.value }))} />
                          {budget && <span style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                            suggerito: EUR {((o.suggestedStakePercent / 100) * (budget.available_budget ?? 0)).toFixed(2)}
                          </span>}
                        </div>
                        {betDone[o.selection] ? (
                          <span className="badge badge-green">OK Registrata</span>
                        ) : (
                          <button className="btn btn-success btn-sm" onClick={() => handleBet(o)} disabled={!budget}>Scommetti</button>
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
