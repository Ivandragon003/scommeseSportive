import React, { useState, useEffect, useMemo, useRef } from 'react';
import { getTeams, getBudget, getMatchdayMap, getUpcomingMatches, getRecentMatches, getEurobetOddsForMatch, replayPlayedMatchPrediction, placeBet, getBets } from '../utils/api';
import axios from 'axios';
import PredictionHero from '../components/predictions/PredictionHero';
import BestValueCard from '../components/predictions/BestValueCard';
import OddsSourceBadge from '../components/predictions/OddsSourceBadge';
import StakePlanner from '../components/predictions/StakePlanner';
import MethodologyDrawer from '../components/predictions/MethodologyDrawer';
import ShotsSection from '../components/predictions/ShotsSection';
import ValueOpportunitiesTable from '../components/predictions/ValueOpportunitiesTable';
import { DistChart, ProbBar } from '../components/predictions/PredictionStatPrimitives';
import { formatCompactOuKey, fmtN, fmtPct, fmtSelection, marketTierBadgeClass, marketTierLabel } from '../components/predictions/predictionFormatting';
import { BestValueOpportunity as BestValueOpportunityModel } from '../components/predictions/predictionTypes';

interface PredictionsProps { activeUser: string; }

const currentSeason = () => {
  const now = new Date(); const y = now.getFullYear(); const m = now.getMonth() + 1;
  const s = m >= 7 ? y : y - 1; return `${s}/${s + 1}`;
};
const formatKickoff = (d?: string) => {
  if (!d) return '-';
  const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return String(d);
  return new Intl.DateTimeFormat('it-IT', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }).format(dt);
};
const normComp = (v?: string) =>
  String(v??'').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/\s+/g,' ').trim();
const isSerieA = (v?: string) => normComp(v) === 'serie a';
const dateToDayKey = (d?: string) => {
  if (!d) return 'unknown'; const dt = new Date(d);
  if (Number.isNaN(dt.getTime())) return 'unknown';
  return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`;
};
const formatDayLabel = (k: string) => {
  if (k === 'unknown') return 'Data sconosciuta';
  const d = new Date(`${k}T00:00:00`);
  if (Number.isNaN(d.getTime())) return k;
  const l = new Intl.DateTimeFormat('it-IT', { weekday:'short', day:'2-digit', month:'short' }).format(d);
  return l.charAt(0).toUpperCase() + l.slice(1);
};

const confidenceRank = (v?: string): number => v === 'HIGH' ? 3 : v === 'MEDIUM' ? 2 : 1;
const buildOddsReliabilityBadge = (pred: any, isReplay: boolean) => {
  if (isReplay) {
    return pred?.oddsReplaySource === 'historical_bookmaker_snapshot'
      ? { label: 'Snapshot bookmaker reale', className: 'pr-badge-green' }
      : { label: 'Replay su quote modello', className: 'pr-badge-gold' };
  }
  if (pred?.oddsSource === 'eurobet_scraper') return { label: 'Quote reali Eurobet', className: 'pr-badge-green' };
  if (pred?.oddsSource === 'fallback_provider') return { label: 'Quote provider secondario', className: 'pr-badge-gold' };
  if (pred?.oddsSource === 'eurobet_unavailable') return { label: 'Quote Eurobet non disponibili', className: 'pr-badge-gray' };
  return { label: 'Fonte quote n/d', className: 'pr-badge-gray' };
};
const rankOpportunity = (o: any): number => {
  const ev = Number(o?.expectedValue ?? 0);
  const edge = Number(o?.edge ?? 0);
  const p = Number(o?.ourProbability ?? 0);
  const pNorm = p > 1 ? p / 100 : p;
  return (ev * 0.55) + (edge * 0.30) + (pNorm * 8) + (confidenceRank(o?.confidence) * 4);
};
const fmtMarketKey = (market: string): string => {
  const k = String(market ?? '').toLowerCase();
  if (k === 'h2h') return '1X2';
  if (k === 'h2h_3_way') return '1X2 (3-way)';
  if (k === 'double_chance') return 'Double Chance';
  if (k === 'draw_no_bet') return 'Draw No Bet';
  if (k === 'btts') return 'Goal/No Goal';
  if (k === 'totals') return 'Totali Goal';
  if (k === 'team_totals') return 'Team Totals';
  if (k === 'alternate_totals') return 'Totali Alternativi';
  if (k === 'spreads') return 'Handicap';
  if (k === 'alternate_spreads') return 'Handicap Alternativi';
  if (k === 'alternate_team_totals') return 'Team Totals Alternativi';
  if (k === 'model_estimated') return 'Quote stimate dal modello';
  return market;
};

const buildBetKey = (matchId: string, selection: string, marketName: string): string =>
  `${String(matchId ?? '')}::${String(selection ?? '')}::${String(marketName ?? '')}`;

const sanitizePredictionForEurobetOnly = (prediction: any, oddsSource?: string | null) => {
  if (!prediction) return prediction;
  if (oddsSource === 'eurobet_scraper') {
    return {
      ...prediction,
      oddsSource: 'eurobet_scraper',
      usedSyntheticOdds: false,
      usedFallbackBookmaker: false,
    };
  }
  if (oddsSource === 'fallback_provider') {
    return {
      ...prediction,
      oddsSource: 'fallback_provider',
      usedSyntheticOdds: false,
      usedFallbackBookmaker: true,
    };
  }
  return {
    ...prediction,
    oddsSource: oddsSource ?? 'eurobet_unavailable',
    usedSyntheticOdds: false,
    usedFallbackBookmaker: false,
    valueOpportunities: [],
    bestValueOpportunity: null,
  };
};

const VALUE_LEGEND: Array<{ term: string; meaning: string }> = [
  { term: 'Quota', meaning: 'Prezzo bookmaker decimale della selezione (es. 2.10).' },
  { term: 'P. Nostra', meaning: 'Probabilita stimata dal modello per quella selezione.' },
  { term: 'P. Implicita', meaning: 'Probabilita del bookmaker: 1 / quota.' },
  { term: 'EV', meaning: 'Valore atteso: EV = p_model * quota - 1. Se > 0, la quota e teoricamente di valore.' },
  { term: 'Edge', meaning: 'Vantaggio stimato: p_model - p_implicita.' },
  { term: 'Kelly 1/4', meaning: 'Percentuale consigliata di stake sul bankroll con Kelly frazionale (25%).' },
  { term: 'Base modello', meaning: 'Punteggio basato su EV, edge, Kelly e confidenza.' },
  { term: 'Contesto', meaning: 'Correzione con fattori match: campo, forma, obiettivi, assenze, espulsioni, diffidati.' },
  { term: 'Score totale', meaning: 'Base modello + Contesto. Il piu alto e la miglior giocata proposta.' },
  { term: 'Home advantage', meaning: 'Vantaggio campo: >0 favorisce casa, <0 favorisce ospite.' },
  { term: 'Form delta', meaning: 'Differenza forma recente: >0 casa meglio, <0 ospite meglio.' },
  { term: 'Motivation delta', meaning: 'Differenza obiettivi/motivazione: >0 casa piu motivata.' },
];

/*  STYLES  */
const S = `
@import url('https://fonts.googleapis.com/css2?family=Atkinson+Hyperlegible:wght@400;700&family=DM+Mono:wght@400;500&display=swap');

.pr {
  display:flex;
  height:100%;
  min-height:calc(100vh - var(--header-height) - var(--sync-height));
  overflow:hidden;
  font-family:var(--font-sans);
  background:var(--bg);
  color:var(--text);
}

/* LEFT PANEL  fixed sidebar */
.pr-left {
  width:380px; min-width:300px; max-width:420px;
  border-right:1px solid var(--border);
  display:flex; flex-direction:column;
  background:var(--surface); overflow:hidden; flex-shrink:0;
}
.pr-left-head {
  padding:20px 20px 14px; border-bottom:1px solid var(--border);
  flex-shrink:0;
}
.pr-left-title { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:1.5px; color:var(--text-2); margin-bottom:14px; }
.pr-season-row { display:grid; grid-template-columns:1fr 1fr; gap:8px; margin-bottom:10px; }

/* MATCH LIST */
.pr-list { flex:1; overflow-y:auto; scrollbar-width:thin; scrollbar-color:rgba(115,136,161,0.28) transparent; }
.pr-list::-webkit-scrollbar { width:3px; }
.pr-list::-webkit-scrollbar-thumb { background:rgba(115,136,161,0.28); border-radius:2px; }
.pr-day-sep {
  position:sticky; top:0; z-index:2;
  background:var(--surface3); border-bottom:1px solid var(--border);
  padding:6px 16px; font-size:10px; font-weight:700;
  text-transform:uppercase; letter-spacing:1.2px; color:var(--text-3);
}
.pr-match-row {
  display:flex; align-items:center; gap:10px;
  padding:10px 16px; border-bottom:1px solid rgba(115,136,161,0.12);
  cursor:pointer; transition:background var(--transition); position:relative;
}
.pr-match-row:hover { background:var(--surface2); }
.pr-match-row.active { background:var(--blue-dim) !important; border-left:2px solid var(--blue); padding-left:14px; }
.pr-match-row.loading-row { opacity:.5; pointer-events:none; }
.pr-match-time { font-family:'DM Mono',monospace; font-size:10px; color:var(--text-3); width:32px; flex-shrink:0; text-align:center; }
.pr-match-teams { flex:1; min-width:0; }
.pr-match-home, .pr-match-away { font-size:12px; font-weight:700; color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; line-height:1.4; }
.pr-match-away { color:var(--text-2); font-weight:600; }
.pr-match-md { font-family:'DM Mono',monospace; font-size:9px; color:var(--text-3); margin-top:2px; }
.pr-match-comp { font-size:9px; font-weight:700; color:var(--text-3); text-transform:uppercase; letter-spacing:.8px; flex-shrink:0; max-width:60px; text-align:right; }
.pr-match-vb {
  position:absolute; right:12px; top:50%; transform:translateY(-50%);
  background:var(--green-dim); border:1px solid var(--green-border);
  border-radius:10px; padding:1px 7px; font-size:9px; font-weight:700; color:var(--green);
}

/* RIGHT PANEL  scrollable results */
.pr-right { flex:1; overflow-y:auto; min-width:0; }

/* EMPTY STATE */
.pr-empty-state {
  display:flex; flex-direction:column; align-items:center; justify-content:center;
  height:100%; color:var(--text-3); text-align:center; padding:40px;
}
.pr-empty-icon { font-size:48px; margin-bottom:16px; }
.pr-empty-msg { font-size:13px; line-height:1.7; }

/* RESULTS HEADER */
.pr-results-head {
  position:sticky; top:0; z-index:10;
  background:var(--surface); border-bottom:1px solid var(--border);
  padding:14px 24px; display:flex; align-items:center; justify-content:space-between;
}
.pr-results-match { font-size:15px; font-weight:800; letter-spacing:-.3px; }
.pr-results-meta { font-size:11px; color:var(--text-2); font-family:'DM Mono',monospace; margin-top:2px; }
.pr-odds-status { font-size:11px; padding:4px 12px; border-radius:20px; }
.pr-odds-status.info    { background:var(--blue-dim);  color:var(--blue);  }
.pr-odds-status.success { background:var(--green-dim); color:var(--green); }
.pr-odds-status.warning { background:var(--gold-dim);  color:var(--gold);  }
.pr-odds-status.danger  { background:var(--red-dim);   color:var(--red);   }

/* MATCH HERO COMPACT */
.pr-hero {
  margin:16px 20px; padding:20px 24px;
  background:var(--surface); border:1px solid var(--border);
  border-radius:var(--radius-xl);
  display:grid; grid-template-columns:1fr 80px 1fr;
  align-items:center; gap:16px;
  position:relative; overflow:hidden;
}
.pr-hero::before {
  content:''; position:absolute; inset:0;
  background:radial-gradient(ellipse at 50% 0%, rgba(76,201,240,0.06) 0%, transparent 65%);
  pointer-events:none;
}
.pr-hero-team { display:flex; flex-direction:column; gap:5px; }
.pr-hero-team.right { text-align:right; align-items:flex-end; }
.pr-hero-name { font-size:16px; font-weight:800; letter-spacing:-.3px; }
.pr-hero-lambda {
  display:inline-flex; align-items:center; gap:4px;
  background:var(--surface2); border:1px solid var(--border);
  border-radius:20px; padding:3px 10px;
  font-family:'DM Mono',monospace; font-size:11px; color:var(--text-2);
}
.pr-hero-center { text-align:center; }
.pr-hero-vs { font-size:11px; font-weight:800; color:var(--text-3); letter-spacing:3px; margin-bottom:6px; }
.pr-confidence {
  background:var(--blue-dim); border:1px solid var(--blue-border);
  border-radius:20px; padding:4px 12px;
  font-size:11px; color:var(--blue); font-family:'DM Mono',monospace;
}

/* KPI ROW */
.pr-kpi-row { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin:0 20px 16px; }
.pr-kpi {
  background:var(--surface2); border:1px solid var(--border);
  border-radius:var(--radius-sm); padding:12px 14px; text-align:center;
}
.pr-kpi-val { font-family:'DM Mono',monospace; font-size:20px; font-weight:700; }
.pr-kpi-lbl { font-size:9px; text-transform:uppercase; letter-spacing:1.2px; color:var(--text-2); font-weight:700; margin-top:3px; }

/* TABS */
.pr-tabs { display:flex; gap:2px; padding:0 20px 12px; overflow-x:auto; scrollbar-width:none; flex-shrink:0; }
.pr-tabs::-webkit-scrollbar { display:none; }
.pr-tab {
  font-family:var(--font-sans); font-size:11px; font-weight:700;
  white-space:nowrap; padding:7px 14px; border-radius:8px;
  border:1px solid transparent; background:transparent; color:var(--text-3);
  cursor:pointer; transition:all var(--transition); flex-shrink:0;
}
.pr-tab:hover { color:var(--text); background:var(--surface3); border-color:var(--border); }
.pr-tab.active { background:var(--surface3); color:var(--text); border-color:var(--border-hover); }
.pr-tab-pill {
  display:inline-flex; background:var(--green-dim); color:var(--green);
  border-radius:10px; padding:1px 6px; font-size:9px; margin-left:4px;
}

/* CONTENT AREA */
.pr-content { padding:0 20px 32px; }

/* PROB BARS */
.pr-prob-row { display:flex; align-items:center; gap:10px; margin-bottom:8px; }
.pr-prob-lbl { font-size:12px; color:var(--text-2); width:100px; flex-shrink:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.pr-prob-track { flex:1; background:var(--surface3); border:1px solid var(--border); border-radius:100px; height:24px; overflow:hidden; }
.pr-prob-fill {
  height:100%; border-radius:100px;
  display:flex; align-items:center; justify-content:flex-end;
  padding-right:8px; font-size:10px; font-family:'DM Mono',monospace;
  font-weight:500; color:#000; transition:width .5s cubic-bezier(.4,0,.2,1); min-width:40px;
}

/* SECTION TITLE */
.pr-sec { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:1.4px; color:var(--text-3); margin-bottom:10px; }

/* GRID */
.pr-g2 { display:grid; grid-template-columns:1fr 1fr; gap:14px; }

/* SCORE GRID */
.pr-score-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(80px,1fr)); gap:8px; }
.pr-score-cell {
  background:var(--surface2); border:1px solid var(--border);
  border-radius:10px; padding:12px 8px; text-align:center;
  transition:all var(--transition);
}
.pr-score-cell:hover { transform:translateY(-2px); border-color:var(--border-hover); }
.pr-score-cell.hot { border-color:var(--blue-border); background:var(--blue-dim); }
.pr-score-cell.warm { border-color:var(--green-border); background:var(--green-dim); }
.pr-score-val { font-size:18px; font-weight:800; font-family:'DM Mono',monospace; }
.pr-score-pct { font-size:10px; font-family:'DM Mono',monospace; color:var(--blue); margin-top:2px; }

