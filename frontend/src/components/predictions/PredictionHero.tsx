import React from 'react';
import { fmtPct } from './predictionFormatting';
import { GoalProbabilitiesSummary, ReplayTone } from './predictionTypes';

interface PredictionHeroProps {
  homeTeam: string;
  awayTeam: string;
  lambdaHome: number | string;
  lambdaAway: number | string;
  modelConfidence: number;
  actualScore?: string | null;
  goalProbabilities?: GoalProbabilitiesSummary | null;
  replaySummary?: {
    tone: ReplayTone;
    text: string;
  } | null;
}

const PredictionHero: React.FC<PredictionHeroProps> = ({
  homeTeam,
  awayTeam,
  lambdaHome,
  lambdaAway,
  modelConfidence,
  actualScore,
  goalProbabilities,
  replaySummary,
}) => (
  <>
    {replaySummary && (
      <div style={{ margin: '0 20px 12px' }}>
        <div className={`pr-alert pr-alert-${replaySummary.tone}`}>{replaySummary.text}</div>
      </div>
    )}
    <div className="pr-hero">
      <div className="pr-hero-team">
        <div className="pr-hero-name">{homeTeam}</div>
        <div className="pr-hero-lambda">lambda = {lambdaHome}</div>
      </div>
      <div className="pr-hero-center">
        <div className="pr-hero-vs">VS</div>
        <div className="pr-confidence">{(modelConfidence * 100).toFixed(0)}% conf.</div>
        {actualScore && <div className="pr-hero-lambda" style={{ marginTop: 8 }}>finale {actualScore}</div>}
      </div>
      <div className="pr-hero-team right">
        <div className="pr-hero-name">{awayTeam}</div>
        <div className="pr-hero-lambda">lambda = {lambdaAway}</div>
      </div>
    </div>
    {goalProbabilities && (
      <div className="pr-kpi-row">
        {[
          { label: '1 Casa', value: fmtPct(goalProbabilities.homeWin), color: 'var(--blue)' },
          { label: 'X Pari', value: fmtPct(goalProbabilities.draw), color: 'var(--text-2)' },
          { label: '2 Ospite', value: fmtPct(goalProbabilities.awayWin), color: 'var(--red)' },
        ].map((item) => (
          <div className="pr-kpi" key={item.label}>
            <div className="pr-kpi-val" style={{ color: item.color }}>
              {item.value}
            </div>
            <div className="pr-kpi-lbl">{item.label}</div>
          </div>
        ))}
      </div>
    )}
  </>
);

export default PredictionHero;
