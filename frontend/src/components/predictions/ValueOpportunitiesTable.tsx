import React from 'react';
import { fmtSelection, marketTierBadgeClass, marketTierLabel } from './predictionFormatting';
import { BestValueOpportunity, RecommendedBetResult, ReplayTone } from './predictionTypes';
import { formatMarketKey } from './predictionWorkbenchUtils';

interface ValueOpportunitiesTableProps {
  opportunities: BestValueOpportunity[];
  recommendedOpportunity?: BestValueOpportunity | null;
  bankroll: number;
  budgetReady: boolean;
  isReplayAnalysis: boolean;
  oddsSource?: string | null;
  oddsBookmaker?: string | null;
  providerWarning?: string | null;
  placedBetKeySet: Set<string>;
  recommendedBetResult?: RecommendedBetResult | null;
  replayOutcomeTone: ReplayTone;
  stakes: Record<string, string>;
  getStakeKey: (opportunity: BestValueOpportunity) => string;
  getStakeValue: (opportunity: BestValueOpportunity) => number;
  onStakeChange: (stakeKey: string, value: string) => void;
  onBet: (opportunity: BestValueOpportunity) => void;
  manualArchiveOpportunities?: BestValueOpportunity[];
  archivedOpportunityKeys?: Set<string>;
  onArchive?: (opportunity: BestValueOpportunity) => void;
}

const valueWarningLabel = (warning: string): string | null => {
  switch (warning) {
    case 'under_cards_close_to_line':
      return 'Under cartellini fragile: previsione vicina alla linea';
    case 'over_cards_close_to_line':
      return 'Over cartellini fragile: previsione vicina alla linea';
    case 'low_disciplinary_risk_for_over_cards':
      return 'Partita poco disciplinare: Over cartellini penalizzato';
    case 'lenient_referee_against_over_cards':
      return 'Arbitro permissivo: Over cartellini penalizzato';
    case 'under_goals_close_to_line':
      return 'Under goal fragile: expected goals vicini alla linea';
    case 'btts_no_fragile':
      return 'No Goal fragile';
    case 'both_teams_goal_risk':
      return 'Rischio goal per entrambe';
    case 'weak_xg_data_for_under':
      return 'Dati xG deboli per Under';
    case 'high_intensity_match':
      return 'Partita ad alta intensita';
    case 'missing_referee_data':
    case 'low_referee_sample':
      return 'Dati arbitro assenti o deboli';
    case 'strict_referee_against_under_cards':
      return 'Arbitro severo: Under penalizzato';
    case 'data_quality_weak':
      return 'Dati deboli';
    case 'market_blending_applied':
      return 'Probabilita corretta dal mercato';
    case 'positive_edge_no_vig':
      return 'Buon edge no-vig';
    case 'market_calibration_applied':
      return 'Calibrazione mercato applicata';
    default:
      return null;
  }
};

