import React, { useRef } from 'react';
import { ArrowLeft, ChevronRight } from 'lucide-react';
import PredictionHero from './PredictionHero';
import BestValueCard from './BestValueCard';
import StakePlanner from './StakePlanner';
import MethodologyDrawer from './MethodologyDrawer';
import ShotsSection from './ShotsSection';
import PlayerPropsSection from './PlayerPropsSection';
import LineupPanel from './LineupPanel';
import ValueOpportunitiesTable from './ValueOpportunitiesTable';
import { DistChart, ProbBar } from './PredictionStatPrimitives';
import { formatCompactOuKey, fmtN, fmtPct, fmtSelection } from './predictionFormatting';
import { BestValueOpportunity as BestValueOpportunityModel } from './predictionTypes';
import { currentSeason, formatKickoff, isSerieA, formatMarketKey as fmtMarketKey, VALUE_LEGEND } from './predictionWorkbenchUtils';
import type { PredictionWorkbenchViewModel } from '../../hooks/usePredictionWorkbench';
import GlossaryTerm from '../../features/glossary/GlossaryTerm';

interface PredictionWorkbenchViewProps {
  vm: PredictionWorkbenchViewModel;
}

/*  STYLES  */
const S = `
.pr {
  display:grid;
  grid-template-columns:minmax(280px,340px) minmax(0,1fr);
  grid-template-rows:auto 1fr;
  gap:18px;
  max-width:1440px;
  min-height:calc(100vh - var(--header-height));
  margin:0 auto;
  padding:28px clamp(18px,3vw,40px) 48px;
  font-family:var(--font-sans);
  background:var(--bg);
  color:var(--text);
}
.pr-page-head { grid-column:1/-1; display:flex; align-items:flex-end; justify-content:space-between; gap:18px; }
.pr-page-head h1 { margin:4px 0 0; font-size:clamp(28px,3vw,38px); line-height:1; letter-spacing:-.04em; }
.pr-page-head p { margin:8px 0 0; color:var(--text-2); }
.pr-page-kicker { color:var(--primary); font-size:12px; font-weight:800; }
.pr-page-trust { color:var(--green); border:1px solid var(--green-border); background:var(--green-dim); border-radius:var(--radius); padding:8px 11px; font-size:11px; font-weight:750; }

/* LEFT PANEL  fixed sidebar */
.pr-left {
  min-width:0;
  height:calc(100vh - 180px);
  min-height:620px;
  position:sticky; top:90px;
  border:1px solid var(--border);
  border-radius:var(--radius-lg);
  display:flex; flex-direction:column;
  background:var(--surface); overflow:hidden;
  box-shadow:var(--shadow);
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
.pr-match-time { font-family:var(--font-mono); font-size:10px; color:var(--text-3); width:40px; flex-shrink:0; text-align:center; }
.pr-match-teams { flex:1; min-width:0; }
.pr-match-home, .pr-match-away { font-size:12px; font-weight:700; color:var(--text); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; line-height:1.4; }
.pr-match-away { color:var(--text-2); font-weight:600; }
.pr-match-md { font-family:var(--font-mono); font-size:9px; color:var(--text-3); margin-top:2px; }
.pr-match-comp { font-size:9px; font-weight:700; color:var(--text-3); text-transform:uppercase; letter-spacing:.8px; flex-shrink:0; max-width:60px; text-align:right; }
.pr-match-vb {
  position:absolute; right:12px; top:50%; transform:translateY(-50%);
  background:var(--green-dim); border:1px solid var(--green-border);
  border-radius:10px; padding:1px 7px; font-size:9px; font-weight:700; color:var(--green);
}

/* RIGHT PANEL  scrollable results */
.pr-right { min-width:0; overflow:visible; border:1px solid var(--border); border-radius:var(--radius-lg); background:var(--surface); box-shadow:var(--shadow); }

/* EMPTY STATE */
.pr-empty-state {
  display:flex; flex-direction:column; align-items:center; justify-content:center;
  min-height:620px; color:var(--text-3); text-align:center; padding:40px;
}
.pr-empty-icon { font-size:48px; margin-bottom:16px; }
.pr-empty-msg { font-size:13px; line-height:1.7; }

/* RESULTS HEADER */
.pr-results-head {
  position:sticky; top:var(--header-height); z-index:10;
  background:var(--surface); border-bottom:1px solid var(--border);
  padding:14px 24px; display:flex; align-items:center; justify-content:space-between;
}
.pr-results-match { font-size:15px; font-weight:800; letter-spacing:-.3px; }
.pr-results-meta { font-size:11px; color:var(--text-2); font-family:var(--font-mono); margin-top:2px; }
.pr-odds-status { font-size:11px; padding:4px 10px; border-radius:var(--radius-xs); }
.pr-odds-status.info    { background:var(--blue-dim);  color:var(--blue);  }
.pr-odds-status.success { background:var(--green-dim); color:var(--green); }
.pr-odds-status.warning { background:var(--gold-dim);  color:var(--gold);  }
.pr-odds-status.danger  { background:var(--red-dim);   color:var(--red);   }
.lineup-panel { margin:16px 20px; padding:18px 20px; border:1px solid var(--border); border-radius:var(--radius-xl); background:var(--surface2); }
.lineup-panel__head { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; }
.lineup-panel__eyebrow { color:var(--primary); font-size:10px; font-weight:800; letter-spacing:1.2px; }
.lineup-panel h3 { margin:4px 0 0; font-size:18px; letter-spacing:-.02em; }
.lineup-panel__status { padding:5px 9px; border-radius:999px; background:var(--gold-dim); color:var(--gold); font-size:10px; font-weight:800; }
.lineup-panel__status.is-confirmed { background:var(--green-dim); color:var(--green); }
.lineup-panel__message { margin:10px 0 14px; color:var(--text-2); font-size:11px; }
.lineup-panel__message.is-error { color:var(--red); }
.lineup-panel__grid { display:grid; grid-template-columns:1fr 1fr; gap:14px; }
.lineup-panel__column h4 { margin:0 0 8px; font-size:12px; }
.lineup-panel__list { display:grid; gap:5px; }
.lineup-player { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:8px 10px; border:1px solid var(--border); border-radius:10px; background:var(--surface); }
.lineup-player strong, .lineup-player span { display:block; }
.lineup-player strong { font-size:11px; }
.lineup-player span { margin-top:2px; color:var(--text-3); font-size:9px; }
.lineup-player b { color:var(--primary); font-family:var(--font-mono); font-size:11px; }
.lineup-player--confirmed_bench, .lineup-player--unavailable, .lineup-player--uncertain { opacity:.62; }
.lineup-player--confirmed_starter { border-color:var(--green-border); }
.lineup-panel__empty, .lineup-panel__note { color:var(--text-3); font-size:10px; }
.lineup-panel__note { display:block; margin-top:12px; }
@media (max-width: 700px) { .lineup-panel__grid { grid-template-columns:1fr; } }

/* MATCH HERO COMPACT */
.pr-hero {
  margin:16px 20px; padding:20px 24px;
  background:var(--surface); border:1px solid var(--border);
  border-radius:var(--radius-xl);
  display:grid; grid-template-columns:minmax(0,1fr) minmax(112px,140px) minmax(0,1fr);
  align-items:center; gap:24px;
  position:relative;
}
.pr-hero-team { display:flex; min-width:0; flex-direction:column; gap:6px; }
.pr-hero-team.right { text-align:right; align-items:flex-end; }
.pr-hero-role { color:var(--text-3); font-size:9px; font-weight:800; letter-spacing:1.1px; text-transform:uppercase; }
.pr-hero-name { max-width:100%; font-size:16px; font-weight:800; letter-spacing:-.3px; line-height:1.25; overflow-wrap:anywhere; }
.pr-hero-lambda {
  display:inline-flex; align-items:center; gap:4px;
  background:var(--surface2); border:1px solid var(--border);
  border-radius:var(--radius-xs); padding:3px 8px;
  font-family:var(--font-mono); font-size:11px; color:var(--text-2);
}
.pr-hero-stat {
  display:inline-flex; width:max-content; max-width:100%; align-items:baseline; gap:7px;
  padding:5px 9px; border:1px solid var(--border); border-radius:var(--radius-sm);
  background:var(--surface2); color:var(--text-3); font-size:10px;
}
.pr-hero-stat strong { color:var(--text); font-family:var(--font-mono); font-size:12px; }
.pr-hero-team.right .pr-hero-stat { justify-content:flex-end; }
.pr-hero-center { display:flex; flex-direction:column; align-items:center; text-align:center; }
.pr-hero-vs { font-size:11px; font-weight:800; color:var(--text-3); letter-spacing:3px; margin-bottom:6px; }
.pr-confidence {
  display:flex; width:100%; flex-direction:column; gap:2px;
  background:var(--blue-dim); border:1px solid var(--blue-border);
  border-radius:var(--radius-sm); padding:7px 10px; color:var(--blue);
}
.pr-confidence span { font-size:9px; font-weight:750; letter-spacing:.3px; }
.pr-confidence strong { font-family:var(--font-mono); font-size:14px; }
.pr-hero-final { margin-top:7px; color:var(--text-2); font-family:var(--font-mono); font-size:10px; font-weight:700; }
.pr-data-quality { margin:0 20px 16px; padding:16px 18px; border:1px solid var(--border); border-radius:var(--radius); background:var(--surface2); }
.pr-data-quality-head { display:flex; align-items:flex-start; justify-content:space-between; gap:12px; }
.pr-data-quality-head h3 { margin:2px 0 0; font-size:16px; letter-spacing:-.02em; }
.pr-data-quality-caption { color:var(--text-3); font-size:10px; text-align:right; }
.pr-data-quality-history { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:10px; margin:12px 0; }
.pr-data-history-item { display:grid; grid-template-columns:1fr auto; gap:2px 8px; padding:10px 12px; border:1px solid var(--border); border-radius:var(--radius-sm); background:var(--surface); }
.pr-data-history-item span { color:var(--text-2); font-size:11px; font-weight:700; }
.pr-data-history-item strong { color:var(--blue); font-family:var(--font-mono); font-size:14px; }
.pr-data-history-item small { grid-column:1/-1; color:var(--text-3); font-size:10px; }
.pr-data-quality-market { border-top:1px solid var(--border); padding-top:12px; }
.pr-data-quality-title { margin-bottom:8px; color:var(--text); font-size:11px; font-weight:800; }
.pr-data-quality-components { display:flex; flex-wrap:wrap; gap:6px; }
.pr-data-chip { display:inline-flex; flex-direction:column; gap:2px; padding:6px 9px; border:1px solid var(--border); border-radius:var(--radius-xs); background:var(--surface); }
.pr-data-chip span { font-size:10px; font-weight:750; }
.pr-data-chip small { font-size:9px; color:var(--text-3); }
.pr-data-chip.is-available { border-color:var(--green-border); background:var(--green-dim); }
.pr-data-chip.is-available small { color:var(--green); }
.pr-data-chip.is-missing { border-color:var(--gold-border); background:var(--gold-dim); }
.pr-data-chip.is-missing small { color:var(--gold); }
.pr-data-quality-note { margin:10px 0 0; color:var(--text-2); font-size:11px; line-height:1.5; }
@media (max-width:700px) { .pr-data-quality-head { flex-direction:column; } .pr-data-quality-caption { text-align:left; } }

/* KPI ROW */
.pr-kpi-row { display:grid; grid-template-columns:repeat(3,1fr); gap:10px; margin:0 20px 16px; }
.pr-kpi {
  background:var(--surface2); border:1px solid var(--border);
  border-radius:var(--radius-sm); padding:12px 14px; text-align:center;
}
.pr-kpi-val { font-family:var(--font-mono); font-size:20px; font-weight:700; }
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
  display:inline-flex; background:var(--primary-dim); color:var(--primary);
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
  padding-right:8px; font-size:10px; font-family:var(--font-mono);
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
.pr-score-cell:hover { border-color:var(--border-hover); }
.pr-score-cell.hot { border-color:var(--blue-border); background:var(--blue-dim); }
.pr-score-cell.warm { border-color:var(--border-hover); background:var(--surface3); }
.pr-score-val { font-size:18px; font-weight:800; font-family:var(--font-mono); }
.pr-score-pct { font-size:10px; font-family:var(--font-mono); color:var(--blue); margin-top:2px; }

/* CHART */
.pr-chart-head { display:flex; justify-content:space-between; margin-bottom:6px; font-size:11px; color:var(--text-2); }
.pr-chart-head strong { color:var(--text); font-family:var(--font-mono); }

/* AH GRID */
.pr-ah-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(150px,1fr)); gap:6px; margin-top:10px; }
.pr-ah-cell { display:flex; justify-content:space-between; align-items:center; background:var(--surface2); border:1px solid var(--border); border-radius:7px; padding:7px 12px; font-size:12px; }
.pr-ah-cell strong { font-family:var(--font-mono); }

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
.pr-vb-market-sub { font-size:11px; color:var(--text-2); font-family:var(--font-mono); }
.pr-vb-ev-num { font-family:var(--font-mono); font-size:20px; font-weight:700; color:var(--green); }
.pr-vb-ev-lbl { font-size:9px; color:var(--text-2); letter-spacing:1px; text-align:right; }
.pr-vb-stats { display:grid; grid-template-columns:repeat(5,1fr); border-bottom:1px solid var(--border); }
.pr-vb-stat { padding:10px 14px; border-right:1px solid var(--border); }
.pr-vb-stat:last-child { border-right:none; }
.pr-vb-stat-lbl { font-size:9px; text-transform:uppercase; letter-spacing:1px; color:var(--text-3); font-weight:700; margin-bottom:3px; }
.pr-vb-stat-val { font-family:var(--font-mono); font-size:13px; font-weight:600; }
.pr-vb-bottom {
  display:flex; justify-content:space-between; align-items:center;
  padding:10px 18px; background:var(--surface2); gap:12px;
}
.pr-stake-wrap { display:flex; align-items:center; gap:10px; }
.pr-stake-lbl { font-size:11px; color:var(--text-2); }
.pr-stake-input {
  background:var(--surface); border:1px solid var(--border); border-radius:7px;
  padding:7px 12px; color:var(--text); font-family:var(--font-mono);
  font-size:13px; width:90px; outline:none; transition:border-color var(--transition);
}
.pr-stake-input:focus { border-color:var(--primary); }
.pr-suggest { font-size:10px; color:var(--text-3); font-family:var(--font-mono); display:flex; flex-direction:column; line-height:1.35; }

/* BADGES / ALERTS inline */
.pr-badge {
  display:inline-flex; align-items:center; font-family:var(--font-mono);
  font-size:9px; font-weight:600; padding:2px 8px; border-radius:var(--radius-xs); border:1px solid transparent;
}
.pr-badge-green  { background:var(--green-dim);  color:var(--green);  border-color:var(--green-border); }
.pr-badge-blue   { background:var(--blue-dim);   color:var(--blue);   border-color:var(--blue-border);  }
.pr-badge-gold   { background:var(--gold-dim);   color:var(--gold);   border-color:var(--gold-border);  }
.pr-badge-gray   { background:var(--surface3); color:var(--text-2); border-color:var(--border); }
.pr-badge-purple { background:var(--purple-dim); color:var(--purple); border-color:var(--purple-border); }

.pr-alert { padding:10px 14px; border-radius:var(--radius-sm); font-size:12px; line-height:1.6; margin-bottom:12px; }
.pr-alert-info    { background:var(--blue-dim);  border:1px solid var(--blue-border);  color:var(--blue);  }
.pr-alert-success { background:var(--green-dim); border:1px solid var(--green-border); color:var(--green); }
.pr-alert-warning { background:var(--gold-dim);  border:1px solid var(--gold-border);  color:var(--gold);  }
.pr-alert-danger  { background:var(--red-dim);   border:1px solid var(--red-border);   color:var(--red);   }

/* CARDS */
.pr-card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); overflow:hidden; margin-bottom:14px; }
.pr-card-head { display:flex; align-items:center; justify-content:space-between; padding:14px 18px; border-bottom:1px solid var(--border); }
.pr-card-title { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:1.3px; color:var(--text-2); }
.pr-card-body { padding:18px; }
.pr-odds-groups { display:grid; gap:16px; }
.pr-odds-group { display:grid; gap:8px; }
.pr-odds-group-title { margin:0; font-size:11px; font-weight:800; color:var(--text-2); text-transform:uppercase; letter-spacing:.08em; }
.pr-odds-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(220px,1fr)); gap:8px; }
.pr-odds-cell {
  display:grid; grid-template-columns:minmax(0,1fr) auto; align-items:center;
  background:var(--surface2); border:1px solid var(--border);
  border-radius:9px; padding:8px 10px; gap:10px;
}
.pr-odds-cell.best { border-color:var(--green-border); background:var(--green-dim); }
.pr-odds-name { font-size:12px; color:var(--text-2); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.pr-odds-val { font-family:var(--font-mono); font-size:13px; font-weight:700; color:var(--text); }
.pr-odds-bookmaker { grid-column:1 / -1; color:var(--text-3); font-size:10px; }
.pr-legend-grid { display:grid; grid-template-columns:1fr; gap:6px; }
.pr-legend-row {
  display:grid; grid-template-columns:170px 1fr; gap:10px;
  padding:8px 10px; border:1px solid var(--border); border-radius:8px;
  background:var(--surface2);
}
.pr-legend-term { font-family:var(--font-mono); font-size:11px; color:var(--text); font-weight:700; }
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
.pr-player-xg-val { font-size:22px; font-weight:800; font-family:var(--font-mono); color:var(--blue); text-align:right; }
.pr-player-xg-lbl { font-size:10px; color:var(--text-2); text-align:right; }

/* INFO BOX */
.pr-info { background:var(--surface2); border:1px solid var(--border); border-radius:9px; padding:12px 14px; font-size:12px; color:var(--text-2); line-height:1.65; margin-top:8px; }
.pr-info strong { color:var(--text); }

/* INPUT/SELECT small */
.pr-select-sm, .pr-input-sm {
  background:var(--surface2); border:1px solid var(--border); border-radius:8px;
  padding:8px 12px; color:var(--text); font-family:var(--font-mono); font-size:12px;
  width:100%; outline:none; transition:border-color var(--transition);
}
.pr-select-sm:focus, .pr-input-sm:focus { border-color:var(--blue); }
.pr-select-sm { appearance:none; cursor:pointer; }

.pr-decision-layout { display:grid; grid-template-columns:minmax(0,1.45fr) minmax(260px,.55fr); gap:14px; margin:0 20px 16px; align-items:start; }
.pr-decision-report {
  background:var(--surface); border:1px solid var(--primary-border); border-left:4px solid var(--primary);
  border-radius:var(--radius); overflow:hidden; box-shadow:var(--shadow);
}
.pr-decision-report.is-empty { border-color:var(--border); border-left-color:var(--text-3); padding:18px; }
.pr-decision-report__head { display:flex; justify-content:space-between; align-items:flex-start; gap:16px; padding:18px; }
.pr-decision-report__eyebrow { color:var(--text-3); font-size:10px; font-weight:800; letter-spacing:.1em; text-transform:uppercase; }
.pr-decision-report__title { display:block; margin-top:5px; color:var(--text); font-size:22px; line-height:1.2; }
.pr-decision-report__summary { margin:8px 0 0; color:var(--text-2); }
.pr-decision-report__badges { display:flex; justify-content:flex-end; gap:6px; flex-wrap:wrap; }
.pr-decision-report__metrics { display:grid; grid-template-columns:repeat(4,minmax(0,1fr)); margin:0; border-block:1px solid var(--border); background:var(--surface2); }
.pr-decision-report__metric { padding:12px 14px; border-right:1px solid var(--border); }
.pr-decision-report__metric:last-child { border-right:0; }
.pr-decision-report__metric dt { color:var(--text-3); font-size:9px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; }
.pr-decision-report__metric dd { margin:4px 0 0; color:var(--text); font-family:var(--font-mono); font-size:14px; font-weight:700; }
.pr-decision-report__body { padding:16px 18px 18px; }
.pr-decision-report__market { display:flex; justify-content:space-between; gap:14px; padding-bottom:12px; color:var(--text-2); }
.pr-decision-report__market strong { color:var(--text); }
.pr-decision-report__risks, .pr-decision-report__reasons { margin-top:12px; color:var(--text-2); }
.pr-decision-report__risks ul, .pr-decision-report__reasons ul { margin:7px 0 0 18px; padding:0; }

@media (max-width:900px) {
  .pr { grid-template-columns:1fr; height:auto; padding:22px 16px 96px; }
  .pr-page-head { grid-column:1; align-items:flex-start; flex-direction:column; }
  .pr-left { width:100%; max-width:100%; height:auto; min-height:0; position:static; }
  .pr-list { max-height:320px; }
  .pr-right { min-height:400px; }
  .pr-g2 { grid-template-columns:1fr; }
  .pr-vb-stats { grid-template-columns:repeat(2,1fr); }
  .pr-decision-layout { grid-template-columns:1fr; }
  .pr-decision-report__metrics { grid-template-columns:repeat(2,minmax(0,1fr)); }
}

/* Approved mockup layout */
.pr {
  display:block;
  max-width:none;
  min-height:calc(100vh - var(--header-height));
  padding:0 40px 56px;
}
.pr-schedule {
  margin:0 -40px;
  padding:22px 40px 34px;
  border-bottom:1px solid var(--border);
  background:var(--surface);
}
.pr-schedule__controls {
  display:grid;
  grid-template-columns:minmax(210px,250px) minmax(190px,230px);
  gap:20px;
  align-items:end;
}
.pr-filter { display:grid; gap:6px; }
.pr-filter label { color:var(--text-3); font-size:10px; font-weight:800; letter-spacing:.09em; text-transform:uppercase; }
.pr-filter select,
.pr-filter input {
  width:100%; min-height:46px; padding:0 14px;
  border:1px solid var(--border); border-radius:10px;
  background:var(--surface); color:var(--text); font-size:14px; font-weight:700;
}
.pr-schedule__tabs { display:flex; gap:28px; margin-top:20px; }
.pr-mode-tab {
  position:relative; padding:7px 1px; border:0; background:transparent;
  color:var(--text-3); font-size:13px; font-weight:800; cursor:pointer;
}
.pr-mode-tab.active { color:var(--primary); }
.pr-mode-tab.active::after { content:''; position:absolute; left:0; right:0; bottom:-1px; height:3px; border-radius:3px; background:var(--primary); }
.pr-status-line { margin:10px 0 0; color:var(--text-2); font-size:12px; }
.pr-match-list {
  width:100%; margin:22px auto 0; overflow:hidden;
  border:1px solid var(--border); border-radius:12px;
  background:var(--surface);
}
.pr-day-group + .pr-day-group { border-top:1px solid var(--border); }
.pr-day-heading {
  display:flex; align-items:center; min-height:42px; padding:0 24px;
  background:var(--surface2); color:var(--text-3);
  font-size:11px; font-weight:850; letter-spacing:.06em; text-transform:uppercase;
}
.pr-match-list-row {
  display:grid; grid-template-columns:82px minmax(0,2fr) 150px 122px 18px;
  align-items:center; gap:16px; width:100%; min-height:62px; padding:0 24px;
  border:0; border-top:1px solid var(--border); background:var(--surface);
  color:var(--text); text-align:left; cursor:pointer;
  transition:background .16s ease,color .16s ease;
}
.pr-match-list-row:hover { background:var(--primary-dim); }
.pr-match-list-row:focus-visible { position:relative; z-index:1; outline:3px solid var(--primary-border); outline-offset:-3px; }
.pr-match-list-row:disabled { cursor:wait; opacity:.68; }
.pr-match-list__time { font-family:var(--font-mono); font-size:14px; font-weight:800; }
.pr-match-list__teams { display:grid; grid-template-columns:minmax(150px,1fr) 36px minmax(150px,1fr); align-items:center; gap:16px; min-width:0; }
.pr-match-list__team { min-width:0; font-size:14px; font-weight:800; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.pr-match-list__versus { color:var(--text-3); font-size:11px; font-weight:800; text-align:center; text-transform:uppercase; }
.pr-match-list__meta { color:var(--text-2); font-size:11px; text-align:right; }
.pr-match-list__action { color:var(--primary); font-size:12px; font-weight:800; text-align:right; }
.pr-match-list__chevron { color:var(--primary); }
.pr-match-list__score { margin-left:8px; color:var(--primary); font-family:var(--font-mono); }
.pr-list-state { display:grid; place-items:center; min-height:300px; padding:40px; color:var(--text-2); text-align:center; }
.pr-list-state strong { display:block; margin-bottom:6px; color:var(--text); font-size:16px; }
.pr-detail-nav { width:min(100%,1380px); margin:20px auto 0; }
.pr-back-button {
  display:inline-flex; align-items:center; gap:8px; min-height:40px; padding:0 12px;
  border:0; border-radius:8px; background:transparent; color:var(--primary);
  font-size:13px; font-weight:800; cursor:pointer;
}
.pr-back-button:hover { background:var(--primary-dim); }
.pr-back-button:focus-visible { outline:3px solid var(--primary-border); outline-offset:2px; }
.pr-right {
  width:min(100%,1380px); min-height:650px; margin:24px auto 0;
  overflow:visible; border:0; border-radius:0; background:transparent; box-shadow:none;
}
.pr-results-head {
  position:static; padding:18px 22px; border:1px solid var(--border); border-radius:14px 14px 0 0;
  background:var(--surface);
}
.pr-results-match { font-size:22px; }
.pr-results-meta { margin-top:5px; font-size:12px; }
.pr-empty-state {
  min-height:530px; border:1px solid var(--border); border-radius:14px;
  background:var(--surface);
}
.pr-hero { margin:0; padding:30px 34px 24px; border-radius:0; border-top:0; }
.pr-hero-name { font-size:22px; }
.pr-kpi-row { margin:0; gap:0; border:1px solid var(--border); border-top:0; background:var(--surface); }
.pr-kpi { border:0; border-right:1px solid var(--border); border-radius:0; background:var(--surface); padding:18px; }
.pr-kpi:last-child { border-right:0; }
.pr-kpi-val { font-size:25px; }
.pr-decision-layout { margin:18px 0; grid-template-columns:minmax(0,1.6fr) minmax(300px,.62fr); gap:18px; }
.pr-tabs { padding:6px 0 14px; border-bottom:1px solid var(--border); gap:8px; }
.pr-tab { font-size:12px; padding:9px 15px; }
.pr-content { padding:18px 0 32px; }

@media (max-width:900px) {
  .pr { padding:0 0 96px; }
  .pr-schedule { margin:0; padding:18px 18px 20px; }
  .pr-schedule__controls { grid-template-columns:1fr; gap:12px; }
  .pr-filter label { font-size:9px; }
  .pr-filter select, .pr-filter input { min-height:46px; font-size:13px; }
  .pr-schedule__tabs { margin-top:14px; }
  .pr-match-list { margin:14px 0 0; border-inline:0; border-radius:0; }
  .pr-day-heading { min-height:42px; padding:0 18px; font-size:10px; }
  .pr-match-list-row {
    grid-template-columns:52px minmax(0,1fr) 54px 18px;
    gap:10px; min-height:78px; padding:10px 18px;
  }
  .pr-match-list__time { align-self:start; padding-top:3px; font-size:12px; }
  .pr-match-list__teams { display:block; min-width:0; }
  .pr-match-list__team { display:block; font-size:13px; line-height:1.45; }
  .pr-match-list__versus { display:block; text-align:left; font-size:9px; line-height:1.1; }
  .pr-match-list__meta { font-size:10px; line-height:1.4; }
  .pr-match-list__action { display:none; }
  .pr-list-state { min-height:260px; }
  .pr-detail-nav { margin:12px 14px 0; width:auto; }
  .pr-right { min-height:0; margin:16px 18px 0; width:auto; }
  .pr-results-head { padding:18px; align-items:flex-start; }
  .pr-results-head > div:last-child { flex-direction:column; align-items:flex-end !important; }
  .pr-results-match { font-size:19px; }
  .pr-results-meta { font-size:10px; }
  .pr-hero { grid-template-columns:minmax(0,1fr) 90px minmax(0,1fr); gap:12px; padding:22px 18px 20px; }
  .pr-hero-name { font-size:17px; }
  .pr-hero-stat { flex-direction:column; gap:1px; align-items:flex-start; }
  .pr-hero-team.right .pr-hero-stat { align-items:flex-end; }
  .pr-confidence { padding:6px; }
  .pr-confidence span { font-size:8px; }
  .pr-kpi { padding:14px 8px; }
  .pr-kpi-val { font-size:19px; }
  .pr-kpi-lbl { font-size:8px; }
  .pr-decision-layout { grid-template-columns:1fr; margin:14px 0; gap:12px; }
  .pr-tabs { padding-top:3px; }
  .pr-content { padding-top:14px; }
  .pr-empty-state { min-height:360px; }
}

@media (max-width:520px) {
  .pr-hero { grid-template-columns:minmax(0,1fr) 66px minmax(0,1fr); gap:8px; padding:18px 12px; }
  .pr-hero-name { font-size:14px; }
  .pr-hero-stat { padding:4px 6px; }
  .pr-hero-stat span { font-size:8px; }
  .pr-hero-stat strong { font-size:11px; }
  .pr-confidence span { display:none; }
  .pr-confidence strong { font-size:12px; }
}
`;