/* CHART */
.pr-chart-head { display:flex; justify-content:space-between; margin-bottom:6px; font-size:11px; color:var(--text-2); }
.pr-chart-head strong { color:var(--text); font-family:'DM Mono',monospace; }

/* AH GRID */
.pr-ah-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:6px; margin-top:10px; }
.pr-ah-cell { display:flex; justify-content:space-between; align-items:center; background:var(--surface2); border:1px solid var(--border); border-radius:7px; padding:7px 12px; font-size:12px; }
.pr-ah-cell strong { font-family:'DM Mono',monospace; }

/* VALUE BETS */
.pr-vb {
  border:1px solid var(--border); border-radius:var(--radius);
  background:var(--surface); overflow:hidden; margin-bottom:12px;
  transition:border-color var(--transition);
}
.pr-vb:hover { border-color:var(--green-border); }
.pr-vb.medium { border-left:3px solid var(--gold); }
.pr-vb.low    { border-left:3px solid var(--text-3); }
.pr-vb-top {
  display:flex; justify-content:space-between; align-items:flex-start;
  padding:14px 18px; border-bottom:1px solid var(--border);
}
.pr-vb-market { font-size:14px; font-weight:800; margin-bottom:6px; }
.pr-vb-market-sub { font-size:11px; color:var(--text-2); font-family:'DM Mono',monospace; }
.pr-vb-ev-num { font-family:'DM Mono',monospace; font-size:20px; font-weight:700; color:var(--green); }
.pr-vb-ev-lbl { font-size:9px; color:var(--text-2); letter-spacing:1px; text-align:right; }
.pr-vb-stats { display:grid; grid-template-columns:repeat(5,1fr); border-bottom:1px solid var(--border); }
.pr-vb-stat { padding:10px 14px; border-right:1px solid var(--border); }
.pr-vb-stat:last-child { border-right:none; }
.pr-vb-stat-lbl { font-size:9px; text-transform:uppercase; letter-spacing:1px; color:var(--text-3); font-weight:700; margin-bottom:3px; }
.pr-vb-stat-val { font-family:'DM Mono',monospace; font-size:13px; font-weight:600; }
.pr-vb-bottom {
  display:flex; justify-content:space-between; align-items:center;
  padding:10px 18px; background:var(--surface2); gap:12px;
}
.pr-stake-wrap { display:flex; align-items:center; gap:10px; }
.pr-stake-lbl { font-size:11px; color:var(--text-2); }
.pr-stake-input {
  background:var(--surface); border:1px solid var(--border); border-radius:7px;
  padding:7px 12px; color:var(--text); font-family:'DM Mono',monospace;
  font-size:13px; width:90px; outline:none; transition:border-color var(--transition);
}
.pr-stake-input:focus { border-color:var(--green); }
.pr-suggest { font-size:10px; color:var(--text-3); font-family:'DM Mono',monospace; display:flex; flex-direction:column; line-height:1.35; }