const ValueOpportunitiesTable: React.FC<ValueOpportunitiesTableProps> = ({
  opportunities,
  recommendedOpportunity,
  bankroll,
  budgetReady,
  isReplayAnalysis,
  oddsSource,
  oddsBookmaker,
  providerWarning,
  placedBetKeySet,
  recommendedBetResult,
  replayOutcomeTone,
  stakes,
  getStakeKey,
  getStakeValue,
  onStakeChange,
  onBet,
  manualArchiveOpportunities = [],
  archivedOpportunityKeys = new Set<string>(),
  onArchive,
}) => {
  const hasVerifiedRealBookmakerOdds = oddsSource === 'odds_api' && Boolean(String(oddsBookmaker ?? '').trim());
  const visibleOpportunities = hasVerifiedRealBookmakerOdds ? opportunities : [];
  const oddsUnavailable = !hasVerifiedRealBookmakerOdds;
  const emptyMessage =
    oddsUnavailable
      ? 'Quota bookmaker non disponibile per questa partita.'
      : 'Nessuna giocata supera i criteri operativi.';
  const archiveClassification = (opportunity: BestValueOpportunity): 'LOW' | 'SPECULATIVE' | null => {
    const status = String(opportunity.bestBetStatus ?? opportunity.bestBetDecision?.status ?? '').toUpperCase();
    const tier = String(opportunity.marketTier ?? '').toUpperCase();
    if (status === 'SPECULATIVE' || tier === 'SPECULATIVE') return 'SPECULATIVE';
    return String(opportunity.confidence ?? '').toUpperCase() === 'LOW' ? 'LOW' : null;
  };
  const archiveOnlyOpportunities = manualArchiveOpportunities.filter((opportunity) =>
    archiveClassification(opportunity)
    && !visibleOpportunities.some((visible) => getStakeKey(visible) === getStakeKey(opportunity))
  );

  return (
    <div data-testid="value-opportunities-table">
      {!budgetReady && <div className="pr-alert pr-alert-warning">ATTENZIONE: inizializza il bankroll in Budget Manager.</div>}
      {providerWarning && <div className="pr-alert pr-alert-warning">{providerWarning}</div>}
      {isReplayAnalysis && (
        <div className="pr-alert pr-alert-warning">
          Modalita replay: quote ricostruite dal modello e puntata disabilitata su partite gia concluse.
        </div>
      )}

      {visibleOpportunities.length === 0 && archiveOnlyOpportunities.length === 0 ? (
        <div className="pr-info" style={{ textAlign: 'center', padding: '32px 0' }}>
          {emptyMessage}
          <br />
          <span style={{ color: 'var(--text-3)', fontSize: 11 }}>
            {oddsUnavailable
              ? 'Le quote di fallback restano interne: il sistema non mostra prezzi alternativi e non abilita la registrazione.'
              : 'La quota è disponibile, ma probabilità, rischio o margine non giustificano una puntata.'}
          </span>
        </div>
      ) : (
        <>
          {visibleOpportunities.length > 0 && <>
            <div className="pr-alert pr-alert-success">
              <strong>{visibleOpportunities.length}</strong> selezioni superano i criteri di confronto
            </div>
            <div className="pr-alert pr-alert-info">
              Confronto completo mercati: la migliore giocata resta quella evidenziata in alto. Qui sotto vedi solo alternative e confronto operativo.
            </div>
          </>}
          {visibleOpportunities.map((opportunity) => {
            const stakeKey = getStakeKey(opportunity);
            const isRecommended = Boolean(
              recommendedOpportunity &&
              String(recommendedOpportunity.selection ?? '') === String(opportunity.selection ?? '') &&
              String(recommendedOpportunity.marketName ?? '') === String(opportunity.marketName ?? '')
            );
            const currentStake = getStakeValue(opportunity);
            const currentStakePct = bankroll > 0 ? (currentStake / bankroll) * 100 : 0;
            const suggestedAmount = bankroll > 0 ? (Number(opportunity.suggestedStakePercent ?? 0) / 100) * bankroll : 0;
            const alreadyPlaced = placedBetKeySet.has(stakeKey);
            const classification = archiveClassification(opportunity);
            const alreadyArchived = archivedOpportunityKeys.has(stakeKey);
            const isRecommendedReplaySelection =
              String(recommendedBetResult?.selection ?? '') === String(opportunity.selection ?? '');
            const warningLabels = Array.from(
              new Set((opportunity.dataWarnings ?? []).map(valueWarningLabel).filter(Boolean))
            ) as string[];

            return (
              <div
                key={stakeKey}
                className={`pr-vb${opportunity.confidence === 'MEDIUM' ? ' medium' : opportunity.confidence === 'LOW' ? ' low' : ''}`}
              >
                <div className="pr-vb-top">
                  <div>
                    <div className="pr-vb-market">{formatMarketKey(opportunity.marketName)}</div>
                    <div className="pr-vb-market-sub">{fmtSelection(String(opportunity.selection))}</div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      {isRecommended && (
                        <span className="pr-badge pr-badge-green">Consigliata</span>
                      )}
                      {opportunity.bookmakerName && (
                        <span className="pr-badge pr-badge-gray">{opportunity.bookmakerName}</span>
                      )}
                      {opportunity.confidence && (
                        <span
                          className={`pr-badge ${opportunity.confidence === 'HIGH' ? 'pr-badge-green' : opportunity.confidence === 'MEDIUM' ? 'pr-badge-blue' : 'pr-badge-gold'}`}
                        >
                          {opportunity.confidence}
                        </span>
                      )}
                      <span className={`pr-badge ${marketTierBadgeClass(opportunity.marketTier)}`}>
                        {marketTierLabel(opportunity.marketTier)}
                      </span>
                    </div>
                  </div>
                  <div>
                    <div className="pr-vb-ev-num">+{opportunity.expectedValue}%</div>
                    <div className="pr-vb-ev-lbl">EV</div>
                  </div>
                </div>
                <div className="pr-vb-stats">
                  {[
                    { label: 'P. Nostra', value: `${opportunity.ourProbability}%` },
                    { label: 'P. Implicita', value: `${opportunity.impliedProbability}%` },
                    { label: 'Edge', value: `+${opportunity.edge}%` },
                    { label: 'Quota', value: opportunity.bookmakerOdds },
                    { label: 'Kelly 1/4', value: `${opportunity.kellyFraction}%` },
                  ].map((entry) => (
                    <div className="pr-vb-stat" key={entry.label}>
                      <div className="pr-vb-stat-lbl">{entry.label}</div>
                      <div className="pr-vb-stat-val">{entry.value}</div>
                    </div>
                  ))}
                </div>
                {warningLabels.length > 0 && (
                  <div className="pr-alert pr-alert-warning" style={{ marginTop: 12 }}>
                    {warningLabels.join(' - ')}
                  </div>
                )}
                <div className="pr-vb-bottom">
                  <div className="pr-stake-wrap">
                    <span className="pr-stake-lbl">Puntata EUR</span>
                    <input
                      className="pr-stake-input"
                      type="number"
                      min={1}
                      step={0.1}
                      value={stakes[stakeKey] ?? ''}
                      placeholder={suggestedAmount > 0 ? suggestedAmount.toFixed(2) : '1.00'}
                      disabled={isReplayAnalysis}
                      onChange={(event) => onStakeChange(stakeKey, event.target.value)}
                    />
                    {budgetReady && (
                      <span className="pr-suggest">
                        <span>{currentStake > 0 ? `attuale ${currentStakePct.toFixed(1)}% budget` : 'attuale 0.0% budget'}</span>
                        <span>
                          sugg. EUR {suggestedAmount.toFixed(2)} ({Number(opportunity.suggestedStakePercent ?? 0).toFixed(2)}% budget)
                        </span>
                      </span>
                    )}
                  </div>
                  {isReplayAnalysis ? (
                    <span
                      className={`pr-badge ${
                        isRecommendedReplaySelection
                          ? `pr-badge-${replayOutcomeTone === 'danger' ? 'gold' : replayOutcomeTone === 'success' ? 'green' : replayOutcomeTone === 'warning' ? 'gold' : 'gray'}`
                          : 'pr-badge-gray'
                      }`}
                    >
                      {isRecommendedReplaySelection ? `Esito ${recommendedBetResult?.status ?? 'n/d'}` : 'Solo analisi'}
                    </span>
                  ) : alreadyPlaced ? (
                    <span className="pr-badge pr-badge-green">Scommessa gia fatta</span>
                  ) : (
                    <>
                      {classification && onArchive && (
                        <button className="fp-btn fp-btn-ghost fp-btn-sm" onClick={() => onArchive(opportunity)} disabled={alreadyArchived}>
                          {alreadyArchived ? 'Archiviata' : 'Archivia'}
                        </button>
                      )}
                      <button className="fp-btn fp-btn-solid fp-btn-sm pr-place-bet" onClick={() => onBet(opportunity)} disabled={!budgetReady}>
                        Scommetti -&gt;
                      </button>
                    </>
                  )}
                </div>
              </div>
            );
          })}
          {archiveOnlyOpportunities.map((opportunity) => {
            const stakeKey = getStakeKey(opportunity);
            const classification = archiveClassification(opportunity)!;
            const archived = archivedOpportunityKeys.has(stakeKey);
            const suggestedAmount = bankroll > 0
              ? (Number(opportunity.suggestedStakePercent ?? 0) / 100) * bankroll
              : 0;
            const warningLabels = Array.from(
              new Set((opportunity.dataWarnings ?? []).map(valueWarningLabel).filter(Boolean))
            ) as string[];
            return (
              <div key={`archive-${stakeKey}`} className="pr-vb low">
                <div className="pr-vb-top">
                  <div>
                    <div className="pr-vb-market">{formatMarketKey(opportunity.marketName)}</div>
                    <div className="pr-vb-market-sub">{fmtSelection(String(opportunity.selection))}</div>
                  </div>
                  <span className="pr-badge pr-badge-gold">Solo archivio · {classification}</span>
                </div>
                <div className="pr-vb-stats" aria-label="Metriche della proposta">
                  {[
                    { label: 'P. Nostra', value: `${opportunity.ourProbability ?? 'N/D'}%` },
                    { label: 'P. Implicita', value: `${opportunity.impliedProbability ?? 'N/D'}%` },
                    { label: 'Edge', value: opportunity.edge === undefined ? 'N/D' : `+${opportunity.edge}%` },
                    { label: 'Quota', value: opportunity.bookmakerOdds ?? 'N/D' },
                    { label: 'Kelly 1/4', value: opportunity.kellyFraction === undefined ? 'N/D' : `${opportunity.kellyFraction}%` },
                    { label: 'EV', value: opportunity.expectedValue === undefined ? 'N/D' : `+${opportunity.expectedValue}%` },
                  ].map((entry) => (
                    <div className="pr-vb-stat" key={entry.label}>
                      <div className="pr-vb-stat-lbl">{entry.label}</div>
                      <div className="pr-vb-stat-val">{entry.value}</div>
                    </div>
                  ))}
                </div>
                <div className="pr-alert pr-alert-warning" style={{ marginTop: 12 }}>
                  Proposta analizzata ma non consigliata per una puntata reale: puoi salvarla come simulata per seguirne l'esito.
                </div>
                {warningLabels.length > 0 && (
                  <div className="pr-alert pr-alert-warning" style={{ marginTop: 12 }}>
                    {warningLabels.join(' - ')}
                  </div>
                )}
                <div className="pr-vb-bottom">
                  <div className="pr-stake-wrap" aria-label="Puntata suggerita">
                    <span className="pr-stake-lbl">Puntata suggerita</span>
                    <span className="pr-suggest">EUR {suggestedAmount.toFixed(2)} ({Number(opportunity.suggestedStakePercent ?? 0).toFixed(2)}% budget)</span>
                  </div>
                  <span className="pr-badge pr-badge-gray">{opportunity.bookmakerName ?? 'Bookmaker'} · quota {Number(opportunity.bookmakerOdds ?? 0).toFixed(2)}</span>
                  {onArchive && (
                    <button className="fp-btn fp-btn-ghost fp-btn-sm" onClick={() => onArchive(opportunity)} disabled={archived || isReplayAnalysis}>
                      {archived ? 'Archiviata' : 'Archivia senza giocare'}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </>
      )}
    </div>
  );
};

export default ValueOpportunitiesTable;
