import React from 'react';
import { fmtSelection, marketTierBadgeClass, marketTierLabel } from './predictionFormatting';
import { BestValueOpportunity, RecommendedBetResult, ReplayTone } from './predictionTypes';

interface ValueOpportunitiesTableProps {
  opportunities: BestValueOpportunity[];
  bankroll: number;
  budgetReady: boolean;
  isReplayAnalysis: boolean;
  oddsSource?: string | null;
  providerWarning?: string | null;
  placedBetKeySet: Set<string>;
  recommendedBetResult?: RecommendedBetResult | null;
  replayOutcomeTone: ReplayTone;
  stakes: Record<string, string>;
  getStakeKey: (opportunity: BestValueOpportunity) => string;
  getStakeValue: (opportunity: BestValueOpportunity) => number;
  onStakeChange: (stakeKey: string, value: string) => void;
  onBet: (opportunity: BestValueOpportunity) => void;
}

const ValueOpportunitiesTable: React.FC<ValueOpportunitiesTableProps> = ({
  opportunities,
  bankroll,
  budgetReady,
  isReplayAnalysis,
  oddsSource,
  providerWarning,
  placedBetKeySet,
  recommendedBetResult,
  replayOutcomeTone,
  stakes,
  getStakeKey,
  getStakeValue,
  onStakeChange,
  onBet,
}) => {
  const emptyMessage =
    oddsSource === 'eurobet_unavailable'
      ? 'Quote Eurobet non disponibili per questa partita.'
      : 'Nessuna scommessa con EV positivo trovata.';

  return (
    <div data-testid="value-opportunities-table">
      {!budgetReady && <div className="pr-alert pr-alert-warning">ATTENZIONE: inizializza il bankroll in Budget Manager.</div>}
      {providerWarning && <div className="pr-alert pr-alert-warning">{providerWarning}</div>}
      {isReplayAnalysis && (
        <div className="pr-alert pr-alert-warning">
          Modalita replay: quote ricostruite dal modello e puntata disabilitata su partite gia concluse.
        </div>
      )}

      {opportunities.length === 0 ? (
        <div className="pr-info" style={{ textAlign: 'center', padding: '32px 0' }}>
          {emptyMessage}
          <br />
          <span style={{ color: 'var(--text-3)', fontSize: 11 }}>
            {oddsSource === 'eurobet_unavailable'
              ? 'Finche Eurobet non espone il mercato, il sistema non propone una giocata finale con quota utente.'
              : 'Quote Eurobet non disponibili oppure edge insufficiente (>2%).'}
          </span>
        </div>
      ) : (
        <>
          <div className="pr-alert pr-alert-success">
            OK <strong>{opportunities.length}</strong> scommesse EV positivo (soglia &gt;2%)
          </div>
          {opportunities.map((opportunity) => {
            const stakeKey = getStakeKey(opportunity);
            const currentStake = getStakeValue(opportunity);
            const currentStakePct = bankroll > 0 ? (currentStake / bankroll) * 100 : 0;
            const suggestedAmount = bankroll > 0 ? (Number(opportunity.suggestedStakePercent ?? 0) / 100) * bankroll : 0;
            const alreadyPlaced = placedBetKeySet.has(stakeKey);
            const isRecommendedReplaySelection =
              String(recommendedBetResult?.selection ?? '') === String(opportunity.selection ?? '');

            return (
              <div
                key={stakeKey}
                className={`pr-vb${opportunity.confidence === 'MEDIUM' ? ' medium' : opportunity.confidence === 'LOW' ? ' low' : ''}`}
              >
                <div className="pr-vb-top">
                  <div>
                    <div className="pr-vb-market">{opportunity.marketName}</div>
                    <div className="pr-vb-market-sub">{fmtSelection(String(opportunity.selection))}</div>
                    <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
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
                    <button className="fp-btn fp-btn-green fp-btn-sm" onClick={() => onBet(opportunity)} disabled={!budgetReady}>
                      Scommetti -&gt;
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