/* BADGES / ALERTS inline */
.pr-badge {
  display:inline-flex; align-items:center; font-family:'DM Mono',monospace;
  font-size:9px; font-weight:600; padding:2px 9px; border-radius:20px; border:1px solid transparent;
}
.pr-badge-green  { background:var(--green-dim);  color:var(--green);  border-color:var(--green-border); }
.pr-badge-blue   { background:var(--blue-dim);   color:var(--blue);   border-color:var(--blue-border);  }
.pr-badge-gold   { background:var(--gold-dim);   color:var(--gold);   border-color:var(--gold-border);  }
.pr-badge-gray   { background:var(--surface3); color:var(--text-2); border-color:var(--border); }
.pr-badge-purple { background:var(--purple-dim); color:var(--purple); border-color:var(--purple-border); }

.pr-alert { padding:10px 14px; border-radius:10px; font-size:12px; line-height:1.6; margin-bottom:12px; }
.pr-alert-info    { background:var(--blue-dim);  border:1px solid var(--blue-border);  color:var(--blue);  }
.pr-alert-success { background:var(--green-dim); border:1px solid var(--green-border); color:var(--green); }
.pr-alert-warning { background:var(--gold-dim);  border:1px solid var(--gold-border);  color:var(--gold);  }
.pr-alert-danger  { background:var(--red-dim);   border:1px solid var(--red-border);   color:var(--red);   }

