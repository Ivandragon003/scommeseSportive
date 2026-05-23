import React from 'react';
import type { BestValueOpportunity } from './predictionTypes';
import { fmtSelection } from './predictionFormatting';

interface PlayerPropsSectionProps {
  opportunities: BestValueOpportunity[];
  bankroll: number;
}

const fmtNumber = (value: unknown, decimals = 2): string => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric.toFixed(decimals) : '--';
};

const warningLabel = (warning: string): string => {
  const labels: Record<string, string> = {
    low_player_sample: 'campione basso',
    uncertain_minutes: 'minuti incerti',
    missing_under_price: 'manca quota opposta',
    ambiguous_player_match: 'matching ambiguo',
    low_starter_confidence: 'titolarita incerta',
    missing_player_event_data: 'dati evento mancanti',
    missing_referee_data: 'dati arbitro mancanti',
  };
  return labels[warning] ?? warning.replace(/_/g, ' ');
};

const groupLabel = (category: string): string => {
  if (category === 'player_shots') return 'Tiri';
  if (category === 'player_shots_ot') return 'Tiri in porta';
  if (category === 'player_yellow_cards') return 'Cartellini';
  return 'Altri mercati giocatore';
};

const PlayerPropsSection: React.FC<PlayerPropsSectionProps> = ({ opportunities, bankroll }) => {
  if (opportunities.length === 0) {
    return (
      <div className="pr-info">
        Nessun mercato giocatore giocabile con quote bookmaker e dati sufficienti per questa partita.
      </div>
    );
  }

  const grouped = opportunities.reduce<Record<string, BestValueOpportunity[]>>((acc, opportunity) => {
    const key = String(opportunity.marketCategory ?? opportunity.marketType ?? 'other');
    acc[key] = acc[key] ?? [];
    acc[key].push(opportunity);
    return acc;
  }, {});

  return (
    <div className="pr-card">
      <div className="pr-card-head">
        <div>
          <div className="pr-card-title">Mercati giocatore</div>
          <div className="pr-muted">Solo player props con quota bookmaker, matching giocatore chiaro e stake prudente.</div>
        </div>
      </div>
      <div className="pr-card-body">
        {Object.entries(grouped).map(([category, rows]) => (
          <div key={category} style={{ marginBottom: 18 }}>
            <div className="pr-sec">{groupLabel(category)}</div>
            <div className="pr-g2">
              {rows
                .slice()
                .sort((left, right) => Number(right.expectedValue ?? 0) - Number(left.expectedValue ?? 0))
                .map((opportunity) => {
                  const stakeAmount = bankroll > 0
                    ? (Number(opportunity.suggestedStakePercent ?? 0) / 100) * bankroll
                    : 0;
                  const warnings = Array.isArray(opportunity.dataWarnings) ? opportunity.dataWarnings : [];
                  return (
                    <div className="pr-info" key={`${opportunity.selection}-${opportunity.marketName}`}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }}>
                        <div>
                          <strong>{opportunity.playerName ?? fmtSelection(opportunity.selection)}</strong>
                          <div className="pr-muted">{opportunity.teamName ?? 'Squadra n/d'} - {opportunity.marketName}</div>
                        </div>
                        <span className="pr-badge pr-badge-blue">{opportunity.confidence ?? 'LOW'}</span>
                      </div>
                      <table className="fp-table" style={{ marginTop: 10 }}>
                        <tbody>
                          <tr><td>Quota bookmaker</td><td className="fp-mono" style={{ textAlign: 'right' }}>{fmtNumber(opportunity.bookmakerOdds)}</td></tr>
                          <tr><td>Probabilita nostra</td><td className="fp-mono" style={{ textAlign: 'right' }}>{fmtNumber(opportunity.ourProbability)}%</td></tr>
                          <tr><td>EV</td><td className="fp-mono" style={{ textAlign: 'right' }}>{fmtNumber(opportunity.expectedValue)}%</td></tr>
                          <tr><td>Edge no-vig</td><td className="fp-mono" style={{ textAlign: 'right' }}>{fmtNumber(opportunity.edgeNoVig ?? opportunity.edge)}%</td></tr>
                          <tr><td>Stake suggerito</td><td className="fp-mono" style={{ textAlign: 'right' }}>{fmtNumber(opportunity.suggestedStakePercent)}%{stakeAmount > 0 ? ` / EUR ${stakeAmount.toFixed(2)}` : ''}</td></tr>
                          <tr><td>Minuti attesi</td><td className="fp-mono" style={{ textAlign: 'right' }}>{fmtNumber(opportunity.expectedMinutes, 1)}</td></tr>
                          <tr><td>Campione</td><td className="fp-mono" style={{ textAlign: 'right' }}>{fmtNumber(opportunity.sampleSize, 0)}</td></tr>
                        </tbody>
                      </table>
                      {warnings.length > 0 && (
                        <div className="pr-alert pr-alert-warning" style={{ marginTop: 10 }}>
                          {warnings.map(warningLabel).join(' - ')}
                        </div>
                      )}
                    </div>
                  );
                })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default PlayerPropsSection;
