import React from 'react';
import { decisionReason } from '../../features/research/researchPresentation';
import OddsSourceBadge from './OddsSourceBadge';
import { fmtSelection, marketTierBadgeClass, marketTierLabel } from './predictionFormatting';
import { formatKickoff, formatMarketKey, isTechnicalRecommendationAbstention } from './predictionWorkbenchUtils';
import {
  AutomaticRecommendationProjection,
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
  automaticRecommendation?: AutomaticRecommendationProjection | null;
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
  automaticRecommendation,
}) => {
  const technicalAbstention = isTechnicalRecommendationAbstention(automaticRecommendation) ? automaticRecommendation : null;
  const automaticNotice = technicalAbstention ? (
    <div className="pr-alert pr-alert-warning" aria-label="Decisione Nightly A">
      <strong>Astensione tecnica della Nightly A</strong>
      <p>Valutazione non completata. Motivo: {decisionReason(technicalAbstention.reason)}</p>
      <p>Importo registrato nel portafoglio virtuale A: EUR 0.00. Nessuna puntata registrata.</p>
      <p>Valutata il {formatKickoff(technicalAbstention.asOf)}. Quota della decisione non disponibile.</p>
    </div>
  ) : automaticRecommendation ? (
    <div className="pr-alert pr-alert-info" aria-label="Decisione Nightly A">
      <strong>Decisione Nightly del portafoglio virtuale A</strong>
      <p>
        Importo registrato: EUR {Number(automaticRecommendation.actualStakeAmount ?? 0).toFixed(2)}.
        {' '}Stato: {({ OPEN: 'In corso', WON: 'Vinta', LOST: 'Persa', VOID: 'Annullata',
          BET: 'Registrata', ABSTAIN: 'Nessuna puntata', SKIPPED: 'Non registrata' } as Record<string, string>)[automaticRecommendation.status]
          ?? automaticRecommendation.status}.
      </p>
      <p>Quota rilevata il {formatKickoff(automaticRecommendation.odds?.capturedAt ?? undefined)}: prezzo archiviato, non quota corrente.</p>
      {automaticRecommendation.placedAt && Number(automaticRecommendation.actualStakeAmount) > 0 && (
        <p>Registrata il {formatKickoff(automaticRecommendation.placedAt)}.</p>
      )}
    </div>
  ) : null;
  if (!opportunity || technicalAbstention) {
    return (
      <section aria-label={title} data-testid="best-value-card" className="pr-decision-report is-empty">
        <div className="pr-decision-report__head">
          <div>
            <div className="pr-decision-report__eyebrow">{title}</div>
            <strong className="pr-decision-report__title">{technicalAbstention ? 'Valutazione Nightly non completata' : 'Nessuna giocata consigliata'}</strong>
          </div>
          <OddsSourceBadge badge={technicalAbstention
            ? { label: 'Quota Nightly non disponibile', className: 'pr-badge-gray' }
            : oddsBadge} testId="odds-source-badge" />
        </div>
        <p className="pr-decision-report__summary">{technicalAbstention
          ? 'La Nightly non ha completato una previsione utilizzabile per questa partita.'
          : bestBetReason ?? emptyMessage}</p>
        {automaticNotice}
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
  const opportunityBookmaker = String(opportunity.bookmakerName ?? '').trim();
  const resolvedOddsBadge = opportunityBookmaker
    ? { label: `${automaticRecommendation ? 'Quota archiviata' : 'Quota bookmaker verificata'}: ${opportunityBookmaker}`, className: 'pr-badge-green' }
    : oddsBadge;
  const metrics = [
    {
      id: 'quota-bookmaker',
      label: 'Quota bookmaker',
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
      label: automaticRecommendation ? 'Puntata virtuale registrata' : 'Puntata suggerita',
      value: automaticRecommendation
        ? `EUR ${Number(automaticRecommendation.actualStakeAmount ?? 0).toFixed(2)}`
        : formatMetricNumber(opportunity.suggestedStakePercent, 2, '% bankroll'),
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
          <OddsSourceBadge badge={resolvedOddsBadge} testId="odds-source-badge" />
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
        {automaticNotice}
        {recommendedBetResult && (
          <div className={`pr-alert pr-alert-${replayTone}`}>
            <strong>{recommendedBetResult.status}</strong>
            {recommendedBetResult.reason ? <><br />{recommendedBetResult.reason}</> : null}
          </div>
        )}

        <div className="pr-decision-report__market">
          <span>Mercato</span>
          <strong>{formatMarketKey(opportunity.marketName)}</strong>
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