/* CARDS */
.pr-card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); overflow:hidden; margin-bottom:14px; }
.pr-card-head { display:flex; align-items:center; justify-content:space-between; padding:14px 18px; border-bottom:1px solid var(--border); }
.pr-card-title { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:1.3px; color:var(--text-2); }
.pr-card-body { padding:18px; }
.pr-odds-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:8px; }
.pr-odds-cell {
  display:flex; justify-content:space-between; align-items:center;
  background:var(--surface2); border:1px solid var(--border);
  border-radius:9px; padding:8px 10px; gap:10px;
}
.pr-odds-cell.best { border-color:var(--green-border); background:var(--green-dim); }
.pr-odds-name { font-size:12px; color:var(--text-2); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.pr-odds-val { font-family:'DM Mono',monospace; font-size:13px; font-weight:700; color:var(--text); }
.pr-legend-grid { display:grid; grid-template-columns:1fr; gap:6px; }
.pr-legend-row {
  display:grid; grid-template-columns:170px 1fr; gap:10px;
  padding:8px 10px; border:1px solid var(--border); border-radius:8px;
  background:var(--surface2);
}
.pr-legend-term { font-family:'DM Mono',monospace; font-size:11px; color:var(--text); font-weight:700; }
.pr-legend-meaning { font-size:11px; color:var(--text-2); }

/* SPINNER */
.pr-spin { width:24px; height:24px; border:2px solid var(--border); border-top-color:var(--blue); border-radius:50%; animation:pr-s .6s linear infinite; flex-shrink:0; }
@keyframes pr-s { to { transform:rotate(360deg); } }

/* LOADING overlay on match row */
.pr-match-spinner { position:absolute; right:12px; top:50%; transform:translateY(-50%); }

/* PLAYER */
.pr-player-head { display:flex; justify-content:space-between; align-items:flex-start; }
.pr-player-name { font-size:15px; font-weight:800; margin-bottom:3px; }
.pr-player-meta { font-size:11px; color:var(--text-2); }
.pr-player-xg-val { font-size:22px; font-weight:800; font-family:'DM Mono',monospace; color:var(--blue); text-align:right; }
.pr-player-xg-lbl { font-size:10px; color:var(--text-2); text-align:right; }

/* INFO BOX */
.pr-info { background:var(--surface2); border:1px solid var(--border); border-radius:9px; padding:12px 14px; font-size:12px; color:var(--text-2); line-height:1.65; margin-top:8px; }
.pr-info strong { color:var(--text); }

/* INPUT/SELECT small */
.pr-select-sm, .pr-input-sm {
  background:var(--surface2); border:1px solid var(--border); border-radius:8px;
  padding:8px 12px; color:var(--text); font-family:'DM Mono',monospace; font-size:12px;
  width:100%; outline:none; transition:border-color var(--transition);
}
.pr-select-sm:focus, .pr-input-sm:focus { border-color:var(--blue); }
.pr-select-sm { appearance:none; cursor:pointer; }

@media (max-width:900px) {
  .pr { flex-direction:column; height:auto; overflow:visible; }
  .pr-left { width:100%; max-width:100%; height:auto; border-right:none; border-bottom:1px solid var(--border); }
  .pr-list { max-height:320px; }
  .pr-right { min-height:400px; }
  .pr-g2 { grid-template-columns:1fr; }
  .pr-vb-stats { grid-template-columns:repeat(2,1fr); }
}
`;

/*  MAIN  */
const Predictions: React.FC<PredictionsProps> = ({activeUser}) => {
  const [teams, setTeams] = useState<any[]>([]);
  const [competition, setCompetition] = useState('Serie A');
  const [season, setSeason] = useState(currentSeason());
  const [matchMode, setMatchMode] = useState<'upcoming'|'recent'>('upcoming');
  const [loading, setLoading] = useState(false);
  const [loadingMatchId, setLoadingMatchId] = useState<string|null>(null);
  const [upcomingLoading, setUpcomingLoading] = useState(false);
  const [upcoming, setUpcoming] = useState<any[]>([]);
  const [recentMatches, setRecentMatches] = useState<any[]>([]);
  const [matchdayMap, setMatchdayMap] = useState<Record<string,number>>({});
  const [pred, setPred] = useState<any>(null);
  const [activeMatchId, setActiveMatchId] = useState<string|null>(null);
  const [tab, setTab] = useState('1x2');
  const [budget, setBudget] = useState<any>(null);
  const [userBets, setUserBets] = useState<any[]>([]);
  const [stakes, setStakes] = useState<Record<string,string>>({});
  const [odds, setOdds] = useState<Record<string,string>>({});
  const [marketsRequested, setMarketsRequested] = useState<string[]>([]);
  const [oddsMsg, setOddsMsg] = useState('');
  const [oddsTone, setOddsTone] = useState<'info'|'success'|'warning'|'danger'>('info');
  const [analysisCacheKey, setAnalysisCacheKey] = useState<string | null>(null);
  const [autoSyncMsg, setAutoSyncMsg] = useState<string>('');
  const rightRef = useRef<HTMLDivElement>(null);
  const analyzeReqRef = useRef(0);
  const analysisCacheRef = useRef<Map<string, {
    pred: any;
    odds: Record<string, string>;
    marketsRequested: string[];
    oddsMsg: string;
    oddsTone: 'info'|'success'|'warning'|'danger';
    cachedAt: number;
  }>>(new Map());

  const loadUserContext = async () => {
    try {
      const [budgetRes, betsRes] = await Promise.all([
        getBudget(activeUser),
        getBets(activeUser),
      ]);
      setBudget(budgetRes.data ?? null);
      setUserBets(betsRes.data ?? []);
    } catch {
      setBudget(null);
      setUserBets([]);
    }
  };

  useEffect(() => {
    getTeams().then(r => setTeams(r.data ?? []));
    loadUserContext();
  }, [activeUser]);

  const loadUpcoming = async () => {
    setUpcomingLoading(true);
    try {
      const res = await getUpcomingMatches({ competition: competition || undefined, season: season || undefined, limit:160 });
      setUpcoming(res.data ?? []);
    } catch { setUpcoming([]); }
    setUpcomingLoading(false);
  };
  const loadRecent = async () => {
    setUpcomingLoading(true);
    try {
      const res = await getRecentMatches({ competition: competition || undefined, season: season || undefined, limit:160 });
      setRecentMatches(res.data ?? []);
    } catch { setRecentMatches([]); }
    setUpcomingLoading(false);
  };
  const loadMatchdays = async () => {
    if (!season?.trim()) { setMatchdayMap({}); return; }
    try {
      const res = await getMatchdayMap({ competition: 'Serie A', season: season.trim(), matchesPerMatchday: 10 });
      setMatchdayMap(res.data ?? {});
    } catch { setMatchdayMap({}); }
  };

  useEffect(() => {
    if (matchMode === 'recent') loadRecent();
    else loadUpcoming();
  }, [competition, season, matchMode]);
  useEffect(() => { loadMatchdays(); }, [season]);
  useEffect(() => {
    setPred(null);
    setActiveMatchId(null);
    setAnalysisCacheKey(null);
    setOdds({});
    setOddsMsg('');
    setMarketsRequested([]);
    setStakes({});
  }, [matchMode]);
  useEffect(() => {
    const onSyncDone = () => {
      setAutoSyncMsg('Dati aggiornati. Lista partite e modelli ricaricati.');
      analysisCacheRef.current.clear();
      void loadUpcoming();
      void loadMatchdays();
      void loadUserContext();
    };
    const onSyncError = () => {
      setAutoSyncMsg('Aggiornamento automatico non completato. Uso ultimi dati disponibili.');
    };
    window.addEventListener('data-sync-complete', onSyncDone);
    window.addEventListener('data-sync-error', onSyncError);
    return () => {
      window.removeEventListener('data-sync-complete', onSyncDone);
      window.removeEventListener('data-sync-error', onSyncError);
    };
  }, [competition, season, activeUser]);

  const comps = useMemo(() => Array.from(new Set(['Serie A', ...teams.map((t:any) => t.competition).filter(Boolean)])), [teams]);

  const visibleMatches = useMemo(() => matchMode === 'recent' ? recentMatches : upcoming, [matchMode, recentMatches, upcoming]);
  const grouped = useMemo(() => {
    const g = new Map<string,any[]>();
    for (const m of visibleMatches) {
      const k = dateToDayKey(m.date);
      const b = g.get(k) ?? []; b.push(m); g.set(k, b);
    }
    return Array.from(g.entries())
      .sort(([a],[b]) => {
        if (a === 'unknown') return 1;
        if (b === 'unknown') return -1;
        return matchMode === 'recent' ? b.localeCompare(a) : a.localeCompare(b);
      })
      .map(([k,ms]) => ({
        key:k,
        label:formatDayLabel(k),
        matches:[...ms].sort((a:any,b:any) =>
          matchMode === 'recent'
            ? new Date(b.date).getTime()-new Date(a.date).getTime()
            : new Date(a.date).getTime()-new Date(b.date).getTime()
        )
      }));
  }, [visibleMatches, matchMode]);
  const activeMatchRow = useMemo(
    () => visibleMatches.find((m: any) => String(m.match_id ?? '') === String(activeMatchId ?? '')),
    [visibleMatches, activeMatchId]
  );

  const parseOdds = () => {
    const out: Record<string,number> = {};
    Object.entries(odds).forEach(([k,v]) => { const n=parseFloat(v); if (!Number.isNaN(n) && n>1) out[k]=n; });
    return out;
  };

  const applyOdds = (incoming: Record<string,number>) => {
    const s: Record<string,string> = {};
    for (const [k,v] of Object.entries(incoming)) { if (Number.isFinite(v) && v>1) s[k]=v.toFixed(2); }
    setOdds(s);
  };

  const resolveTeam = (id:string, name?:string) => {
    if (name?.trim()) return name.trim();
    return teams.find((t:any) => t.team_id===id)?.name ?? id;
  };

  const handleAnalyze = async (match: any) => {
    const homeId = String(match.home_team_id ?? '');
    const awayId = String(match.away_team_id ?? '');
    const comp = String(match.competition ?? competition);
    const mid = String(match.match_id ?? '');
    const isPlayedMatch = matchMode === 'recent' || (match.home_goals !== null && match.away_goals !== null);
    if (!homeId || !awayId) return;
    const resolvedMatchId = mid || `match_${homeId}_${awayId}_${dateToDayKey(String(match.date ?? ''))}`;
    const cacheKey = `${matchMode}|${resolvedMatchId}|${homeId}|${awayId}|${comp}`;
    const cached = analysisCacheRef.current.get(cacheKey);
    const now = Date.now();
    if (cached && now - cached.cachedAt < 120000) {
      setAnalysisCacheKey(cacheKey);
      setActiveMatchId(resolvedMatchId);
      setPred(cached.pred);
      setOdds(cached.odds);
      setMarketsRequested(cached.marketsRequested);
      setOddsMsg(cached.oddsMsg);
      setOddsTone(cached.oddsTone);
      const st: Record<string, string> = {};
      for (const o of cached.pred?.valueOpportunities ?? []) {
        if (budget?.available_budget) {
          const k = buildBetKey(String(cached.pred?.matchId ?? resolvedMatchId), String(o.selection), String(o.marketName));
          st[k] = ((o.suggestedStakePercent / 100) * budget.available_budget).toFixed(2);
        }
      }
      setStakes(st);
      setTab(isPlayedMatch ? 'strategy' : 'odds');
      return;
    }

    const reqId = ++analyzeReqRef.current;
    setAnalysisCacheKey(cacheKey);
    setActiveMatchId(resolvedMatchId);
    setLoadingMatchId(mid || resolvedMatchId);
    setOddsMsg(''); setOdds({});
    setMarketsRequested([]);
    if (comp && comp !== competition) setCompetition(comp);
    setTab('1x2');
    rightRef.current?.scrollTo({ top: 0, behavior: 'smooth' });

    try {
      if (isPlayedMatch) {
        setOddsMsg('Ricalcolo consiglio sulla partita gia giocata...'); setOddsTone('info');
        setLoading(true);
        const replayRes = await replayPlayedMatchPrediction(mid);
        if (reqId !== analyzeReqRef.current) return;
        const replayData = replayRes.data ?? null;
        if (!replayData) throw new Error('Replay non disponibile.');

        const replayOdds = replayData.replayOddsUsed ?? replayData.replayEstimatedOdds ?? {};
        const requestedMarkets = Array.isArray(replayData.marketsRequested) ? replayData.marketsRequested : ['model_estimated_replay'];
        const appliedOdds = Object.entries(replayOdds).reduce((acc, [k, v]) => {
          const n = Number(v);
          if (Number.isFinite(n) && n > 1) acc[k] = n.toFixed(2);
          return acc;
        }, {} as Record<string, string>);

        const replayPred = {
          ...replayData,
          oddsSource: replayData.oddsReplaySource ?? 'historical_bookmaker_snapshot',
        };
        setPred(replayPred);
        applyOdds(replayOdds);
        setMarketsRequested(requestedMarkets);
        setOddsMsg(replayData.analysisDisclaimer ?? 'Replay statistico su partita gia giocata.');
        setOddsTone('warning');
        setTab('strategy');

        const st: Record<string,string> = {};
        for (const o of replayPred?.valueOpportunities ?? []) {
          if (budget?.available_budget) {
            const k = buildBetKey(String(replayPred?.matchId ?? resolvedMatchId), String(o.selection), String(o.marketName));
            st[k] = ((o.suggestedStakePercent / 100) * budget.available_budget).toFixed(2);
          }
        }
        setStakes(st);

        analysisCacheRef.current.set(cacheKey, {
          pred: replayPred,
          odds: appliedOdds,
          marketsRequested: requestedMarkets,
          oddsMsg: replayData.analysisDisclaimer ?? 'Replay statistico su partita gia giocata.',
          oddsTone: 'warning',
          cachedAt: Date.now(),
        });

        setLoading(false);
        setLoadingMatchId(null);
        return;
      }

      setOddsMsg('Recupero quote live...'); setOddsTone('info');
      const homeName = resolveTeam(homeId, match.home_team_name);
      const awayName = resolveTeam(awayId, match.away_team_name);
      setLoading(true);

      // Fase 1: prediction base + recupero quote in parallelo per mostrare la schermata piu velocemente
      const basePredPromise = axios.post('/api/predict', {
        homeTeamId: homeId, awayTeamId: awayId,
        matchId: resolvedMatchId,
        competition: comp || undefined
      });
      const oddsPromise = getEurobetOddsForMatch({
        matchId: resolvedMatchId,
        competition: comp || 'Serie A',
        homeTeam: homeName,
        awayTeam: awayName,
        commenceTime: String(match.date ?? '')
      }).catch(() => null);

      const baseRes = await basePredPromise;
      if (reqId !== analyzeReqRef.current) return;
      if (baseRes.data?.data) {
        setPred(sanitizePredictionForEurobetOnly(baseRes.data.data));
        setLoading(false);
        setLoadingMatchId(null);
      }

      const oddsRes = await oddsPromise;
      if (reqId !== analyzeReqRef.current) return;
      const payload = (oddsRes as any)?.data ?? {};
      const requestedMarkets = Array.isArray(payload.marketsRequested) ? payload.marketsRequested : [];
      setMarketsRequested(requestedMarkets);

      let finalPred = baseRes.data?.data ?? null;
      let finalOddsMsg = '';
      let finalOddsTone: 'info'|'success'|'warning'|'danger' = 'info';
      let appliedOdds: Record<string, string> = {};

      const eurobetAutoOdds: Record<string, number> = payload?.found && payload?.selectedOdds
        ? (payload.selectedOdds as Record<string, number>)
        : {};
      const providerFallbackAutoOdds: Record<string, number> = payload?.fallbackOdds
        ? (payload.fallbackOdds as Record<string, number>)
        : {};

      if (Object.keys(eurobetAutoOdds).length > 0) {
        applyOdds(eurobetAutoOdds);
        appliedOdds = Object.entries(eurobetAutoOdds).reduce((acc, [k, v]) => {
          const n = Number(v);
          if (Number.isFinite(n) && n > 1) acc[k] = n.toFixed(2);
          return acc;
        }, {} as Record<string, string>);

        finalOddsMsg = payload.message ?? 'Quote reali Eurobet caricate.';
        finalOddsTone = 'success';

        // Fase 2: aggiorna value bet con quote live
        const enrichedRes = await axios.post('/api/predict', {
          homeTeamId: homeId,
          awayTeamId: awayId,
          matchId: resolvedMatchId,
          competition: comp || undefined,
          bookmakerOdds: eurobetAutoOdds
        });
        if (reqId !== analyzeReqRef.current) return;
        if (enrichedRes.data?.data) {
          finalPred = sanitizePredictionForEurobetOnly(enrichedRes.data.data, payload.source ?? 'eurobet_scraper');
          setPred(finalPred);
          setTab('odds');
        }
      } else if (Object.keys(providerFallbackAutoOdds).length > 0) {
        applyOdds(providerFallbackAutoOdds);
        appliedOdds = Object.entries(providerFallbackAutoOdds).reduce((acc, [k, v]) => {
          const n = Number(v);
          if (Number.isFinite(n) && n > 1) acc[k] = n.toFixed(2);
          return acc;
        }, {} as Record<string, string>);

        finalOddsMsg = 'Quote Eurobet non disponibili: mostro quote provider secondario per analisi.';
        finalOddsTone = 'warning';

        const enrichedRes = await axios.post('/api/predict', {
          homeTeamId: homeId,
          awayTeamId: awayId,
          matchId: resolvedMatchId,
          competition: comp || undefined,
          bookmakerOdds: providerFallbackAutoOdds
        });
        if (reqId !== analyzeReqRef.current) return;
        if (enrichedRes.data?.data) {
          finalPred = sanitizePredictionForEurobetOnly(enrichedRes.data.data, 'fallback_provider');
          setPred(finalPred);
          setTab('odds');
        }
      } else {
        finalOddsMsg = payload.message ?? 'Quote Eurobet non disponibili per questa partita.';
        finalOddsTone = 'warning';
        finalPred = sanitizePredictionForEurobetOnly(finalPred, payload.source ?? 'eurobet_unavailable');
      }

      if (finalPred) {
        finalPred = sanitizePredictionForEurobetOnly(finalPred, payload.source ?? finalPred.oddsSource ?? null);
        setPred(finalPred);
      }

      setOddsMsg(finalOddsMsg);
      setOddsTone(finalOddsTone);

      const st: Record<string,string> = {};
      for (const o of finalPred?.valueOpportunities ?? []) {
        if (budget?.available_budget) {
          const k = buildBetKey(String(finalPred?.matchId ?? resolvedMatchId), String(o.selection), String(o.marketName));
          st[k] = ((o.suggestedStakePercent / 100) * budget.available_budget).toFixed(2);
        }
      }
      setStakes(st);

      analysisCacheRef.current.set(cacheKey, {
        pred: finalPred,
        odds: appliedOdds,
        marketsRequested: requestedMarkets,
        oddsMsg: finalOddsMsg,
        oddsTone: finalOddsTone,
        cachedAt: Date.now(),
      });
    } catch (e:any) {
      if (reqId !== analyzeReqRef.current) return;
      setOddsMsg(e.response?.data?.error ?? e.message); setOddsTone('danger');
    }
    setLoading(false);
    if (reqId === analyzeReqRef.current) setLoadingMatchId(null);
  };

  const handleBet = async (opp: any) => {
    if (pred?.analysisMode === 'played_match_replay') {
      return alert('Partita gia giocata: questa schermata e solo una verifica retrospettiva.');
    }
    if (!budget) return alert('Inizializza il bankroll nella sezione Budget.');
    const oppKey = buildBetKey(String(pred?.matchId ?? activeMatchId ?? ''), String(opp.selection), String(opp.marketName));
    const manualStake = parseFloat(stakes[oppKey] ?? '0');
    const suggestedStake = bankroll > 0 ? (Number(opp.suggestedStakePercent ?? 0) / 100) * bankroll : 0;
    const fallbackStake = Math.max(1, Number(suggestedStake.toFixed(2)));
    const stake = manualStake > 0 ? manualStake : fallbackStake;
    if (manualStake <= 0 && stake > 0) {
      if (!window.confirm(`Nessuna puntata inserita. Usa stake suggerito EUR ${stake.toFixed(2)}?`)) return;
      setStakes((p) => ({ ...p, [oppKey]: stake.toFixed(2) }));
    }
    if (stake < 1) return alert('Puntata minima Eurobet: 1 EUR');
    try {
      await placeBet({
        userId: activeUser,
        matchId: String(pred.matchId),
        marketName: String(opp.marketName),
        selection: String(opp.selection),
        odds: Number(opp.bookmakerOdds),
        stake,
        ourProbability: Number(opp.ourProbability) / 100,
        expectedValue: Number(opp.expectedValue) / 100,
        homeTeamName: String(pred.homeTeam ?? ''),
        awayTeamName: String(pred.awayTeam ?? ''),
        competition: String(pred.competition ?? competition ?? ''),
        matchDate: String(activeMatchRow?.date ?? ''),
      });
      await loadUserContext();
    } catch (e:any) { alert(e?.response?.data?.error ?? e?.message ?? 'Errore.'); }
  };

  const gp = pred?.goalProbabilities;
  const cp = pred?.cardsPrediction;
  const fp = pred?.foulsPrediction;
  const sp = pred?.shotsPrediction;
  const pp: any[] = pred?.playerShotsPredictions ?? [];
  const vb: any[] = pred?.valueOpportunities ?? [];
  const bestValueOpp = pred?.bestValueOpportunity ?? null;
  const analysisFactors = pred?.analysisFactors ?? pred?.methodology?.contextualFactors ?? null;
  const methodology = pred?.methodology ?? {};
  const vbRanked = useMemo<BestValueOpportunityModel[]>(
    () => [...vb].sort((a, b) => rankOpportunity(b) - rankOpportunity(a)),
    [vb]
  );
  const allOddsEntries = useMemo(
    () => Object.entries(odds)
      .map(([selection, odd]) => ({ selection, odd: Number(odd) }))
      .filter((o) => Number.isFinite(o.odd) && o.odd > 1)
      .sort((a, b) => fmtSelection(a.selection).localeCompare(fmtSelection(b.selection), 'it')),
    [odds]
  );
  const valueSelectionSet = useMemo(
    () => new Set((vb ?? []).map((o: any) => String(o.selection))),
    [vb]
  );
  const currentMatchId = String(pred?.matchId ?? activeMatchId ?? '');
  const isReplayAnalysis = pred?.analysisMode === 'played_match_replay';
  const actualMatch = pred?.actualMatch ?? null;
  const recommendedBetResult = pred?.recommendedBetResult ?? null;
  const oddsReliabilityBadge = buildOddsReliabilityBadge(pred, isReplayAnalysis);
  const oddsSourceWarning =
    isReplayAnalysis
      ? (pred?.oddsReplaySource === 'historical_bookmaker_snapshot'
          ? 'Replay costruito su snapshot bookmaker storico.'
          : 'Replay costruito su quote modello: utile per analisi, non come riferimento operativo.')
      : pred?.usedSyntheticOdds
        ? 'Quote stimate dal modello: trattale come supporto analitico, non come prezzo bookmaker verificato.'
        : pred?.oddsSource === 'fallback_provider'
          ? 'Provider secondario attivo: confronta la giocata con Eurobet prima di eseguirla.'
          : pred?.oddsSource === 'eurobet_unavailable'
            ? 'Eurobet non ha esposto quote operative per questo match.'
            : null;
  const replayOutcomeTone =
    recommendedBetResult?.status === 'WON'
      ? 'success'
      : recommendedBetResult?.status === 'LOST'
        ? 'danger'
        : recommendedBetResult?.status === 'VOID'
          ? 'warning'
          : 'info';
  const replayOutcomeLabel =
    recommendedBetResult?.status === 'WON'
      ? 'Pronostico verificato: esito vincente'
      : recommendedBetResult?.status === 'LOST'
        ? 'Pronostico verificato: esito perdente'
        : recommendedBetResult?.status === 'VOID'
          ? 'Pronostico verificato: esito void'
          : '';
  const leftPanelTitle = matchMode === 'recent' ? 'Partite recenti giocate' : 'Partite in programma';
  const placedBetKeySet = useMemo(
    () =>
      new Set(
        (userBets ?? []).map((b: any) =>
          buildBetKey(String(b.match_id ?? ''), String(b.selection ?? ''), String(b.market_name ?? ''))
        )
      ),
    [userBets]
  );
  const oppStakeKey = (o: any) => buildBetKey(currentMatchId, String(o.selection ?? ''), String(o.marketName ?? ''));
  const oppStakeValue = (o: any) => Number(stakes[oppStakeKey(o)] ?? 0);
  const bankroll = Number(budget?.available_budget ?? 0);
  const maxExposurePct = 8;
  const maxExposureAmount = bankroll > 0 ? (bankroll * maxExposurePct) / 100 : 0;
  const finalRecommendedChoice = useMemo(() => {
    if (!bestValueOpp) return null;
    const match =
      vbRanked.find((o: any) =>
        String(o.selection ?? '') === String(bestValueOpp.selection ?? '') &&
        String(o.marketName ?? '') === String(bestValueOpp.marketName ?? '')
      ) ?? null;
    if (!match) return null;
    const suggestedStakeAmount = bankroll > 0 ? (Number(match.suggestedStakePercent ?? 0) / 100) * bankroll : 0;
    return {
      ...match,
      suggestedStakeAmount,
    };
  }, [bestValueOpp, bankroll, vbRanked]);
  const suggestedTotalStake = Number(finalRecommendedChoice?.suggestedStakeAmount ?? 0);
  const exposureRatio = maxExposureAmount > 0 ? Math.min(1, suggestedTotalStake / maxExposureAmount) : 0;
  const handleRefresh = () => {
    if (!analysisCacheKey || !activeMatchRow) return;
    analysisCacheRef.current.delete(analysisCacheKey);
    handleAnalyze(activeMatchRow);
  };

  const TABS = [
    {id:'1x2',  label:'1X2 & Goal'},
    {id:'handicap', label:'Handicap'},
    {id:'odds', label:'Quote Complete', count:allOddsEntries.length},
    {id:'scores', label:'Risultati'},
    {id:'cards', label:'Cartellini'},
    {id:'fouls', label:'Falli'},
    {id:'shots', label:'Tiri'},
    {id:'players', label:'Giocatori', count:pp.length},
    {id:'strategy',label:'Pronostico Finale'},
    {id:'method', label:'Algoritmo'},
    {id:'value',   label:'Scommesse',  count:vb.length},
  ];

  return (
    <>
      <style>{S}</style>
      <div className="pr">

        {/*  LEFT PANEL  */}
        <div className="pr-left">
          <div className="pr-left-head">
            <div className="pr-left-title">{leftPanelTitle}</div>

            <div style={{display:'flex',gap:6,marginBottom:10}}>
              <button className={`pr-tab${matchMode==='upcoming' ? ' active' : ''}`} onClick={() => setMatchMode('upcoming')}>
                In Programma
              </button>
              <button className={`pr-tab${matchMode==='recent' ? ' active' : ''}`} onClick={() => setMatchMode('recent')}>
                Recenti Giocate
              </button>
            </div>
            {autoSyncMsg && (
              <div style={{ marginBottom: 10, fontSize: 11, color: 'var(--text-2)', fontFamily: 'DM Mono, monospace' }}>
                {autoSyncMsg}
              </div>
            )}

            {/* Filters */}
            <div className="pr-season-row">
              <div style={{display:'flex',flexDirection:'column',gap:4}}>
                <label className="fp-label">Campionato</label>
                <select className="pr-select-sm" value={competition} onChange={e => setCompetition(e.target.value)}>
                  <option value="">Tutti</option>
                  {comps.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div style={{display:'flex',flexDirection:'column',gap:4}}>
                <label className="fp-label">Stagione</label>
                <input className="pr-input-sm" value={season} onChange={e => setSeason(e.target.value)} placeholder={currentSeason()} />
              </div>
            </div>

          </div>

          {/* Match list */}
          <div className="pr-list">
            {upcomingLoading ? (
              <div style={{display:'flex',alignItems:'center',justifyContent:'center',height:120,gap:10}}>
                <div className="pr-spin" /><span style={{fontSize:12,color:'var(--text-2)'}}>Caricamento...</span>
              </div>
            ) : grouped.length === 0 ? (
              <div style={{textAlign:'center',padding:'32px 16px',color:'var(--text-3)',fontSize:12}}>
                Nessuna partita trovata.
              </div>
            ) : grouped.map(({key, label, matches}) => (
              <div key={key}>
                <div className="pr-day-sep">{label}</div>
                {matches.map((m:any) => {
                  const mid = String(m.match_id ?? '');
                  const isLoading = loadingMatchId === mid;
                  const isActive  = activeMatchId === mid;
                  const isPlayedRow = matchMode === 'recent' || (m.home_goals !== null && m.away_goals !== null);
                  const scoreLabel = isPlayedRow && m.home_goals !== null && m.away_goals !== null
                    ? `${m.home_goals}-${m.away_goals}`
                    : null;
                  const hasMD = isSerieA(m.competition ?? competition);
                  const md = matchdayMap[mid];
                  const matchVB = isActive && vb.length > 0;
                  return (
                    <div
                      key={mid}
                      className={`pr-match-row${isActive?' active':''}${isLoading?' loading-row':''}`}
                      onClick={() => !isLoading && handleAnalyze(m)}
                    >
                      <div className="pr-match-time">{formatKickoff(m.date).split(',')[1]?.trim() ?? '--'}</div>
                      <div className="pr-match-teams">
                        <div className="pr-match-home">{m.home_team_name ?? m.home_team_id}</div>
                        <div className="pr-match-away">{m.away_team_name ?? m.away_team_id}</div>
                        {hasMD && <div className="pr-match-md">{md ? `G${md}` : ''}</div>}
                      </div>
                      {isLoading
                        ? <div className="pr-match-spinner"><div className="pr-spin" /></div>
                        : scoreLabel
                          ? <span className="pr-match-vb">{scoreLabel}</span>
                          : matchVB
                          ? <span className="pr-match-vb">{vb.length} VB</span>
                          : <span className="pr-match-comp" style={{position:'absolute',right:12,top:'50%',transform:'translateY(-50%)'}}>
                              {String(m.competition ?? '').replace('Serie A','SA').replace('Premier League','EPL').replace('La Liga','LAL').replace('Bundesliga','BUN').replace('Ligue 1','L1').slice(0,6)}
                            </span>
                      }
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {/*  RIGHT PANEL  */}
        <div className="pr-right" ref={rightRef}>
          {!pred && !loading ? (
            <div className="pr-empty-state">
              <div className="pr-empty-icon">?</div>
              <div style={{fontSize:16,fontWeight:800,marginBottom:10}}>Seleziona una partita</div>
              <div className="pr-empty-msg">
                {matchMode === 'recent'
                  ? 'Apri una partita gia giocata per verificare il pronostico finale consigliato.'
                  : 'Clicca su una partita nel pannello di sinistra per analizzarla.'}<br />
                {matchMode === 'recent'
                  ? 'Il replay usa prima lo snapshot storico del bookmaker; se manca, passa alle quote stimate dal modello.'
                  : 'Le quote vengono caricate automaticamente.'}
              </div>
            </div>
          ) : loading && !pred ? (
            <div className="pr-empty-state">
              <div className="pr-spin" style={{width:36,height:36,borderWidth:3}} />
              <div style={{marginTop:16,fontSize:13,color:'var(--text-2)'}}>Analisi in corso...</div>
              {oddsMsg && <div className={`pr-odds-status ${oddsTone}`} style={{marginTop:12}}>{oddsMsg}</div>}
            </div>
          ) : pred && (
            <>
              {/* Sticky header */}
              <div className="pr-results-head">
                <div>
                  <div className="pr-results-match">{pred.homeTeam} vs {pred.awayTeam}</div>
                  <div className="pr-results-meta">
                    {pred.competition} | lambda {pred.lambdaHome} - {pred.lambdaAway}
                    {actualMatch?.actualScore ? ` | finale ${actualMatch.actualScore}` : ''}
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  {oddsMsg && <span className={`pr-odds-status ${oddsTone}`}>{oddsMsg}</span>}
                  <button className="fp-btn fp-btn-ghost fp-btn-sm" onClick={handleRefresh} disabled={!activeMatchRow || loading}>
                    Aggiorna
                  </button>
                </div>
              </div>

              <PredictionHero
                homeTeam={pred.homeTeam}
                awayTeam={pred.awayTeam}
                lambdaHome={pred.lambdaHome}
                lambdaAway={pred.lambdaAway}
                modelConfidence={pred.modelConfidence}
                actualScore={actualMatch?.actualScore}
                goalProbabilities={gp ?? null}
                replaySummary={
                  isReplayAnalysis
                    ? {
                        tone: replayOutcomeTone,
                        text: `Replay retrospettivo. ${actualMatch?.actualScore ? `Risultato reale ${actualMatch.actualScore}. ` : ''}${
                          replayOutcomeLabel && recommendedBetResult
                            ? `${replayOutcomeLabel} sulla selezione ${recommendedBetResult.selectionLabel ?? fmtSelection(recommendedBetResult.selection)}.`
                            : 'Serve per verificare il consiglio finale su una partita gia conclusa.'
                        }`,
                      }
                    : null
                }
              />

              {/* Value bet banner */}
              {bestValueOpp && (
                <div style={{margin:'0 20px 12px'}}>
                  <div
                    className={`pr-alert ${isReplayAnalysis ? `pr-alert-${replayOutcomeTone}` : 'pr-alert-success'}`}
                    style={{cursor:'pointer'}}
                    onClick={() => setTab('strategy')}
                  >
                    Pronostico finale consigliato: <strong>{bestValueOpp.selectionLabel ?? fmtSelection(bestValueOpp.selection)}</strong> a quota <strong>{Number(bestValueOpp.bookmakerOdds ?? 0).toFixed(2)}</strong>
                    {recommendedBetResult?.status ? ` | esito ${recommendedBetResult.status}` : ''}
                    <div style={{display:'flex',gap:6,flexWrap:'wrap',marginTop:8}}>
                      <span className={`pr-badge ${marketTierBadgeClass(bestValueOpp.marketTier)}`}>{marketTierLabel(bestValueOpp.marketTier)}</span>
                      <OddsSourceBadge badge={oddsReliabilityBadge} />
                    </div>
                  </div>
                </div>
              )}

              {/* Tabs */}
              <div className="pr-tabs">
                {TABS.map(t => (
                  <button key={t.id} className={`pr-tab${tab===t.id?' active':''}`} onClick={() => setTab(t.id)}>
                    {t.label}
                    {t.count !== undefined && t.count > 0 && <span className="pr-tab-pill">{t.count}</span>}
                  </button>
                ))}
              </div>

              <div className="pr-content">

                {/* 1X2 & GOAL */}
                {tab==='1x2' && gp && (
                  <div className="pr-g2">
                    <div className="pr-card">
                      <div className="pr-card-head"><div className="pr-card-title">1X2 & Double Chance</div></div>
                      <div className="pr-card-body">
                        <ProbBar label={pred.homeTeam} value={gp.homeWin} color="var(--blue)" />
                        <ProbBar label="Pareggio" value={gp.draw} color="var(--text-2)" />
                        <ProbBar label={pred.awayTeam} value={gp.awayWin} color="var(--red)" />
                        <div style={{borderTop:'1px solid var(--border)',marginTop:12,paddingTop:12}}>
                          <ProbBar label="1X (1 o X)" value={gp.homeWin+gp.draw} color="var(--blue)" />
                          <ProbBar label="X2 (X o 2)" value={gp.draw+gp.awayWin} color="var(--red)" />
                        </div>
                      </div>
                    </div>
                    <div className="pr-card">
                      <div className="pr-card-head"><div className="pr-card-title">Goal / Over-Under</div></div>
                      <div className="pr-card-body">
                        <ProbBar label="Goal/Goal" value={gp.btts} color="var(--green)" />
                        <ProbBar label="No GG" value={gp.bttsNo ?? (1-gp.btts)} color="var(--text-3)" />
                        <div style={{borderTop:'1px solid var(--border)',margin:'10px 0'}} />
                        {[['Over 0.5',gp.over05,'var(--blue)'],['Over 1.5',gp.over15,'var(--blue)'],['Over 2.5',gp.over25,'var(--blue)'],['Over 3.5',gp.over35,'var(--gold)'],['Over 4.5',gp.over45,'var(--red)']].map(([l,v,c]) => (
                          <ProbBar key={String(l)} label={String(l)} value={Number(v)} color={String(c)} />
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {/* HANDICAP */}
                {tab==='handicap' && gp?.handicap && (
                  <div className="pr-card">
                    <div className="pr-card-head"><div className="pr-card-title">Handicap Europeo</div></div>
                    <div className="pr-card-body">
                      <div className="pr-g2">
                        <div>
                          <div className="pr-sec">{pred.homeTeam}</div>
                          {Object.entries(gp.handicap).filter(([k])=>k.startsWith('home')).map(([k,v]) => (
                            <ProbBar key={k} label={k.replace('home','H ')} value={v as number} color="var(--blue)" />
                          ))}
                        </div>
                        <div>
                          <div className="pr-sec">{pred.awayTeam}</div>
                          {Object.entries(gp.handicap).filter(([k])=>k.startsWith('away')).map(([k,v]) => (
                            <ProbBar key={k} label={k.replace('away','A ')} value={v as number} color="var(--red)" />
                          ))}
                        </div>
                      </div>
                      {gp.asianHandicap && (
                        <>
                          <div className="pr-sec" style={{marginTop:18}}>Asian Handicap (casa)</div>
                          <div className="pr-ah-grid">
                            {Object.entries(gp.asianHandicap).slice(0,12).map(([k,v]) => (
                              <div className="pr-ah-cell" key={k}><span>AH {k}</span><strong>{fmtPct(v as number)}</strong></div>
                            ))}
                          </div>
                        </>
                      )}
                    </div>
                  </div>
                )}

                {/* ALL ODDS */}
                {tab==='odds' && (
                  <div>
                    <div className="pr-card">
                      <div className="pr-card-head">
                        <div className="pr-card-title">Quote disponibili per analisi</div>
                        <span className="pr-badge pr-badge-blue">{allOddsEntries.length} selezioni</span>
                      </div>
                      <div className="pr-card-body">
                        <div style={{display:'flex',gap:6,flexWrap:'wrap',marginBottom:12}}>
                          {(marketsRequested.length > 0 ? marketsRequested : ['n/d']).map((m:string) => (
                            <span key={m} className="pr-badge pr-badge-gray">{fmtMarketKey(m)}</span>
                          ))}
                        </div>
                        {allOddsEntries.length === 0 ? (
                          <div className="pr-info">
                            Nessuna quota disponibile per questa partita.
                          </div>
                        ) : (
                          <div className="pr-odds-grid">
                            {allOddsEntries.map((o) => (
                              <div key={o.selection} className={`pr-odds-cell${valueSelectionSet.has(o.selection) ? ' best' : ''}`}>
                                <span className="pr-odds-name" title={o.selection}>{fmtSelection(o.selection)}</span>
                                <strong className="pr-odds-val">{o.odd.toFixed(2)}</strong>
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* SCORES */}
                {tab==='scores' && gp?.exactScore && (
                  <div className="pr-card">
                    <div className="pr-card-head"><div className="pr-card-title">Risultati Esatti</div></div>
                    <div className="pr-card-body">
                      <div className="pr-score-grid">
                        {Object.entries(gp.exactScore).sort(([,a],[,b])=>(b as number)-(a as number)).slice(0,20).map(([score,prob]) => {
                          const p = (prob as number)*100;
                          return (
                            <div key={score} className={`pr-score-cell${p>10?' hot':p>5?' warm':''}`}>
                              <div className="pr-score-val">{score}</div>
                              <div className="pr-score-pct">{p.toFixed(2)}%</div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  </div>
                )}

                {/* CARDS */}
                {tab==='cards' && cp && (
                  <div>
                    <div className="pr-alert pr-alert-info">
                      <strong>Binomiale Negativa</strong> - Media {fmtN(cp.totalYellow.expected)} | Var {fmtN(cp.totalYellow.variance)}
                      {cp.confidenceLevel < 0.7 && <span style={{marginLeft:8,color:'var(--gold)'}}>ATTENZIONE: confidenza bassa {(cp.confidenceLevel*100).toFixed(0)}%</span>}
                    </div>
                    <div className="pr-g2">
                      <div className="pr-card">
                        <div className="pr-card-head">
                          <div className="pr-card-title">Gialli Totali</div>
                          <div style={{display:'flex',gap:4}}>
                            <span className="pr-badge pr-badge-blue">M {fmtN(cp.totalYellow.expected)}</span>
                            <span className="pr-badge pr-badge-gray">Var {fmtN(cp.totalYellow.variance)}</span>
                          </div>
                        </div>
                        <div className="pr-card-body">
                          <DistChart dist={cp.totalYellow.distribution} expected={cp.totalYellow.expected} title="P(gialli = k)" color="var(--gold)" />
                          {['over15','over25','over35','over45','over55'].map(k => (
                            <ProbBar key={k} label={`Over ${formatCompactOuKey(k)}`} value={(cp.overUnder as any)[k]} color="var(--gold)" />
                          ))}
                        </div>
                      </div>
                      <div className="pr-card">
                        <div className="pr-card-head"><div className="pr-card-title">Per Squadra & Rossi</div></div>
                        <div className="pr-card-body">
                          <div className="pr-sec" style={{color:'var(--blue)'}}>{pred.homeTeam}</div>
                          <ProbBar label="O1.5" value={cp.homeYellow.over15} color="var(--blue)" />
                          <ProbBar label="O2.5" value={cp.homeYellow.over25} color="var(--blue)" />
                          <div className="pr-sec" style={{color:'var(--red)',marginTop:10}}>{pred.awayTeam}</div>
                          <ProbBar label="O1.5" value={cp.awayYellow.over15} color="var(--red)" />
                          <ProbBar label="O2.5" value={cp.awayYellow.over25} color="var(--red)" />
                          <div className="pr-info">
                            <strong>Rossi</strong> - Attesi: {fmtN(cp.totalRed.expected,3)} | P(&gt;=1 rosso): <strong>{(cp.totalRed.probAtLeastOne*100).toFixed(1)}%</strong>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* FOULS */}
                {tab==='fouls' && fp && (
                  <div className="pr-card">
                    <div className="pr-card-head">
                      <div className="pr-card-title">Falli - Binomiale Negativa</div>
                      <div style={{display:'flex',gap:4}}>
                        <span className="pr-badge pr-badge-purple">M {fmtN(fp.totalFouls.expected)}</span>
                        <span className="pr-badge pr-badge-gray">Var {fmtN(fp.totalFouls.variance)}</span>
                      </div>
                    </div>
                    <div className="pr-card-body">
                      <div className="pr-info" style={{marginBottom:14}}>
                        Casa: <strong>{fmtN(fp.homeFouls.expected)}</strong> | Ospite: <strong>{fmtN(fp.awayFouls.expected)}</strong> | Var/media: <strong>{fmtN(fp.totalFouls.variance/fp.totalFouls.expected,2)}x</strong>
                      </div>
                      <DistChart dist={fp.totalFouls.distribution} expected={fp.totalFouls.expected} title="P(falli = k)" color="var(--purple)" />
                      <div className="pr-g2">
                        {Object.entries(fp.overUnder).filter(([k])=>k.startsWith('over')).map(([k,v]) => (
                          <ProbBar key={k} label={`Over ${formatCompactOuKey(k)}`} value={v as number} color="var(--purple)" />
                        ))}
                      </div>
                    </div>
                  </div>
                )}

                {/* SHOTS */}
                {tab==='shots' && sp && <ShotsSection homeTeam={pred.homeTeam} awayTeam={pred.awayTeam} shotsPrediction={sp} />}

                {/* PLAYERS */}
                {tab==='players' && (
                  pp.length === 0 ? (
                    <div className="pr-info" style={{fontSize:12,lineHeight:1.8}}>
                      <strong>Modello ZIP (Zero-Inflated Poisson)</strong><br /><br />
                      Per usare questo modello, carica i profili giocatori da <strong>Gestione Dati -&gt; Dati Automatici</strong>.
                    </div>
                  ) : pp.map((p:any) => (
                    <div className="pr-card" key={p.playerId}>
                      <div className="pr-card-head">
                        <div className="pr-player-head" style={{width:'100%'}}>
                          <div>
                            <div className="pr-player-name">{p.playerName}</div>
                            <div className="pr-player-meta">{p.position} | {p.sampleSize} partite | confidenza {(p.confidenceLevel*100).toFixed(0)}%</div>
                          </div>
                          <div>
                            <div className="pr-player-xg-val">{fmtN(p.expectedShots)}</div>
                            <div className="pr-player-xg-lbl">tiri attesi</div>
                          </div>
                        </div>
                      </div>
                      <div className="pr-card-body">
                        <div className="pr-g2">
                          <DistChart dist={p.shotDistribution} expected={p.expectedShots} title="ZIP" color="var(--blue)" />
                          <div>
                            <ProbBar label=">=1 tiro" value={p.markets.over05shots} color="var(--blue)" />
                            <ProbBar label=">=2 tiri" value={p.markets.over15shots} color="var(--blue)" />
                            <ProbBar label=">=1 in porta" value={p.markets.over05onTarget} color="var(--green)" />
                          </div>
                        </div>
                      </div>
                    </div>
                  ))
                )}

                {/* STRATEGY */}
                {tab==='strategy' && (
                  <div>
                    <div className="pr-card">
                      <div className="pr-card-head">
                        <div className="pr-card-title">Pronostico Finale Consigliato</div>
                      </div>
                      <div className="pr-card-body">
                        <div className="pr-g2">
                          <div>
                            <BestValueCard
                              opportunity={bestValueOpp as BestValueOpportunityModel | null}
                              oddsBadge={oddsReliabilityBadge}
                              oddsWarning={oddsSourceWarning}
                              recommendedBetResult={
                                recommendedBetResult
                                  ? {
                                      ...recommendedBetResult,
                                      reason: `${actualMatch?.actualScore ? `risultato ${actualMatch.actualScore} | ` : ''}${recommendedBetResult.reason ?? ''}`.trim(),
                                    }
                                  : null
                              }
                              replayTone={replayOutcomeTone}
                              showConfidence={false}
                            />
                          </div>
                          <StakePlanner
                            isReplayAnalysis={isReplayAnalysis}
                            actualMatchDate={formatKickoff(actualMatch?.date ?? activeMatchRow?.date)}
                            actualScore={actualMatch?.actualScore ?? '-'}
                            bankroll={bankroll}
                            suggestedTotalStake={suggestedTotalStake}
                            maxExposurePct={maxExposurePct}
                            maxExposureAmount={maxExposureAmount}
                            exposureRatio={exposureRatio}
                          />
                        </div>
                      </div>
                    </div>

                    <div className="pr-card">
                      <div className="pr-card-head">
                        <div className="pr-card-title">Criterio Operativo</div>
                        <button className="fp-btn fp-btn-sm fp-btn-solid" onClick={() => setTab('value')}>Apri tab Scommesse</button>
                      </div>
                      <div className="pr-card-body">
                        <div className="pr-info" style={{ marginBottom: 12 }}>
                          {isReplayAnalysis
                            ? 'Questa e una rilettura retrospettiva: una sola giocata finale viene confrontata con il risultato reale.'
                            : 'Una sola giocata finale consigliata per match. Le altre quote restano disponibili solo come confronto analitico.'}
                        </div>
                        <div className="pr-g2">
                          <div>
                            <div className="pr-sec">Checklist</div>
                            <table className="fp-table">
                              <tbody>
                                {[
                                  ['EV minimo', '> 2%'],
                                  ['Quote accettate', '1.30 - 15.00'],
                                  ['Stake sizing', isReplayAnalysis ? 'non applicato nel replay' : 'Kelly 1/4 con cap 5%'],
                                  ['Numero giocate', isReplayAnalysis ? '1 consiglio finale verificato' : '1-3 per match'],
                                  ['Stop se nessun value', 'Nessuna puntata'],
                                ].map(([k, v]) => (
                                  <tr key={k}>
                                    <td style={{ color:'var(--text-2)' }}>{k}</td>
                                    <td className="fp-mono" style={{ textAlign:'right' }}>{v}</td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <div>
                            <div className="pr-sec">Lettura del Match</div>
                            <div className="pr-info" style={{ marginBottom: 10 }}>
                              {bestValueOpp
                                ? `${bestValueOpp.selectionLabel ?? fmtSelection(bestValueOpp.selection)} e la sola quota proposta come uscita finale.`
                                : 'Se non c e una giocata davvero solida, il sistema non propone un pronostico finale.'}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  </div>
                )}

                {/* METHOD */}
                {tab==='method' && (
                  <MethodologyDrawer
                    methodology={methodology}
                    fallbackLambdaHome={Number(pred?.lambdaHome ?? 0)}
                    fallbackLambdaAway={Number(pred?.lambdaAway ?? 0)}
                    fallbackTotalShotsExpected={Number(sp?.combined?.totalShots?.expected ?? 0)}
                    fallbackTotalYellowExpected={Number(cp?.totalYellow?.expected ?? 0)}
                    fallbackTotalFoulsExpected={Number(fp?.totalFouls?.expected ?? 0)}
                    topOpportunity={vbRanked[0] ?? null}
                    analysisFactors={analysisFactors}
                  />
                )}

                {/* VALUE BETS */}
                {tab==='value' && (
                  <div>
                    {bestValueOpp && (
                      <div className="pr-card">
                        <div className="pr-card-head">
                        <div className="pr-card-title">Pronostico Finale Consigliato</div>
                        <div style={{display:'flex',gap:6,flexWrap:'wrap'}}>
                          {bestValueOpp.confidence && (
                            <span className={`pr-badge ${bestValueOpp.confidence === 'HIGH' ? 'pr-badge-green' : bestValueOpp.confidence === 'MEDIUM' ? 'pr-badge-blue' : 'pr-badge-gold'}`}>
                              {bestValueOpp.confidence}
                            </span>
                          )}
                          <span className={`pr-badge ${marketTierBadgeClass(bestValueOpp.marketTier)}`}>
                            {marketTierLabel(bestValueOpp.marketTier)}
                          </span>
                          <OddsSourceBadge badge={oddsReliabilityBadge} />
                        </div>
                      </div>
                      <div className="pr-card-body">
                        <div className="pr-g2">
                          <BestValueCard
                            opportunity={bestValueOpp as BestValueOpportunityModel}
                            oddsBadge={oddsReliabilityBadge}
                            oddsWarning={oddsSourceWarning}
                            showConfidence={false}
                          />
                            <div className="pr-info">
                              <strong>Indicazione pratica</strong><br />
                              Una sola giocata finale per partita.<br />
                              Le altre quote restano sotto come confronto e non come consiglio principale.
                            </div>
                        </div>
                      </div>
                    </div>
                    )}
                    <div className="pr-card">
                      <div className="pr-card-head">
                        <div className="pr-card-title">Legenda Termini Analisi</div>
                      </div>
                      <div className="pr-card-body">
                        <div className="pr-legend-grid">
                          {VALUE_LEGEND.map((row) => (
                            <div className="pr-legend-row" key={row.term}>
                              <div className="pr-legend-term">{row.term}</div>
                              <div className="pr-legend-meaning">{row.meaning}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                    <ValueOpportunitiesTable
                      opportunities={vbRanked}
                      bankroll={bankroll}
                      budgetReady={Boolean(budget)}
                      isReplayAnalysis={isReplayAnalysis}
                      oddsSource={pred?.oddsSource ?? null}
                      providerWarning={oddsSourceWarning}
                      placedBetKeySet={placedBetKeySet}
                      recommendedBetResult={recommendedBetResult}
                      replayOutcomeTone={replayOutcomeTone}
                      stakes={stakes}
                      getStakeKey={(o) => oppStakeKey(o)}
                      getStakeValue={(o) => oppStakeValue(o)}
                      onStakeChange={(stakeKey, value) => setStakes((previous) => ({ ...previous, [stakeKey]: value }))}
                      onBet={(opportunity) => handleBet(opportunity)}
                    />
                  </div>
                )}

              </div>
            </>
          )}
        </div>

      </div>
    </>
  );
};

export default Predictions;

