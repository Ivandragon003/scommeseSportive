import React, { useEffect, useRef, useState } from 'react';
import { AppSelect } from '../common/AppSelect';
import { ArrowLeft } from 'lucide-react';
import MatchModelAdvice from './MatchModelAdvice';
import SportingAnalysis from './SportingAnalysis';
import MatchupHeader from './MatchupHeader';
import MatchQuoteRequest from './MatchQuoteRequest';
import ModelBetActions from './ModelBetActions';
import OpportunityQuality from './OpportunityQuality';
import SavedModelOpportunities from './SavedModelOpportunities';
import { fmtSelection } from './predictionFormatting';
import { currentSeason, dateToDayKey, formatKickoff } from './predictionWorkbenchUtils';
import type { PredictionWorkbenchViewModel } from '../../hooks/usePredictionWorkbench';

interface PredictionWorkbenchViewProps { vm: PredictionWorkbenchViewModel }

/*  STYLES  */
const S = `
.pr-detail-tabs { display:flex; gap:8px; margin:16px 0; padding:5px; border:1px solid var(--border); border-radius:12px; background:var(--surface2); }
.pr-detail-tabs button { flex:1; min-height:44px; border:1px solid transparent; border-radius:8px; background:transparent; color:var(--text-2); font:700 14px var(--font-sans); cursor:pointer; }
.pr-detail-tabs button[aria-selected="true"] { color:var(--primary); background:var(--surface); border-color:var(--primary-border); }
.model-bet-actions { margin-top:16px; padding-top:14px; border-top:1px solid var(--border); }
.model-bet-actions label { display:grid; gap:6px; color:var(--text-2); font-size:13px; }
.model-bet-actions input { width:100%; max-width:180px; min-height:44px; padding:9px 12px; border:1px solid var(--border); border-radius:8px; background:var(--surface); color:var(--text); font:inherit; }
.model-bet-actions__buttons { display:flex; flex-wrap:wrap; gap:8px; margin-top:10px; }
.pr-sporting-analysis { display:grid; gap:16px; }
.pr-sporting-analysis h2 { margin:0; font-size:17px; }
.pr-sporting-analysis > section > h2 { margin:0 0 12px; }
.pr-sporting-analysis p { color:var(--text-2); font-size:13px; }
.pr-sporting-xg { display:grid; grid-template-columns:1fr 1fr; gap:12px; }
.pr-sporting-xg dt { color:var(--text-2); font-size:12px; }
.pr-sporting-xg dd { margin:5px 0; font-size:20px; font-weight:750; }

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
.pr-native-picker { position:relative; }
.pr-native-picker__trigger { width:100%; display:flex; align-items:center; justify-content:space-between; gap:8px; min-height:42px; padding:0 12px; border:1px solid var(--border); border-radius:10px; background:var(--surface); color:var(--text); font:inherit; text-align:left; }
.pr-native-picker__trigger svg { transition:transform .18s ease; color:var(--text-2); }
.pr-native-picker__trigger svg.is-open { transform:rotate(90deg); }
.pr-native-picker__menu { position:absolute; z-index:20; top:calc(100% + 6px); left:0; right:0; padding:6px; border:1px solid var(--border); border-radius:12px; background:var(--surface); box-shadow:0 16px 34px rgba(0,0,0,.22); }
.pr-native-picker__menu button { width:100%; display:flex; justify-content:space-between; padding:10px; border:0; border-radius:8px; background:transparent; color:var(--text); font:inherit; text-align:left; }
.pr-native-picker__menu button.active, .pr-native-picker__menu button:focus-visible { background:var(--green-dim); color:var(--green); outline:none; }

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
.pr-match-row.active { background:var(--primary-dim) !important; border-left:2px solid var(--primary); padding-left:14px; }
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
.pr-odds-status.info    { background:var(--surface3);  color:var(--text-2);  }
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
  border-radius:var(--radius-sm); padding:7px 10px; color:var(--primary);
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
.pr-data-history-item strong { color:var(--primary); font-family:var(--font-mono); font-size:14px; }
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
.pr-tabs-wrap { min-width:0; }
.pr-tabs {
  display:flex; gap:2px; padding:0 20px 12px; min-width:0; max-width:100%;
  overflow-x:auto; overflow-y:hidden; overscroll-behavior-x:contain;
  -webkit-overflow-scrolling:touch; scroll-snap-type:x proximity; flex-shrink:0;
  scrollbar-width:thin; scrollbar-color:rgba(115,136,161,0.45) transparent;
}
.pr-tabs::-webkit-scrollbar { height:4px; }
.pr-tabs::-webkit-scrollbar-thumb { background:rgba(115,136,161,0.45); border-radius:4px; }
.pr-tabs-scroll-hint { display:none; }
.pr-tab {
  font-family:var(--font-sans); font-size:11px; font-weight:700;
  white-space:nowrap; padding:7px 14px; border-radius:8px;
  border:1px solid transparent; background:transparent; color:var(--text-3);
  cursor:pointer; transition:all var(--transition); flex-shrink:0; scroll-snap-align:start;
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
.pr-score-pct { font-size:10px; font-family:var(--font-mono); color:var(--primary); margin-top:2px; }

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
.pr-badge-blue   { background:var(--primary-dim); color:var(--primary); border-color:var(--primary-border); }
.pr-badge-gold   { background:var(--gold-dim);   color:var(--gold);   border-color:var(--gold-border);  }
.pr-badge-gray   { background:var(--surface3); color:var(--text-2); border-color:var(--border); }
.pr-badge-purple { background:var(--purple-dim); color:var(--purple); border-color:var(--purple-border); }

.pr-alert { padding:10px 14px; border-radius:var(--radius-sm); font-size:12px; line-height:1.6; margin-bottom:12px; }
.pr-alert-info    { background:color-mix(in srgb, var(--primary-dim) 52%, var(--surface)); border:1px solid var(--primary-border); color:var(--text-2); }
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
.pr-spin { width:24px; height:24px; border:2px solid var(--border); border-top-color:var(--primary); border-radius:50%; animation:pr-s .6s linear infinite; flex-shrink:0; }
@keyframes pr-s { to { transform:rotate(360deg); } }

/* LOADING overlay on match row */
.pr-match-spinner { position:absolute; right:12px; top:50%; transform:translateY(-50%); }

/* PLAYER */
.pr-player-head { display:flex; justify-content:space-between; align-items:flex-start; }
.pr-player-name { font-size:15px; font-weight:800; margin-bottom:3px; }
.pr-player-meta { font-size:11px; color:var(--text-2); }
.pr-player-xg-val { font-size:22px; font-weight:800; font-family:var(--font-mono); color:var(--primary); text-align:right; }
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
.pr-select-sm:focus, .pr-input-sm:focus { border-color:var(--primary); }
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
.pr-filter label { color:var(--text-2); font-size:10px; font-weight:800; letter-spacing:.09em; text-transform:uppercase; }
.pr-filter select,
.pr-filter input {
  width:100%; min-height:46px; padding:0 14px;
  border:1px solid var(--border); border-radius:10px;
  background:var(--surface); color:var(--text); font-size:14px; font-weight:700;
}
.pr-schedule__tabs { display:flex; gap:28px; margin-top:20px; }
.pr-mode-tab {
  position:relative; padding:7px 1px; border:0; background:transparent;
  color:var(--text-2); font-size:13px; font-weight:800; cursor:pointer;
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

/* Matchday workspace: deliberately distinct from the dense analytical detail. */
.pr-schedule {
  padding-top: 30px;
  background: var(--surface);
}
.pr-schedule__heading {
  display:flex;
  align-items:flex-end;
  justify-content:space-between;
  gap:24px;
  max-width:1380px;
  margin:0 auto 26px;
}
.pr-schedule__heading h1 {
  margin:4px 0 0;
  color:var(--text);
  font-size:clamp(30px,3.8vw,46px);
  font-weight:850;
  letter-spacing:-.052em;
  line-height:1;
}
.pr-schedule__heading p:not(.pr-schedule__eyebrow) {
  margin:10px 0 0;
  color:var(--text-2);
  font-size:13px;
}
.pr-schedule__eyebrow {
  margin:0;
  color:var(--primary);
  font:800 11px var(--font-mono);
  letter-spacing:.12em;
  text-transform:uppercase;
}
.pr-schedule__availability {
  display:inline-flex;
  align-items:center;
  gap:10px;
  min-height:32px;
  padding-left:12px;
  border-left:3px solid var(--green);
  color:#547260;
  font-size:12px;
  font-weight:800;
  white-space:nowrap;
}
.pr-schedule__availability span { width:8px; height:8px; border-radius:50%; background:var(--green); }
.pr-schedule__controls { max-width:1380px; margin:0 auto; grid-template-columns:minmax(190px,240px) minmax(168px,210px); }
.pr-schedule__tabs { max-width:1380px; margin-inline:auto; }
.pr-date-rail {
  display:flex;
  gap:9px;
  max-width:1380px;
  margin:18px auto 0;
  overflow-x:auto;
  padding:2px 1px 7px;
  scrollbar-width:thin;
}
.pr-date-rail__item {
  display:grid;
  flex:0 0 108px;
  gap:5px;
  min-height:70px;
  padding:11px 12px;
  border:1px solid var(--border);
  border-radius:11px;
  background:var(--surface);
  color:var(--text-2);
  text-align:left;
  cursor:pointer;
}
.pr-date-rail__item span { overflow:hidden; font-size:12px; font-weight:800; text-overflow:ellipsis; white-space:nowrap; }
.pr-date-rail__item strong { color:var(--text-3); font-size:10px; font-weight:700; }
.pr-date-rail__item:hover { border-color:var(--primary-border); background:var(--primary-dim); color:var(--primary); }
.pr-date-rail__item.active { border-color:var(--primary); background:var(--primary); color:#fff; }
.pr-date-rail__item.active strong { color:#dcecff; }
.pr-match-list {
  max-width:1380px;
  margin-top:22px;
  padding:0;
  overflow:visible;
  border:0;
  border-radius:0;
  background:transparent;
}
.pr-day-group { display:grid; gap:10px; margin-top:24px; }
.pr-day-group + .pr-day-group { border:0; }
.pr-day-heading {
  min-height:auto;
  padding:0 0 10px;
  border-bottom:1px solid var(--border);
  background:transparent;
  color:var(--text);
  font-size:16px;
  letter-spacing:-.02em;
  text-transform:none;
}
.pr-day-heading::after { content:'Partite disponibili'; margin-left:10px; color:var(--text-3); font-size:11px; font-weight:700; letter-spacing:0; }
.pr-day-group { grid-template-columns:repeat(auto-fill,minmax(276px,1fr)); }
.pr-day-heading { grid-column:1/-1; }
.pr-match-list-row {
  position:relative;
  grid-template-columns:1fr auto;
  grid-template-rows:auto 1fr auto auto;
  gap:9px 14px;
  min-height:172px;
  padding:18px 18px 16px;
  border:1px solid var(--border);
  border-radius:14px;
  background:var(--surface);
  box-shadow:0 1px 1px rgba(16,27,54,.03);
  overflow:hidden;
}
.pr-match-list-row::before { content:''; position:absolute; inset:15px auto 15px 0; width:3px; border-radius:0 3px 3px 0; background:var(--surface4); }
.pr-match-list-row.is-ready::before { background:var(--green); }
.pr-match-list-row::after { display:none; }
.pr-match-list-row:hover { border-color:var(--primary); background:var(--surface); box-shadow:var(--shadow-hover); transform:translateY(-2px); }
.pr-match-list-row:active { transform:translateY(0); }
.pr-match-list__time { align-self:start; color:var(--text); font-size:12px; }
.pr-match-list__meta { align-self:start; color:var(--text-3); font-size:10px; white-space:nowrap; }
.pr-match-list__teams { grid-column:1/-1; display:grid; grid-template-columns:1fr 30px 1fr; gap:8px; align-self:center; }
.pr-match-list__team { font-size:15px; line-height:1.25; white-space:normal; }
.pr-match-list__team:last-child { text-align:right; }
.pr-match-list__versus { align-self:center; color:var(--text-3); font-family:var(--font-mono); font-size:10px; }
.pr-match-list__action { grid-column:1; grid-row:3; align-self:end; text-align:left; color:var(--primary); font-size:11px; }
.pr-match-list__action::before { content:none; display:inline-flex; margin-right:6px; padding:2px 5px; border:1px solid var(--primary-border); border-radius:4px; background:var(--primary-dim); color:var(--primary); font-family:var(--font-mono); font-size:8px; letter-spacing:.06em; text-transform:uppercase; }
.pr-match-list__pick {
  grid-column:1/-1;
  grid-row:4;
  display:flex;
  align-items:center;
  justify-content:space-between;
  gap:10px;
  min-width:0;
  padding:9px 10px;
  border:1px solid var(--border);
  border-left:3px solid var(--border-hover);
  border-radius:8px;
  background:var(--surface2);
  color:var(--text-2);
}
.pr-match-list__pick.is-ready { border-left-color:var(--green); background:var(--green-dim); }
.pr-match-list__pick strong { overflow:hidden; font-size:11px; text-overflow:ellipsis; white-space:nowrap; }
.pr-match-list__pick small { flex:0 0 auto; color:var(--text-3); font-family:var(--font-mono); font-size:10px; }
.pr-match-list__pick.is-ready small { color:var(--green); font-weight:800; }
.pr-match-list__chevron { grid-column:2; grid-row:3; align-self:end; }

/* The one recommendation is the report surface, never another anonymous card. */
.pr-decision-report {
  border:1px solid var(--primary-border);
  border-left:4px solid var(--green);
  border-radius:14px;
  background:var(--surface);
  box-shadow:none;
}
.pr-decision-report.is-empty { border-color:var(--border); border-left-color:var(--text-3); background:var(--surface); }
.pr-place-bet { background:var(--green); border-color:var(--green); color:#fff; }
.pr-place-bet:hover:not(:disabled) { background:color-mix(in srgb, var(--green) 84%, #000); border-color:color-mix(in srgb, var(--green) 84%, #000); }
.pr-decision-report__eyebrow { color:var(--primary); font-family:var(--font-mono); }
.pr-decision-report__title { color:var(--text); font-size:27px; letter-spacing:-.04em; }
.pr-decision-report__summary,.pr-decision-report__market,.pr-decision-report__risks,.pr-decision-report__reasons { color:var(--text-2); }
.pr-decision-report__metrics { border-color:var(--border); background:var(--surface2); }
.pr-decision-report__metric { border-color:var(--border); }
.pr-decision-report__metric dt { color:var(--text-3); }
.pr-decision-report__metric dd,.pr-decision-report__market strong { color:var(--text); }
.pr-decision-report__body { padding-top:18px; }
.pr-decision-report.is-empty .pr-decision-report__eyebrow { color:var(--text-3); }
.pr-decision-report.is-empty .pr-decision-report__title { color:var(--text); }
.pr-decision-report.is-empty .pr-decision-report__summary { color:var(--text-2); }
.pr-results-head { border-radius:14px 14px 0 0; }
.pr-hero { position:relative; overflow:hidden; background:linear-gradient(135deg,color-mix(in srgb,var(--primary-dim) 60%,var(--surface)),var(--surface2)); border:1px solid var(--border); color:var(--text); }
.pr-hero::before { content:''; position:absolute; inset:0 auto 0 0; width:5px; background:var(--primary); }
.pr-hero-name,.pr-hero-stat strong { color:var(--text); }
.pr-hero-role,.pr-hero-lambda,.pr-hero-vs,.pr-hero-final { color:var(--text-3); }
.pr-confidence { background:var(--primary-dim); border:1px solid var(--primary-border); color:var(--primary); }
.pr-confidence strong { color:var(--text); }
.pr-kpi-row { border-color:var(--border); }
.pr-content { padding-top:22px; }
.pr-content .pr-card { border-radius:12px; box-shadow:0 1px 2px rgba(16,27,54,.035); }
.pr-content .pr-card-head { background:var(--surface2); }
.pr-content .pr-info { background:var(--surface2); border-radius:10px; }
.pr-content .pr-odds-cell { border-radius:9px; background:var(--surface); }
.pr-content .pr-odds-cell.best { background:var(--green-dim); }
.pr-content .pr-score-cell { border-radius:9px; background:var(--surface); }
.pr-content .pr-prob-track { background:var(--surface3); }
.pr-tabs { border-bottom:0; padding:10px; border:1px solid var(--border); border-radius:12px; background:var(--surface); }
.pr-tab.active { background:var(--primary); border-color:var(--primary); color:#fff; }
.pr-tab.active .pr-tab-pill { background:rgba(255,255,255,.2); color:#fff; }

@media (max-width:900px) {
  .pr-schedule { padding-top:22px; }
  .pr-schedule__heading { align-items:flex-start; flex-direction:column; margin-bottom:18px; }
  .pr-schedule__heading h1 { font-size:34px; }
  .pr-schedule__availability { font-size:11px; }
  .pr-match-list { margin-top:18px; }
  .pr-date-rail { margin-top:14px; }
  .pr-day-group { grid-template-columns:repeat(auto-fill,minmax(248px,1fr)); margin-top:20px; }
  .pr-match-list-row { min-height:168px; }
  .pr-schedule__controls { grid-template-columns:1fr; }
  .pr-tabs-scroll-hint {
    display:flex; align-items:center; justify-content:flex-end; gap:5px;
    margin:5px 4px 0; color:var(--text-3); font-size:10px; font-weight:700;
    letter-spacing:.01em;
  }
  .pr-tabs-scroll-hint span { color:var(--primary); font-size:13px; line-height:1; }
}

@media (max-width:560px) {
  .pr-schedule { padding-top:14px; }
  .pr-schedule__heading { margin-bottom:12px; gap:8px; }
  .pr-schedule__heading h1 { font-size:28px; }
  .pr-match-list { margin-top:12px; }
  .pr-day-group { margin-top:14px; gap:10px; }
  .pr-date-rail { margin-top:10px; }
  .pr-schedule__heading p:not(.pr-schedule__eyebrow) { font-size:12px; line-height:1.5; }
  .pr-schedule__availability { white-space:normal; }
  .pr-day-group { grid-template-columns:1fr; }
  .pr-match-list-row { min-height:112px; padding:14px; }
  .pr-schedule__controls { display:grid; grid-template-columns:minmax(0,1fr); width:100%; }
  .pr-filter,.pr-filter input,.pr-filter select { min-width:0; max-width:100%; }
  .pr-decision-report__title { font-size:23px; }
}
.pr-decision-layout--context { grid-template-columns:minmax(0,1fr); }
.pr-sporting-data { margin-top:20px; }
.pr-sporting-data summary { cursor:pointer; font-weight:700; }
.pr-sporting-data table { width:100%; border-collapse:collapse; }
.pr-sporting-data th, .pr-sporting-data td { text-align:left; padding:10px 8px; border-bottom:1px solid var(--border); }

`;