/*  MAIN  */

const PredictionWorkbenchView: React.FC<PredictionWorkbenchViewProps> = ({ vm }) => {
  const rightRef = useRef<HTMLDivElement>(null);
  const {
    matchSelection,
    predictionAnalysis,
    userBudget,
    handleBet,
    gp,
    cp,
    fp,
    sp,
    pp,
    playerValueOpportunities,
    analysisFactors,
    methodology,
    vbRanked,
    allOddsEntries,
    allOddsGroups,
    valueSelectionSet,
    isReplayAnalysis,
    actualMatch,
    recommendedBetResult,
    oddsReliabilityBadge,
    oddsSourceWarning,
    replayOutcomeTone,
    replayOutcomeLabel,
    leftPanelTitle,
    bankroll,
    maxExposurePct,
    maxExposureAmount,
    finalRecommendedChoice,
    suggestedTotalStake,
    exposureRatio,
    oppStakeKey,
    oppStakeValue,
    tabs: TABS,
    handleRefresh,
  } = vm;
  const {
    competition,
    season,
    matchMode,
    upcomingLoading,
    matchdayMap,
    activeMatchRow,
    autoSyncMsg,
    comps,
    groupedMatches: grouped,
    setCompetition,
    setSeason,
    setMatchMode,
    tab,
    setTab,
  } = matchSelection;
  const {
    pred,
    loading,
    loadingMatchId,
    marketsRequested,
    oddsMsg,
    oddsTone,
    stakes,
    setStakes,
  } = predictionAnalysis;
  const budget = userBudget.budget;
  const placedBetKeySet = userBudget.placedBetKeySet;

  const detailOpen = Boolean(activeMatchRow || pred || loadingMatchId);

  const handleAnalyze = (match: any) => {
    rightRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
    void predictionAnalysis.handleAnalyze(match);
  };

  const handleBackToMatches = () => {
    predictionAnalysis.clearAnalysisState();
  };

  return (
    <>
      <style>{S}</style>
      <div className="pr">

        {!detailOpen && (
          <section className="pr-schedule" aria-label="Filtri e partite">
            <div className="pr-schedule__controls">
              <div className="pr-filter">
                <label htmlFor="pr-competition-filter">Campionato</label>
                <select id="pr-competition-filter" value={competition} onChange={(event) => setCompetition(event.target.value)}>
                  <option value="">Tutti i campionati</option>
                  {comps.map((item) => <option key={item} value={item}>{item}</option>)}
                </select>
              </div>
              <div className="pr-filter pr-filter--season">
                <label htmlFor="pr-season-filter">Stagione</label>
                <input id="pr-season-filter" value={season} onChange={(event) => setSeason(event.target.value)} placeholder={currentSeason()} />
              </div>
            </div>

            <div className="pr-schedule__tabs" role="tablist" aria-label="Tipo partite">
              <button type="button" role="tab" aria-selected={matchMode === 'upcoming'} className={`pr-mode-tab${matchMode === 'upcoming' ? ' active' : ''}`} onClick={() => setMatchMode('upcoming')}>In programma</button>
              <button type="button" role="tab" aria-selected={matchMode === 'recent'} className={`pr-mode-tab${matchMode === 'recent' ? ' active' : ''}`} onClick={() => setMatchMode('recent')}>Recenti</button>
            </div>
            {autoSyncMsg && <p className="pr-status-line">{autoSyncMsg}</p>}

            <div className="pr-match-list" aria-label={leftPanelTitle} aria-busy={upcomingLoading}>
              {upcomingLoading ? (
                <div className="pr-list-state"><div><span className="pr-spin" aria-label="Caricamento partite" /></div></div>
              ) : grouped.length === 0 ? (
                <div className="pr-list-state">
                  <div><strong>Nessuna partita trovata</strong>Modifica campionato o stagione per vedere gli incontri.</div>
                </div>
              ) : grouped.map(({ key, label, matches }) => (
                <section className="pr-day-group" key={key} aria-labelledby={`pr-day-${key}`}>
                  <div className="pr-day-heading" id={`pr-day-${key}`}>{label}</div>
                  {matches.map((match: any) => {
                    const matchId = String(match.match_id ?? '');
                    const isLoading = loadingMatchId === matchId;
                    const isPlayed = match.home_goals !== null && match.away_goals !== null;
                    const score = isPlayed ? `${match.home_goals}-${match.away_goals}` : null;
                    const homeTeam = match.home_team_name ?? match.home_team_id;
                    const awayTeam = match.away_team_name ?? match.away_team_id;
                    const matchday = isSerieA(match.competition ?? competition) && matchdayMap[matchId]
                      ? `G${matchdayMap[matchId]}`
                      : '—';
                    return (
                      <button
                        type="button"
                        key={matchId}
                        className="pr-match-list-row"
                        aria-label={`${homeTeam} vs ${awayTeam}, ${formatKickoff(match.date)}. Vedi analisi`}
                        onClick={() => !isLoading && handleAnalyze(match)}
                        disabled={isLoading}
                      >
                        <span className="pr-match-list__time">{formatKickoff(match.date).split(',')[1]?.trim() ?? '--'}</span>
                        <span className="pr-match-list__teams">
                          <span className="pr-match-list__team">{homeTeam}{score && <b className="pr-match-list__score">{score.split('-')[0]}</b>}</span>
                          <span className="pr-match-list__versus">vs</span>
                          <span className="pr-match-list__team">{awayTeam}{score && <b className="pr-match-list__score">{score.split('-')[1]}</b>}</span>
                        </span>
                        <span className="pr-match-list__meta">{matchday} &nbsp;•&nbsp; {match.competition ?? competition}</span>
                        <span className="pr-match-list__action">Vedi analisi</span>
                        <ChevronRight className="pr-match-list__chevron" size={18} aria-hidden="true" />
                      </button>
                    );
                  })}
                </section>
              ))}
            </div>
          </section>
        )}

        {detailOpen && (
          <div className="pr-detail-nav">
            <button type="button" className="pr-back-button" onClick={handleBackToMatches}>
              <ArrowLeft size={18} aria-hidden="true" /> Tutte le partite
            </button>
          </div>
        )}

        {/*  SINGLE MATCH DETAIL  */}
        {detailOpen && <div className="pr-right" ref={rightRef}>
          {!pred && activeMatchRow ? (
            <>
              <div className="pr-results-head">
                <div>
                  <div className="pr-results-match">{activeMatchRow.home_team_name ?? activeMatchRow.home_team_id} vs {activeMatchRow.away_team_name ?? activeMatchRow.away_team_id}</div>
                  <div className="pr-results-meta">{activeMatchRow.competition ?? competition} | {formatKickoff(activeMatchRow.date)}</div>
                </div>
                <button type="button" className="fp-btn fp-btn-solid fp-btn-sm" onClick={() => handleAnalyze(activeMatchRow)} disabled={loading}>
                  {loading ? 'Analisi in corso...' : 'Analizza partita'}
                </button>
              </div>
              <div className="pr-hero pr-preview-hero">
                <div className="pr-hero-team"><div className="pr-hero-name">{activeMatchRow.home_team_name ?? activeMatchRow.home_team_id}</div><div className="pr-hero-lambda">Casa</div></div>
                <div className="pr-hero-center"><div className="pr-hero-vs">VS</div>{loading && <div className="pr-spin" style={{ margin: '0 auto' }} />}</div>
                <div className="pr-hero-team right"><div className="pr-hero-name">{activeMatchRow.away_team_name ?? activeMatchRow.away_team_id}</div><div className="pr-hero-lambda">Trasferta</div></div>
              </div>
              <LineupPanel matchId={String(activeMatchRow.match_id)} />
              <div className="pr-kpi-row" aria-label="Probabilità in attesa di analisi">
                {[['1', 'Vittoria casa'], ['X', 'Pareggio'], ['2', 'Vittoria ospite']].map(([value, label]) => <div className="pr-kpi" key={value}><div className="pr-kpi-val">{value}</div><div className="pr-kpi-lbl">{label}</div></div>)}
              </div>

              <div className="pr-decision-layout">
                <div className="pr-decision-report is-empty">
                  <div className="pr-decision-report__eyebrow">Giocata consigliata</div>
                  <strong className="pr-decision-report__title">{loading ? 'Sto preparando il pronostico' : 'Pronta per l’analisi'}</strong>
                  <p className="pr-decision-report__summary">{loading ? (oddsMsg || 'Calcolo probabilità e verifico le quote disponibili.') : 'Avvia l’analisi per calcolare la singola giocata finale e verificare le quote bookmaker reali.'}</p>
                </div>
                <div className="pr-card"><div className="pr-card-head"><div className="pr-card-title">Impatto sul budget</div></div><div className="pr-card-body"><div className="pr-info">Bankroll disponibile: <strong>EUR {bankroll.toFixed(2)}</strong></div></div></div>
              </div>
            </>
          ) : !pred ? (
            <div className="pr-empty-state"><div className="pr-empty-icon">?</div><div style={{fontSize:16,fontWeight:800,marginBottom:10}}>Nessuna partita disponibile</div><div className="pr-empty-msg">Modifica data o campionato per vedere gli incontri.</div></div>
          ) : pred && (
            <>
              {/* Sticky header */}
              <div className="pr-results-head">
                <div>
                  <div className="pr-results-match">{pred.homeTeam} vs {pred.awayTeam}</div>
                  <div className="pr-results-meta">
                    {pred.competition} | gol attesi {pred.lambdaHome} - {pred.lambdaAway}
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
                dataQuality={pred.dataQuality}
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

              <LineupPanel matchId={String(activeMatchRow?.match_id ?? pred.matchId ?? '')} />

              <div className="pr-decision-layout">
                <BestValueCard
                  opportunity={finalRecommendedChoice as BestValueOpportunityModel | null}
                  oddsBadge={oddsReliabilityBadge}
                  oddsWarning={oddsSourceWarning}
                  bestBetStatus={finalRecommendedChoice ? pred.bestBetStatus : 'NO_MARKET'}
                  bestBetReason={finalRecommendedChoice
                    ? pred.bestBetReason
                    : 'Nessuna quota supera i criteri operativi: questa partita non genera una puntata reale.'}
                  emptyMessage="Quote o probabilità insufficienti per scegliere una giocata."
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
                <div>
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
                  <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 12 }}>
                    <button className="fp-btn fp-btn-solid fp-btn-sm" onClick={() => setTab('value')}>
                      Approfondisci i mercati
                    </button>
                    <button className="fp-btn fp-btn-ghost fp-btn-sm" onClick={() => setTab('strategy')}>
                      Come viene scelto
                    </button>
                  </div>
                </div>
              </div>

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
                        <ProbBar label="Goal/Goal" value={gp.btts} color="var(--primary-hover)" />
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
                          <div className="pr-odds-groups">
                            {allOddsGroups.map((group) => (
                              <section className="pr-odds-group" key={group.category} aria-label={group.category}>
                                <h3 className="pr-odds-group-title">{group.category}</h3>
                                <div className="pr-odds-grid">
                                  {group.entries.map((o) => (
                                    <div key={o.selection} className={`pr-odds-cell${valueSelectionSet.has(o.selection) ? ' best' : ''}`}>
                                      <span className="pr-odds-name" title={o.selection}>{fmtSelection(o.selection)}</span>
                                      <strong className="pr-odds-val">{o.odd.toFixed(2)}</strong>
                                      {o.bookmaker && <small className="pr-odds-bookmaker">{o.bookmaker}</small>}
                                    </div>
                                  ))}
                                </div>
                              </section>
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
                        <span className="pr-badge pr-badge-blue">M {fmtN(fp.totalFouls.expected)}</span>
                        <span className="pr-badge pr-badge-gray">Var {fmtN(fp.totalFouls.variance)}</span>
                      </div>
                    </div>
                    <div className="pr-card-body">
                      <div className="pr-info" style={{marginBottom:14}}>
                        Casa: <strong>{fmtN(fp.homeFouls.expected)}</strong> | Ospite: <strong>{fmtN(fp.awayFouls.expected)}</strong> | Var/media: <strong>{fmtN(fp.totalFouls.variance/fp.totalFouls.expected,2)}x</strong>
                      </div>
                      <DistChart dist={fp.totalFouls.distribution} expected={fp.totalFouls.expected} title="P(falli = k)" color="var(--primary-hover)" />
                      <div className="pr-g2">
                        {Object.entries(fp.overUnder).filter(([k])=>k.startsWith('over')).map(([k,v]) => (
                          <ProbBar key={k} label={`Over ${formatCompactOuKey(k)}`} value={v as number} color="var(--primary-hover)" />
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
                            <ProbBar label=">=1 in porta" value={p.markets.over05onTarget} color="var(--primary-hover)" />
                          </div>
                        </div>
                      </div>
                    </div>
                  ))
                )}

                {/* PLAYER PROPS */}
                {tab==='playerProps' && (
                  <PlayerPropsSection
                    opportunities={playerValueOpportunities}
                    bankroll={bankroll}
                  />
                )}

                {/* STRATEGY */}
                {tab==='strategy' && (
                  <div>
                    <div className="pr-card">
                      <div className="pr-card-head">
                        <div className="pr-card-title">Linea decisionale</div>
                      </div>
                      <div className="pr-card-body">
                        <div className="pr-info" style={{ marginBottom: 12 }}>
                          La migliore giocata e gia riassunta in alto. Questo tab serve solo a capire il criterio con cui e stata promossa sopra le alternative.
                        </div>
                        <div className="pr-g2">
                          <div className="pr-info">
                            <strong>Lettura del match</strong><br />
                            {finalRecommendedChoice
                              ? `${finalRecommendedChoice.selectionLabel ?? fmtSelection(finalRecommendedChoice.selection)} resta la sola uscita principale per questo match.`
                              : 'Se non emerge una giocata davvero forte, il sistema preferisce non spingere una pick finale.'}
                          </div>
                          <div className="pr-info">
                            <strong>Disciplina operativa</strong><br />
                            Quote fallback, synthetic o non disponibili abbassano la priorita decisionale e vanno trattate con cautela anche quando l'edge stimato e positivo.
                          </div>
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
                              {finalRecommendedChoice
                                ? `${finalRecommendedChoice.selectionLabel ?? fmtSelection(finalRecommendedChoice.selection)} e la sola quota proposta come uscita finale.`
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
                    <div className="pr-alert pr-alert-info">
                      Confronto completo mercati. La pick principale resta nel riepilogo in alto; qui sotto verifichi alternative, quote e sizing.
                    </div>
                    <div className="pr-card">
                      <div className="pr-card-head">
                        <div className="pr-card-title">Legenda Termini Analisi</div>
                      </div>
                      <div className="pr-card-body">
                        <div className="pr-legend-grid">
                          {VALUE_LEGEND.map((row) => (
                            <div className="pr-legend-row" key={row.term}>
                              <div className="pr-legend-term">
                                {row.termId ? <GlossaryTerm termId={row.termId}>{row.term}</GlossaryTerm> : row.term}
                              </div>
                              <div className="pr-legend-meaning">{row.meaning}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                    <ValueOpportunitiesTable
                      opportunities={vbRanked}
                      recommendedOpportunity={finalRecommendedChoice}
                      bankroll={bankroll}
                      budgetReady={Boolean(budget)}
                      isReplayAnalysis={isReplayAnalysis}
                      oddsSource={pred?.oddsSource ?? null}
                      oddsBookmaker={pred?.oddsBookmaker ?? null}
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
        </div>}

      </div>
    </>
  );
};

export default PredictionWorkbenchView;
