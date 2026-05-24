import React from 'react';
import OddsSourceBadge from './OddsSourceBadge';
import { fmtSelection, marketTierBadgeClass, marketTierLabel } from './predictionFormatting';
import { BestBetAlternative, BestValueOpportunity, OddsSourceBadgeInfo, RecommendedBetResult, ReplayTone } from './predictionTypes';

interface BestValueCardProps {
  title?: string;
  opportunity: BestValueOpportunity | null;
  oddsBadge: OddsSourceBadgeInfo;
  oddsWarning?: string | null;
  recommendedBetResult?: RecommendedBetResult | null;
  replayTone?: ReplayTone;
  showConfidence?: boolean;
  emptyMessage?: string;
  bestBetStatus?: string | null;
  bestBetReason?: string | null;
  bestBetAlternatives?: BestBetAlternative[];
}

const formatMetricNumber = (
  value: number | string | undefined,
  digits: number,
  suffix = '',
  prefix = ''
): string => {
  if (value === null || value === undefined || value === '') return 'N/D';
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 'N/D';
  return `${prefix}${parsed.toFixed(digits)}${suffix}`;
};

const BestValueCard: React.FC<BestValueCardProps> = ({
  title = 'Migliore giocata del match',
  opportunity,
  oddsBadge,
  oddsWarning,
  recommendedBetResult,
  replayTone = 'info',
  showConfidence = true,
  emptyMessage = 'Nessun pronostico finale consigliato: per questa partita non c e una giocata abbastanza solida.',
  bestBetStatus,
  bestBetReason,
  bestBetAlternatives,
}) => {
  const resolvedAlternatives =
    bestBetAlternatives ??
    opportunity?.bestBetAlternatives ??
    opportunity?.bestBetDecision?.comparedAlternatives ??
    [];

  const renderAlternatives = (alternatives: BestBetAlternative[]) => {
    if (!Array.isArray(alternatives) || alternatives.length === 0) return null;
    return (
      <div style={{ marginTop: 14 }}>
        <strong>Alternative valutate</strong>
        <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
          {alternatives.slice(0, 4).map((alternative) => (
            <div
              key={`${alternative.selection}_${alternative.marketName ?? ''}`}
              style={{
                display: 'grid',
                gridTemplateColumns: 'minmax(140px, 1.2fr) repeat(3, minmax(70px, .6fr))',
                gap: 8,
                alignItems: 'center',
                padding: '8px 10px',
                border: '1px solid var(--border)',
                borderRadius: 9,
                background: 'var(--surface)',
              }}
            >
              <span style={{ fontWeight: 800, color: 'var(--text)' }}>{fmtSelection(alternative.selection)}</span>
              <span style={{ fontFamily: 'DM Mono, monospace' }}>EV {formatMetricNumber(alternative.expectedValue, 1, '%', '+')}</span>
              <span style={{ fontFamily: 'DM Mono, monospace' }}>Edge {formatMetricNumber(alternative.edgeNoVig, 1, '%', '+')}</span>
              <span style={{ fontFamily: 'DM Mono, monospace' }}>Score {formatMetricNumber(alternative.riskAdjustedScore, 2)}</span>
              {alternative.reason && (
                <span style={{ gridColumn: '1 / -1', color: 'var(--text-2)', fontSize: 11 }}>
                  {alternative.reason.replace(/_/g, ' ')}
                </span>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  };

  if (!opportunity) {
    return (
      <section aria-label={title} data-testid="best-value-card">
        {oddsWarning && (
          <div className="pr-alert pr-alert-warning" style={{ marginBottom: 12 }}>
            {oddsWarning}
          </div>
        )}
        <div className="pr-alert pr-alert-warning">
          <strong>Match da saltare</strong>
          <br />
          {bestBetReason ?? emptyMessage}
        </div>
        {renderAlternatives(resolvedAlternatives)}
      </section>
    );
  }

  const resolvedStatus =
    bestBetStatus ??
    opportunity.bestBetStatus ??
    opportunity.bestBetDecision?.status ??
    null;
  const resolvedReason =
    bestBetReason ??
    opportunity.bestBetReason ??
    opportunity.bestBetDecision?.reason ??
    null;
  const reasons = Array.isArray(opportunity.humanReasons) ? opportunity.humanReasons : [];
  const warnings = Array.isArray(opportunity.dataWarnings) ? opportunity.dataWarnings.slice(0, 4) : [];
  const riskReasons = Array.isArray(opportunity.riskReasons) ? opportunity.riskReasons.slice(0, 3) : [];
  const metrics = [
    ['Quota', formatMetricNumber(opportunity.bookmakerOdds, 2)],
    ['Probabilita nostra', formatMetricNumber(opportunity.ourProbability, 1, '%')],
    ['Probabilita implicita', formatMetricNumber(opportunity.impliedProbability, 1, '%')],
    ['EV', formatMetricNumber(opportunity.expectedValue, 1, '%', '+')],
    ['Edge', formatMetricNumber(opportunity.edge, 1, '%', '+')],
    ['Edge no-vig', formatMetricNumber(opportunity.edgeNoVig, 1, '%', '+')],
    ['Score rischio', formatMetricNumber(opportunity.riskAdjustedBestScore ?? opportunity.bestBetDecision?.riskAdjustedScore, 2)],
    ['Stake base', formatMetricNumber(opportunity.suggestedStakePercent, 2, '%')],
  ];
  const statusClass =
    resolvedStatus === 'PLAYABLE'
      ? 'pr-badge-green'
      : resolvedStatus === 'PRUDENT'
        ? 'pr-badge-gold'
        : resolvedStatus === 'NO_BET'
          ? 'pr-badge-gray'
          : 'pr-badge-blue';

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
              Migliore giocata del match
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
            {resolvedStatus && (
              <span className={`pr-badge ${statusClass}`}>
                {resolvedStatus}
              </span>
            )}
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
            <div
              data-testid={`best-value-metric-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`}
              style={{ fontFamily: 'DM Mono, monospace', fontSize: 15, fontWeight: 700, color: 'var(--text)' }}
            >
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

        {resolvedReason && (
          <div className={`pr-alert pr-alert-${resolvedStatus === 'PLAYABLE' ? 'success' : 'warning'}`} style={{ marginTop: 0, marginBottom: 12 }}>
            {resolvedReason}
          </div>
        )}

        {(warnings.length > 0 || riskReasons.length > 0) && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
            {riskReasons.map((reason) => (
              <span key={`risk_${reason}`} className="pr-badge pr-badge-gold">{reason}</span>
            ))}
            {warnings.map((warning) => (
              <span key={`warning_${warning}`} className="pr-badge pr-badge-gold">
                {warning === 'over_cards_close_to_line'
                  ? 'Over cartellini fragile'
                  : warning === 'under_cards_close_to_line'
                    ? 'Under cartellini fragile'
                    : warning === 'under_goals_close_to_line'
                      ? 'Under goal vicino alla linea'
                      : warning === 'btts_no_fragile'
                        ? 'No Goal fragile'
                        : warning === 'missing_referee_data'
                          ? 'Dati arbitro assenti'
                          : warning === 'low_disciplinary_risk_for_over_cards'
                            ? 'Rischio cartellini basso'
                            : warning.replace(/_/g, ' ')}
              </span>
            ))}
          </div>
        )}

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

        {renderAlternatives(resolvedAlternatives)}

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
