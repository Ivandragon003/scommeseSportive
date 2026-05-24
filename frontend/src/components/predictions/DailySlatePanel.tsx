import React from 'react';
import { BestValueOpportunity, DailySlateResponse } from './predictionTypes';
import { fmtSelection } from './predictionFormatting';

interface DailySlatePanelProps {
  slate: DailySlateResponse | null;
  loading?: boolean;
  error?: string | null;
  onRefresh?: () => void;
}

const fmtNumber = (value: unknown, digits = 2): string => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toFixed(digits) : 'N/D';
};

const skipReasonLabel = (reason?: string): string => {
  switch (reason) {
    case 'skippedBecauseWeakSlateRank':
      return 'ranking insufficiente';
    case 'skippedBecauseDailyCardCap':
      return 'cap cartellini raggiunto';
    case 'skippedBecauseDailyUnderCap':
      return 'cap Under/No Goal raggiunto';
    case 'skippedBecauseCorrelation':
      return 'mercato correlato nello stesso match';
    case 'skippedBecauseLowConfidence':
      return 'confidence bassa';
    case 'quota_non_disponibile':
      return 'quota non disponibile';
    case 'nessuna_value_opportunity':
      return 'nessuna value bet solida';
    case 'match_data_incomplete':
      return 'dati match incompleti';
    case 'prediction_failed':
      return 'analisi non completata';
    default:
      return reason ? reason.replace(/_/g, ' ') : 'motivo non disponibile';
  }
};

const pickWarnings = (pick: BestValueOpportunity): string[] =>
  Array.from(new Set([
    ...(pick.dataWarnings ?? []),
    ...(pick.riskReasons ?? []),
  ].filter(Boolean))).slice(0, 3);

const DailySlatePick: React.FC<{ pick: BestValueOpportunity }> = ({ pick }) => {
  const warnings = pickWarnings(pick);
  return (
    <div className="pr-vb" data-testid="daily-slate-pick">
      <div className="pr-vb-top">
        <div>
          <div className="pr-vb-market">{pick.selectionLabel ?? pick.marketName ?? fmtSelection(pick.selection)}</div>
          <div className="pr-vb-market-sub">
            {(pick.match ?? `${pick.homeTeam ?? ''} - ${pick.awayTeam ?? ''}`).trim()} | {pick.marketCategory ?? 'mercato'}
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="pr-vb-ev-num">+{fmtNumber(pick.expectedValue)}%</div>
          <div className="pr-vb-ev-lbl">EV</div>
        </div>
      </div>
      <div className="pr-vb-stats">
        <div className="pr-vb-stat"><div className="pr-vb-stat-lbl">Quota</div><div className="pr-vb-stat-val">{fmtNumber(pick.bookmakerOdds)}</div></div>
        <div className="pr-vb-stat"><div className="pr-vb-stat-lbl">Edge no-vig</div><div className="pr-vb-stat-val">{fmtNumber(pick.edgeNoVig)}%</div></div>
        <div className="pr-vb-stat"><div className="pr-vb-stat-lbl">Confidenza</div><div className="pr-vb-stat-val">{pick.confidence ?? 'N/D'}</div></div>
        <div className="pr-vb-stat"><div className="pr-vb-stat-lbl">Stake</div><div className="pr-vb-stat-val">{fmtNumber(pick.suggestedStakePercent)}%</div></div>
        <div className="pr-vb-stat"><div className="pr-vb-stat-lbl">Ranking</div><div className="pr-vb-stat-val">{fmtNumber(pick.slateDiagnostics?.slateRank ?? pick.rankingScore, 3)}</div></div>
      </div>
      {warnings.length > 0 && (
        <div className="pr-vb-bottom">
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {warnings.map((warning) => (
              <span key={warning} className="pr-badge pr-badge-gold">{skipReasonLabel(warning)}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};

const DailySlatePanel: React.FC<DailySlatePanelProps> = ({ slate, loading = false, error = null, onRefresh }) => {
  const recommended = slate?.recommended ?? [];
  const skippedBySlate = (slate?.skipped ?? []).slice(0, 4);
  const skippedMatches = (slate?.matchesSkipped ?? []).slice(0, 4);

  return (
    <div className="pr-card" data-testid="daily-slate-panel">
      <div className="pr-card-head">
        <div>
          <div className="pr-card-title">Consigli giornata</div>
          {slate?.date && <div className="pr-vb-market-sub">{slate.competition} | {slate.date}</div>}
        </div>
        {onRefresh && (
          <button className="fp-btn fp-btn-ghost fp-btn-sm" onClick={onRefresh} disabled={loading}>
            {loading ? 'Calcolo...' : 'Ricalcola'}
          </button>
        )}
      </div>
      <div className="pr-card-body">
        {loading && (
          <div className="pr-info">Calcolo dei consigli giornata in corso. Il filtro non forza una giocata per partita.</div>
        )}
        {error && !loading && (
          <div className="pr-alert pr-alert-warning">{error}</div>
        )}
        {!loading && !error && recommended.length === 0 && (
          <div className="pr-info">Nessuna giocata abbastanza solida oggi.</div>
        )}
        {!loading && recommended.map((pick) => (
          <DailySlatePick key={`${pick.matchId ?? pick.match}-${pick.selection}-${pick.marketName}`} pick={pick} />
        ))}
        {!loading && (skippedBySlate.length > 0 || skippedMatches.length > 0) && (
          <div className="pr-info" style={{ marginTop: 10 }}>
            <strong>Match da saltare</strong><br />
            {[...skippedBySlate.map((pick) => ({
              match: pick.match ?? `${pick.homeTeam ?? ''} - ${pick.awayTeam ?? ''}`,
              reason: pick.slateSkipReason ?? pick.slateDiagnostics?.reasonCode,
            })), ...skippedMatches.map((match) => ({
              match: match.match ?? `${match.homeTeam ?? ''} - ${match.awayTeam ?? ''}`,
              reason: match.reason,
            }))].slice(0, 6).map((entry, index) => (
              <div key={`${entry.match}-${entry.reason}-${index}`}>
                {entry.match}: {skipReasonLabel(entry.reason)}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

export default DailySlatePanel;
