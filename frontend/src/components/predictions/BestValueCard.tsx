import React from 'react';
import OddsSourceBadge from './OddsSourceBadge';
import { fmtSelection, marketTierBadgeClass, marketTierLabel } from './predictionFormatting';
import { BestValueOpportunity, OddsSourceBadgeInfo, RecommendedBetResult, ReplayTone } from './predictionTypes';

interface BestValueCardProps {
  title?: string;
  opportunity: BestValueOpportunity | null;
  oddsBadge: OddsSourceBadgeInfo;
  oddsWarning?: string | null;
  recommendedBetResult?: RecommendedBetResult | null;
  replayTone?: ReplayTone;
  showConfidence?: boolean;
  emptyMessage?: string;
}

const BestValueCard: React.FC<BestValueCardProps> = ({
  title = 'Pronostico Finale Consigliato',
  opportunity,
  oddsBadge,
  oddsWarning,
  recommendedBetResult,
  replayTone = 'info',
  showConfidence = true,
  emptyMessage = 'Nessun pronostico finale consigliato: per questa partita non c e una giocata abbastanza solida.',
}) => {
  if (!opportunity) {
    return (
      <section aria-label={title} data-testid="best-value-card">
        {oddsWarning && (
          <div className="pr-alert pr-alert-warning" style={{ marginBottom: 12 }}>
            {oddsWarning}
          </div>
        )}
        <div className="pr-info">{emptyMessage}</div>
      </section>
    );
  }

  const reasons = Array.isArray(opportunity.humanReasons) ? opportunity.humanReasons : [];
  const metrics = [
    ['Quota', Number(opportunity.bookmakerOdds ?? 0).toFixed(2)],
    ['Probabilita nostra', `${Number(opportunity.ourProbability ?? 0).toFixed(1)}%`],
    ['Probabilita implicita', `${Number(opportunity.impliedProbability ?? 0).toFixed(1)}%`],
    ['EV', `+${Number(opportunity.expectedValue ?? 0).toFixed(1)}%`],
    ['Edge', `+${Number(opportunity.edge ?? 0).toFixed(1)}%`],
    ['Stake base', `${Number(opportunity.suggestedStakePercent ?? 0).toFixed(2)}%`],
  ];

  return (
    <section
      className="pr-info"
      aria-label={title}
      data-testid="best-value-card"
      style={{ padding: 0, overflow: 'hidden' }}
    >
      <div style={{ padding: '18px 18px 0' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
          <div>
            <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--text-2)' }}>
              Migliore giocata
            </div>
            <strong style={{ display: 'block', marginTop: 6, fontSize: 22, lineHeight: 1.15, color: 'var(--text)' }}>
              {opportunity.selectionLabel ?? fmtSelection(opportunity.selection)}
            </strong>
            <div style={{ marginTop: 8, color: 'var(--text-2)' }}>
              {opportunity.humanSummary ?? 'Questa e la giocata finale consigliata per la lettura complessiva del match.'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
            <OddsSourceBadge badge={oddsBadge} testId="odds-source-badge" />
            {showConfidence && opportunity.confidence && (
              <span className={`pr-badge ${opportunity.confidence === 'HIGH' ? 'pr-badge-green' : opportunity.confidence === 'MEDIUM' ? 'pr-badge-blue' : 'pr-badge-gold'}`}>
                {opportunity.confidence}
              </span>
            )}
            <span className={`pr-badge ${marketTierBadgeClass(opportunity.marketTier)}`}>
              {marketTierLabel(opportunity.marketTier)}
            </span>
          </div>
        </div>
      </div>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
          gap: 1,
          marginTop: 16,
          background: 'var(--border)',
          borderTop: '1px solid var(--border)',
          borderBottom: '1px solid var(--border)',
        }}
      >
        {metrics.map(([label, value]) => (
          <div key={label} style={{ background: 'var(--surface)', padding: '12px 14px' }}>
            <div style={{ fontSize: 10, fontWeight: 800, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--text-3)', marginBottom: 4 }}>
              {label}
            </div>
            <div style={{ fontFamily: 'DM Mono, monospace', fontSize: 15, fontWeight: 700, color: 'var(--text)' }}>
              {value}
            </div>
          </div>
        ))}
      </div>

      <div style={{ padding: 18 }}>
        {recommendedBetResult && (
          <div className={`pr-alert pr-alert-${replayTone}`} style={{ marginTop: 0, marginBottom: 12 }}>
            <strong>{recommendedBetResult.status}</strong>
            {recommendedBetResult.reason ? (
              <>
                <br />
                {recommendedBetResult.reason}
              </>
            ) : null}
          </div>
        )}

        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
          <span className="pr-badge pr-badge-blue">{opportunity.marketName}</span>
          {!showConfidence && opportunity.confidence && (
            <span className={`pr-badge ${opportunity.confidence === 'HIGH' ? 'pr-badge-green' : opportunity.confidence === 'MEDIUM' ? 'pr-badge-blue' : 'pr-badge-gold'}`}>
              Confidenza {opportunity.confidence}
            </span>
          )}
        </div>

        {reasons.length > 0 && (
          <div style={{ marginTop: 0 }}>
            <strong>Motivi della pick</strong>
            <ul style={{ margin: '8px 0 0 18px', padding: 0 }}>
              {reasons.map((reason, index) => (
                <li key={`${opportunity.selection}_reason_${index}`}>{reason}</li>
              ))}
            </ul>
          </div>
        )}

        {oddsWarning && (
          <div className="pr-alert pr-alert-warning" style={{ marginTop: 12, marginBottom: 0 }}>
            {oddsWarning}
          </div>
        )}
      </div>
    </section>
  );
};

export default BestValueCard;
