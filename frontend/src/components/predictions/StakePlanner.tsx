import React from 'react';

interface StakePlannerProps {
  isReplayAnalysis: boolean;
  actualMatchDate?: string;
  actualScore?: string | null;
  bankroll: number;
  suggestedTotalStake: number;
  maxExposurePct: number;
  maxExposureAmount: number;
  exposureRatio: number;
}

const StakePlanner: React.FC<StakePlannerProps> = ({
  isReplayAnalysis,
  actualMatchDate,
  actualScore,
  bankroll,
  suggestedTotalStake,
  maxExposurePct,
  maxExposureAmount,
  exposureRatio,
}) => (
  <div>
    <div className="pr-sec">Gestione Match</div>
    <div className="pr-info" style={{ marginBottom: 10 }} data-testid="stake-planner">
      {isReplayAnalysis ? (
        <>
          Match chiuso il: <strong>{actualMatchDate ?? '-'}</strong>
          <br />
          Esito reale: <strong>{actualScore ?? '-'}</strong>
          <br />
          Modalita: <strong>verifica retrospettiva</strong>
        </>
      ) : (
        <>
          Bankroll disponibile: <strong>EUR {bankroll.toFixed(2)}</strong>
          <br />
          Esposizione suggerita: <strong>EUR {suggestedTotalStake.toFixed(2)}</strong>
          <br />
          Cap esposizione ({maxExposurePct}%): <strong>EUR {maxExposureAmount.toFixed(2)}</strong>
        </>
      )}
    </div>
    {!isReplayAnalysis && (
      <>
        <div
          className="pr-prob-track"
          style={{ height: 12 }}
          role="meter"
          aria-label="Utilizzo cap rischio"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.min(100, exposureRatio * 100)}
        >
          <div
            className="pr-prob-fill"
            style={{
              width: `${Math.min(100, exposureRatio * 100)}%`,
              background: exposureRatio > 1 ? 'var(--red)' : exposureRatio > 0.8 ? 'var(--gold)' : 'var(--green)',
              minWidth: 0,
              justifyContent: 'flex-start',
              paddingRight: 0,
            }}
          />
        </div>
        <div style={{ fontSize: 11, color: 'var(--text-2)', marginTop: 8 }}>
          Utilizzo cap rischio: {(exposureRatio * 100).toFixed(1)}%
        </div>
      </>
    )}
  </div>
);

export default StakePlanner;
