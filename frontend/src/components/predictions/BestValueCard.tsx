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
    return <div className="pr-info">{emptyMessage}</div>;
  }

  const reasons = Array.isArray(opportunity.humanReasons) ? opportunity.humanReasons : [];

  return (
    <section className="pr-info" aria-label={title} data-testid="best-value-card">
      <strong>{opportunity.selectionLabel ?? fmtSelection(opportunity.selection)}</strong>
      <br />
      Quota consigliata: <strong>{Number(opportunity.bookmakerOdds ?? 0).toFixed(2)}</strong>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
        {showConfidence && opportunity.confidence && (
          <span className={`pr-badge ${opportunity.confidence === 'HIGH' ? 'pr-badge-green' : opportunity.confidence === 'MEDIUM' ? 'pr-badge-blue' : 'pr-badge-gold'}`}>
            {opportunity.confidence}
          </span>
        )}
        <span className={`pr-badge ${marketTierBadgeClass(opportunity.marketTier)}`}>
          {marketTierLabel(opportunity.marketTier)}
        </span>
        <OddsSourceBadge badge={oddsBadge} testId="odds-source-badge" />
      </div>
      {recommendedBetResult && (
        <div className={`pr-alert pr-alert-${replayTone}`} style={{ marginTop: 12, marginBottom: 0 }}>
          <strong>{recommendedBetResult.status}</strong>
          {recommendedBetResult.reason ? (
            <>
              <br />
              {recommendedBetResult.reason}
            </>
          ) : null}
        </div>
      )}
      <div style={{ marginTop: 12 }}>{opportunity.humanSummary ?? 'Questa e la giocata finale consigliata per la lettura complessiva del match.'}</div>
      {reasons.length > 0 && (
        <div style={{ marginTop: 12 }}>
          <strong>Perche questa scelta</strong>
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
    </section>
  );
};

export default BestValueCard;