const PredictionWorkbenchView: React.FC<PredictionWorkbenchViewProps> = ({ vm }) => {
  const { matchSelection: selection, predictionAnalysis: analysis, modelAdvice } = vm;
  const { clearAnalysisState, handleAnalyze } = analysis;
  const { competition, season, matchMode, upcomingLoading, activeMatchRow, comps, groupedMatches: grouped } = selection;
  const [detailView, setDetailView] = useState<'sporting' | 'bets'>('sporting');
  const [selectedDayKey, setSelectedDayKey] = useState<string | null>(() => new URLSearchParams(window.location.search).get('day'));
  const today = dateToDayKey(new Date(Date.now()).toISOString());
  const selectedDay = selectedDayKey === 'all' ? 'all'
    : grouped.some(group => group.key === selectedDayKey) ? selectedDayKey
      : grouped.find(group => group.key === today)?.key ?? grouped[0]?.key ?? null;
  const railGroups = grouped.slice(0, 7);
  const extraDay = grouped.find(group => group.key === selectedDay && !railGroups.some(item => item.key === group.key));
  if (extraDay) railGroups.push(extraDay);
  const filterKey = `${competition}|${season}|${matchMode}`;
  const previousFilter = useRef(filterKey);
  useEffect(() => {
    if (previousFilter.current !== filterKey) { setSelectedDayKey(null); clearAnalysisState(); }
    previousFilter.current = filterKey;
  }, [filterKey, clearAnalysisState]);
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    if (selectedDay) params.set('day', selectedDay); else params.delete('day');
    window.history.replaceState(window.history.state, '', `${window.location.pathname}?${params.toString()}`);
  }, [selectedDay, filterKey]);
  useEffect(() => {
    const restore = () => {
      const id = new URLSearchParams(window.location.search).get('match');
      if (!id) { clearAnalysisState(); return; }
      const match = grouped.flatMap(group => group.matches).find((row: any) => String(row.match_id) === id);
      if (match && String(activeMatchRow?.match_id ?? '') !== id) void handleAnalyze(match);
    };
    restore(); window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, [grouped, activeMatchRow?.match_id, clearAnalysisState, handleAnalyze]);
  const open = (match: any) => {
    setDetailView('sporting');
    const params = new URLSearchParams(window.location.search); params.set('match', String(match.match_id));
    window.history.pushState({ predictionDetail: String(match.match_id) }, '', `${window.location.pathname}?${params.toString()}`);
    void handleAnalyze(match);
  };
  const back = () => {
    const params = new URLSearchParams(window.location.search); params.delete('match');
    window.history.replaceState(window.history.state, '', `${window.location.pathname}?${params.toString()}`);
    clearAnalysisState();
  };
  const matchId = String(activeMatchRow?.match_id ?? analysis.loadingMatchId ?? '');
  useEffect(() => {
    if (!matchId) return;
    // Opening a card must not inherit the scroll position of the fixture list.
    document.scrollingElement?.scrollTo({ top: 0, behavior: 'auto' });
    document.querySelector('.main-content')?.scrollTo({ top: 0, behavior: 'auto' });
  }, [matchId]);
  const pred = String(analysis.pred?.matchId ?? '') === matchId ? analysis.pred : null;
  const choice = pred ? vm.finalRecommendedChoice : null;
  const automatic = pred?.automaticRecommendation;
  const registeredFamilies = (['A', 'C'] as const).filter(family => vm.userBudget.walletBets.some(bet => bet.matchId === matchId && bet.portfolioId === `shadow_${family}`));
  const choiceBookmaker = String(choice?.bookmakerName ?? analysis.bookmakerBySelection[choice?.selection ?? ''] ?? pred?.canonicalRecommendation?.odds?.bookmakerBySelection?.[choice?.selection ?? ''] ?? '').trim();
  const realQuote = !!choice && Number(choice.bookmakerOdds) > 1 && !!choiceBookmaker
    && (automatic ? !!automatic.odds && !/synthetic|model|estimated/i.test(String(automatic.odds.source ?? '')) : pred?.oddsSource === 'odds_api');
  const completed = activeMatchRow?.home_goals != null && activeMatchRow?.away_goals != null;
  const started = activeMatchRow?.date && Date.parse(activeMatchRow.date) <= Date.now();
  const sourceTime = automatic?.odds?.updatedAt ?? automatic?.odds?.capturedAt ?? pred?.canonicalRecommendation?.odds?.capturedAt ?? pred?.oddsCapturedAt ?? pred?.oddsUpdatedAt;
  const renderActions = (family: 'A' | 'C', opportunity: any, registered = false, quoteCapturedAt?: string | null) => <ModelBetActions key={`${family}:${matchId}:${opportunity.selection}`}
    family={family} matchId={matchId} opportunity={opportunity} portfolios={vm.userBudget.portfolios}
    quoteCapturedAt={quoteCapturedAt ?? (family === 'A' ? sourceTime : undefined)}
    registered={registered || vm.userBudget.walletBets.some((bet) => bet.matchId === matchId && bet.portfolioId === `shadow_${family}`)}
    unavailable={!!completed || !!started || vm.isReplayAnalysis} onSaved={vm.userBudget.loadUserContext} />;
  const aAdvice = <section className="match-model-advice__card" aria-label="Consiglio modello A" data-testid="best-value-card">
    <h2>Modello A</h2>
    <p className="match-model-advice__origin">{vm.isReplayAnalysis ? 'Replay A · valutazione retrospettiva' : automatic ? 'Decisione Nightly A archiviata' : 'Anteprima A · non registrata'}</p>
    {!pred ? <>
      <h3>{analysis.loading ? 'Analisi A in corso…' : 'Analisi A non disponibile'}</h3>
      <p role={analysis.loading ? 'status' : 'alert'}>{analysis.loading ? 'La prima analisi può richiedere qualche minuto.' : completed ? 'Nessun consiglio pre-partita archiviato disponibile.' : started ? 'Consiglio non disponibile per una partita già iniziata. Risultato in attesa di aggiornamento.' : 'Non è stato possibile completare l’analisi. Puoi riprovare.'}</p>
      {!analysis.loading && !started && !completed && <button type="button" className="fp-btn fp-btn-ghost fp-btn-sm" onClick={vm.handleRefresh}>Riprova analisi A</button>}
    </> : <>
      <h3>{choice && realQuote ? choice.selectionLabel || fmtSelection(choice.selection) : pred.oddsSource !== 'odds_api' ? 'Servono quote reali per verificare A' : 'Nessuna giocata consigliata'}</h3>
      {choice && realQuote ? <dl className="match-model-advice__metrics">
        <div><dt>Quota bookmaker</dt><dd data-testid="best-value-metric-quota-bookmaker">{Number(choice.bookmakerOdds).toFixed(2)}</dd></div>
        <div><dt>Bookmaker</dt><dd>{choiceBookmaker}</dd></div>
        <div><dt>{automatic ? 'Importo virtuale registrato' : 'Stake indicativo'}</dt><dd>{automatic ? `EUR ${Number(automatic.actualStakeAmount ?? 0).toFixed(2)}` : `${choice.suggestedStakePercent}%`}</dd></div>
        <div><dt>Quota rilevata il</dt><dd>{sourceTime ? formatKickoff(sourceTime) : 'Orario non disponibile'}</dd></div>
      </dl> : <p>{pred.oddsSource !== 'odds_api' ? 'Quote reali non disponibili per una nuova giocata.' : 'Il modello A non ha selezionato una giocata con le quote disponibili.'}</p>}
      {automatic ? <p>{Number(automatic.actualStakeAmount) > 0 ? 'Puntata archiviata. Consulta Giocate per lo stato e l’esito.' : 'Nessuna puntata registrata.'}</p> : <p>Nessuna puntata registrata da questa analisi.</p>}
      {vm.isReplayAnalysis && <p>Il replay non è una decisione pre-partita archiviata.</p>}
      {choice && realQuote && <OpportunityQuality opportunity={choice} />}
      {choice && realQuote && renderActions('A', { ...choice, bookmakerName: choiceBookmaker }, Number(automatic?.actualStakeAmount) > 0)}
    </>}
  </section>;
  const actualScore = completed ? `${activeMatchRow.home_goals} - ${activeMatchRow.away_goals}` : vm.actualMatch?.actualScore;
  const actualStats: Array<[string, string, string]> = [
    ['xG', 'home_xg', 'away_xg'], ['Tiri', 'home_shots', 'away_shots'],
    ['Tiri in porta', 'home_shots_on_target', 'away_shots_on_target'], ['Corner', 'home_corners', 'away_corners'],
    ['Falli', 'home_fouls', 'away_fouls'], ['Gialli', 'home_yellow_cards', 'away_yellow_cards'], ['Rossi', 'home_red_cards', 'away_red_cards'],
  ];
  return <><style>{S}</style><div className="pr">
    {!matchId ? <section className="pr-schedule" aria-label="Filtri e partite">
      <header className="pr-schedule__heading"><div><h1>Partite</h1><p>Apri una partita per consultare i grafici sportivi e le migliori giocate A e C.</p></div>
        <button type="button" className="fp-btn fp-btn-ghost fp-btn-sm" disabled={upcomingLoading} onClick={() => void selection.refreshVisibleMatches(true)}>Aggiorna calendario</button></header>
      <div className="pr-schedule__controls"><div className="pr-filter"><label htmlFor="pr-competition-filter">Campionato</label>
        <AppSelect id="pr-competition-filter" aria-label="Campionato" value={competition} onChange={value => { setSelectedDayKey(null); selection.setCompetition(value); }} options={[{value:'',label:'Tutti i campionati'}, ...comps.map(item => ({value:item,label:item}))]} /></div>
        <div className="pr-filter pr-filter--season"><label htmlFor="pr-season-filter">Stagione</label><input id="pr-season-filter" value={season} onChange={event => { setSelectedDayKey(null); selection.setSeason(event.target.value); }} placeholder={currentSeason()} /></div></div>
      <div className="pr-schedule__tabs" role="tablist" aria-label="Tipo partite">{([['upcoming', 'In programma'], ['recent', 'Concluse']] as const).map(([mode, label]) => <button key={mode} type="button" role="tab" aria-selected={matchMode === mode} className={`pr-mode-tab${matchMode === mode ? ' active' : ''}`} onClick={() => { setSelectedDayKey(null); selection.setMatchMode(mode); }}>{label}</button>)}</div>
      {selection.autoSyncMsg && <p role="status" className="pr-status-line">{selection.autoSyncMsg}</p>}
      {!upcomingLoading && grouped.length > 0 && <div className="pr-date-rail" role="toolbar" aria-label="Filtra partite per data">
        <button type="button" className={`pr-date-rail__item${selectedDay === 'all' ? ' active' : ''}`} aria-pressed={selectedDay === 'all'} onClick={() => setSelectedDayKey('all')}>Tutte</button>
        {railGroups.map(group => <button type="button" key={group.key} className={`pr-date-rail__item${selectedDay === group.key ? ' active' : ''}`} aria-pressed={selectedDay === group.key} aria-label={`${group.label}, ${group.matches.length} match`} onClick={() => setSelectedDayKey(group.key)}><span>{group.label.split(' ')[0].slice(0, 3)}</span><strong>{group.label.split(' ').slice(1).join(' ')}</strong></button>)}</div>}
      <section className="pr-match-list" aria-label={matchMode === 'recent' ? 'Partite concluse' : 'Partite in programma'} aria-busy={upcomingLoading}>
        {upcomingLoading ? <p role="status">Caricamento partite…</p> : grouped.length === 0 ? <div className="pr-list-state"><strong>Nessuna partita trovata</strong><p>Modifica campionato o stagione.</p></div> : (selectedDay === 'all' ? grouped : grouped.filter(group => group.key === selectedDay)).map(group => <section className="pr-day-group" key={group.key}><div className="pr-day-heading">{group.label}</div>{group.matches.map((match: any) => {
          const played = match.home_goals != null && match.away_goals != null;
          const pending = !played && Date.parse(match.date) <= Date.now();
          return <button type="button" key={match.match_id} className="pr-match-list-row" aria-label={`${match.home_team_name ?? match.home_team_id} vs ${match.away_team_name ?? match.away_team_id}, ${formatKickoff(match.date)}. Vedi analisi`} onClick={() => open(match)}>
            <span className="pr-match-list__time">{formatKickoff(match.date).split(',')[1]?.trim() ?? '—'}</span>
            <span className="pr-match-list__teams"><span className="pr-match-list__team">{match.home_team_name ?? match.home_team_id}{played && <b>{match.home_goals}</b>}</span><span className="pr-match-list__versus">vs</span><span className="pr-match-list__team">{match.away_team_name ?? match.away_team_id}{played && <b>{match.away_goals}</b>}</span></span>
            <span className="pr-match-list__meta">{match.competition ?? competition}</span><span className="pr-match-list__action">Apri partita</span><span className="pr-match-list__pick"><strong>{played ? 'Conclusa' : pending ? 'Risultato in attesa' : 'In programma'}</strong></span>
          </button>;
        })}</section>)}
      </section>
    </section> : <>
      <div className="pr-detail-nav"><button type="button" className="pr-back-button" onClick={back}><ArrowLeft size={18} aria-hidden="true" />Tutte le partite</button></div>
      <div className="pr-right"><MatchupHeader match={activeMatchRow} prediction={pred} teams={selection.teams}
        meta={`${activeMatchRow?.competition ?? competition} · ${formatKickoff(activeMatchRow?.date)}${actualScore ? ` · Risultato finale ${actualScore}` : started ? ' · Risultato in attesa' : ''}`}
        onRefresh={vm.handleRefresh} loading={analysis.loading} />
        <div className="pr-detail-tabs" role="tablist" aria-label="Contenuto della partita">
          <button type="button" role="tab" aria-selected={detailView === 'sporting'} onClick={() => setDetailView('sporting')}>Analisi sportiva</button>
          <button type="button" role="tab" aria-selected={detailView === 'bets'} onClick={() => setDetailView('bets')}>Giocate A e C</button>
        </div>
        {detailView === 'sporting' ? <SportingAnalysis error={analysis.analysisError} onRetry={!started && !completed ? vm.handleRefresh : undefined} prediction={pred} teams={selection.teams} match={activeMatchRow} loading={analysis.loading} /> : <section aria-label="Migliori giocate per modello"><p>Le migliori selezioni A e C vengono verificate con quote reali. Se mancano, i grafici restano disponibili ma la giocata non è verificabile.</p>
        {!started && !completed && activeMatchRow && <MatchQuoteRequest key={matchId} match={activeMatchRow} onLoaded={vm.handleRefresh} ready={!analysis.loading} hasQuotes={Object.keys(analysis.odds).length > 0 && Date.now() - Date.parse(pred?.oddsCapturedAt ?? '') <= 5 * 60_000} />}
        <MatchModelAdvice matchId={matchId} fallbackA={aAdvice} coordinator={modelAdvice} registeredFamilies={registeredFamilies} kickoffAt={activeMatchRow?.date} finished={completed} renderActions={renderActions} />
        {vm.manualArchiveOpportunities.length > 0 && <section className="opportunity-alternatives" aria-label="Altre opportunità modello A">
          <header><h2>Altre opportunità A</h2><p>Selezioni con EV positivo e opportunità LOW o speculative da valutare. Puoi scegliere una giocata per modello e partita, oppure archiviare senza puntare.</p></header>
          {vm.manualArchiveOpportunities.map(opportunity => <article key={opportunity.selection} className="opportunity-alternative">
            <header><h3>{opportunity.selectionLabel || fmtSelection(opportunity.selection)}</h3><span>Modello A</span></header>
            <dl><div><dt>Quota reale</dt><dd>{Number(opportunity.bookmakerOdds).toFixed(2)}</dd></div><div><dt>Bookmaker</dt><dd>{opportunity.bookmakerName}</dd></div><div><dt>Mercato</dt><dd>{opportunity.marketName}</dd></div></dl>
            <OpportunityQuality opportunity={opportunity} />
            {renderActions('A', opportunity)}
          </article>)}
        </section>}
        <SavedModelOpportunities matchId={matchId} />
        </section>}
        <details className="pr-card pr-sporting-data"><summary className="pr-card-head">Statistiche osservate della partita</summary><div className="pr-card-body"><p>{actualScore ? `Risultato finale: ${actualScore}` : started ? 'Partita iniziata: risultato ancora da aggiornare.' : 'La partita non è ancora iniziata.'}</p><p>Statistiche osservate, distinte dalle probabilità stimate dai modelli.</p>
          <table><caption className="sr-only">Statistiche osservate della partita</caption><thead><tr><th>Statistica</th><th>Casa</th><th>Ospite</th></tr></thead><tbody>{actualStats.map(([label, home, away]) => <tr key={label}><th>{label}</th><td>{activeMatchRow?.[home] ?? 'Non disponibile'}</td><td>{activeMatchRow?.[away] ?? 'Non disponibile'}</td></tr>)}</tbody></table><p>I valori non disponibili non sono ancora stati rilevati dal provider. Le stime di falli e cartellini sono nell’analisi sportiva.</p>
          {completed && !pred && <button type="button" className="fp-btn fp-btn-ghost fp-btn-sm" disabled={analysis.loading} onClick={() => void handleAnalyze(activeMatchRow, { replay: true })}>Apri replay retrospettivo A</button>}
        </div></details>
      </div>
    </>}
  </div></>;
};
export default PredictionWorkbenchView;
