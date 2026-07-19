import React from 'react';
import OddsSourceBadge from './OddsSourceBadge';
import { fmtSelection, marketTierBadgeClass, marketTierLabel } from './predictionFormatting';
import {
  BestBetAlternative,
  BestValueOpportunity,
  OddsSourceBadgeInfo,
  RecommendedBetResult,
  ReplayTone,
} from './predictionTypes';

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
  suffix = ''
): string => {
  if (value === null || value === undefined || value === '') return 'N/D';
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 'N/D';
  return `${parsed.toFixed(digits)}${suffix}`;
};

const STATUS_LABELS: Record<string, string> = {
  PLAYABLE: 'Giocata consigliata',
  PRUDENT: 'Approccio prudente',
  SPECULATIVE: 'Rischio elevato',
  NO_MARKET: 'Nessuna giocata consigliata',
};

const CONFIDENCE_LABELS: Record<string, string> = {
  HIGH: 'Alta',
  MEDIUM: 'Media',
  LOW: 'Bassa',
};

const BestValueCard: React.FC<BestValueCardProps> = ({
  title = 'Migliore giocata del match',
  opportunity,
  oddsBadge,
  oddsWarning,
  recommendedBetResult,
  replayTone = 'info',
  showConfidence = true,
  emptyMessage = 'Quote o probabilità insufficienti per scegliere una giocata.',
  bestBetStatus,
  bestBetReason,
}) => {
  if (!opportunity) {
    return (
      <section aria-label={title} data-testid="best-value-card" className="pr-decision-report is-empty">
        <div className="pr-decision-report__head">
          <div>
            <div className="pr-decision-report__eyebrow">{title}</div>
            <strong className="pr-decision-report__title">Nessuna giocata consigliata</strong>
          </div>
          <OddsSourceBadge badge={oddsBadge} testId="odds-source-badge" />
        </div>
        <p className="pr-decision-report__summary">{bestBetReason ?? emptyMessage}</p>
        {oddsWarning && <div className="pr-alert pr-alert-warning">{oddsWarning}</div>}
      </section>
    );
  }

  const resolvedStatus =
    bestBetStatus
    ?? opportunity.bestBetStatus
    ?? opportunity.bestBetDecision?.status
    ?? null;
  const resolvedReason =
    bestBetReason
    ?? opportunity.bestBetReason
    ?? opportunity.bestBetDecision?.reason
    ?? null;
  const reasons = Array.isArray(opportunity.humanReasons) ? opportunity.humanReasons : [];
  const warnings = Array.isArray(opportunity.dataWarnings) ? opportunity.dataWarnings.slice(0, 4) : [];
  const riskReasons = Array.isArray(opportunity.riskReasons) ? opportunity.riskReasons.slice(0, 3) : [];
  const confidenceLabel = CONFIDENCE_LABELS[String(opportunity.confidence ?? '')] ?? 'Non disponibile';
  const metrics = [
    {
      id: 'quota-eurobet',
      label: 'Quota Eurobet',
      value: formatMetricNumber(opportunity.bookmakerOdds, 2),
    },
    {
      id: 'probabilita-stimata',
      label: 'Probabilità stimata',
      value: formatMetricNumber(opportunity.ourProbability, 1, '%'),
    },
    {
      id: 'affidabilita',
      label: 'Affidabilità',
      value: confidenceLabel,
    },
    {
      id: 'puntata-suggerita',
      label: 'Puntata suggerita',
      value: formatMetricNumber(opportunity.suggestedStakePercent, 2, '% bankroll'),
    },
  ];
  const statusClass =
    resolvedStatus === 'PLAYABLE'
      ? 'pr-badge-green'
      : resolvedStatus === 'NO_MARKET'
        ? 'pr-badge-gray'
        : 'pr-badge-gold';

  return (
    <section
      className="pr-decision-report"
      aria-label={title}
      data-testid="best-value-card"
    >
      <div className="pr-decision-report__head">
        <div>
          <div className="pr-decision-report__eyebrow">{title}</div>
          <strong className="pr-decision-report__title">
            {opportunity.selectionLabel ?? fmtSelection(opportunity.selection)}
          </strong>
          <p className="pr-decision-report__summary">
            {opportunity.humanSummary ?? 'Questa è la sola giocata finale proposta per il match.'}
          </p>
        </div>
        <div className="pr-decision-report__badges">
          <OddsSourceBadge badge={oddsBadge} testId="odds-source-badge" />
          {resolvedStatus && (
            <span className={`pr-badge ${statusClass}`}>
              {STATUS_LABELS[resolvedStatus] ?? resolvedStatus}
            </span>
          )}
          {showConfidence && opportunity.confidence && (
            <span className={`pr-badge ${
              opportunity.confidence === 'HIGH'
                ? 'pr-badge-green'
                : opportunity.confidence === 'MEDIUM'
                  ? 'pr-badge-blue'
                  : 'pr-badge-gold'
            }`}>
              Affidabilità {confidenceLabel.toLowerCase()}
            </span>
          )}
          <span className={`pr-badge ${marketTierBadgeClass(opportunity.marketTier)}`}>
            {marketTierLabel(opportunity.marketTier)}
          </span>
        </div>
      </div>

      <dl className="pr-decision-report__metrics">
        {metrics.map(({ id, label, value }) => (
          <div key={id} className="pr-decision-report__metric">
            <dt>{label}</dt>
            <dd data-testid={`best-value-metric-${id}`}>{value}</dd>
          </div>
        ))}
      </dl>

      <div className="pr-decision-report__body">
        {recommendedBetResult && (
          <div className={`pr-alert pr-alert-${replayTone}`}>
            <strong>{recommendedBetResult.status}</strong>
            {recommendedBetResult.reason ? <><br />{recommendedBetResult.reason}</> : null}
          </div>
        )}

        <div className="pr-decision-report__market">
          <span>Mercato</span>
          <strong>{opportunity.marketName}</strong>
        </div>

        {resolvedReason && (
          <div className={`pr-alert pr-alert-${
            resolvedStatus === 'PLAYABLE'
              ? 'success'
              : resolvedStatus === 'NO_MARKET'
                ? 'info'
                : 'warning'
          }`}>
            {resolvedReason}
          </div>
        )}

        {(warnings.length > 0 || riskReasons.length > 0) && (
          <div className="pr-decision-report__risks" aria-label="Rischi e limiti">
            <strong>Rischi e limiti</strong>
            <ul>
              {[...riskReasons, ...warnings].map((warning) => (
                <li key={warning}>{warning.replace(/_/g, ' ')}</li>
              ))}
            </ul>
          </div>
        )}

        {reasons.length > 0 && (
          <div className="pr-decision-report__reasons">
            <strong>Perché viene proposta</strong>
            <ul>
              {reasons.map((reason, index) => (
                <li key={`${opportunity.selection}_reason_${index}`}>{reason}</li>
              ))}
            </ul>
          </div>
        )}

        {oddsWarning && <div className="pr-alert pr-alert-warning">{oddsWarning}</div>}
      </div>
    </section>
  );
};

export default BestValueCard;
