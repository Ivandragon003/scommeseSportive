import React from 'react';
import { fmtPct } from './predictionFormatting';
import { GoalProbabilitiesSummary, ReplayTone } from './predictionTypes';

interface PredictionHeroProps {
  homeTeam: string;
  awayTeam: string;
  lambdaHome: number | string;
  lambdaAway: number | string;
  modelConfidence: number;
  dataQuality?: {
    teamHistory?: { home?: any; away?: any };
    components?: Record<string, { available: boolean | null; label: string; detail: string }>;
    marketRelevance?: { required?: string[]; missing?: string[]; note?: string; cap?: string | null };
  } | null;
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
  dataQuality,
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
    <section className="pr-hero" aria-label={`${homeTeam} contro ${awayTeam}`}>
      <div className="pr-hero-team">
        <span className="pr-hero-role">Casa</span>
        <div className="pr-hero-name">{homeTeam}</div>
        <div className="pr-hero-stat">
          <span>Gol attesi</span><strong>{lambdaHome}</strong>
        </div>
      </div>
      <div className="pr-hero-center">
        <div className="pr-hero-vs">VS</div>
        <div className="pr-confidence">
          <span>Affidabilità modello</span><strong>{(modelConfidence * 100).toFixed(0)}%</strong>
        </div>
        {actualScore && <div className="pr-hero-final">Finale {actualScore}</div>}
      </div>
      <div className="pr-hero-team right">
        <span className="pr-hero-role">Ospite</span>
        <div className="pr-hero-name">{awayTeam}</div>
        <div className="pr-hero-stat">
          <span>Gol attesi</span><strong>{lambdaAway}</strong>
        </div>
      </div>
    </section>
    {dataQuality && (
      <section className="pr-data-quality" aria-label="Trasparenza dati">
        <div className="pr-data-quality-head">
          <div><div className="pr-sec">Trasparenza dati</div><h3>Copertura e dati rilevanti</h3></div>
          <span className="pr-data-quality-caption">La percentuale sopra misura la ricchezza generale del contesto.</span>
        </div>
        <div className="pr-data-quality-history">
          {[{ key: 'home', label: 'Casa', value: dataQuality.teamHistory?.home }, { key: 'away', label: 'Ospite', value: dataQuality.teamHistory?.away }].map((item) => {
            const coverage = item.value?.coveragePercent;
            const percent = Number.isFinite(Number(coverage)) ? `${Number(coverage).toFixed(0)}%` : 'N/D';
            const seasons = item.value ? `${item.value.seasonsAvailable ?? 0}/${item.value.seasonsExpected ?? 0} stagioni` : 'Dati non disponibili';
            return <div className="pr-data-history-item" key={item.key}><span>{item.label}</span><strong>{percent}</strong><small>{seasons}</small></div>;
          })}
        </div>
        <div className="pr-data-quality-market">
          <div className="pr-data-quality-title">Dati usati per questo mercato</div>
          <div className="pr-data-quality-components">
            {Object.entries(dataQuality.components ?? {}).map(([key, component]) => {
              const status = component.available === true ? 'available' : component.available === false ? 'missing' : 'unknown';
              return <div className={`pr-data-chip is-${status}`} key={key}><span>{component.label}</span><small>{status === 'available' ? 'Disponibile' : status === 'missing' ? 'Mancante' : 'Non verificato'}</small></div>;
            })}
          </div>
          <p className="pr-data-quality-note">
            {dataQuality.marketRelevance?.note}
            {dataQuality.marketRelevance?.cap ? ` Affidabilità massima per questo mercato: ${dataQuality.marketRelevance.cap}.` : ''}
          </p>
        </div>
      </section>
    )}
    {goalProbabilities && (
      <div className="pr-kpi-row">
        {[
          { label: '1 Casa', value: fmtPct(goalProbabilities.homeWin), color: 'var(--primary)' },
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
