import React from 'react';
import { DistChart, ProbBar } from './PredictionStatPrimitives';
import { formatCompactOuKey, fmtN } from './predictionFormatting';
import { ShotsPrediction } from './predictionTypes';

interface ShotsSectionProps {
  homeTeam: string;
  awayTeam: string;
  shotsPrediction: ShotsPrediction;
}

const ShotsSection: React.FC<ShotsSectionProps> = ({ homeTeam, awayTeam, shotsPrediction }) => (
  <div>
    <div className="pr-g2">
      {[
        { team: homeTeam, data: shotsPrediction.home, shotsColor: 'var(--blue)', onTargetColor: 'var(--green)' },
        { team: awayTeam, data: shotsPrediction.away, shotsColor: 'var(--red)', onTargetColor: 'var(--gold)' },
      ].map((team) => (
        <div className="pr-card" key={team.team}>
          <div className="pr-card-head">
            <div className="pr-card-title">{team.team}</div>
            <span className="pr-badge pr-badge-blue">M {fmtN(team.data.totalShots.expected)}</span>
          </div>
          <div className="pr-card-body">
            <DistChart dist={team.data.totalShots.distribution} expected={team.data.totalShots.expected} title="Tiri totali" color={team.shotsColor} />
            <DistChart
              dist={team.data.shotsOnTarget.distribution}
              expected={team.data.shotsOnTarget.expected}
              title="Tiri in porta"
              color={team.onTargetColor}
            />
          </div>
        </div>
      ))}
    </div>
    <div className="pr-card">
      <div className="pr-card-head">
        <div className="pr-card-title">Totali combinati</div>
        <div style={{ display: 'flex', gap: 4 }}>
          <span className="pr-badge pr-badge-blue">Tiri {fmtN(shotsPrediction.combined.totalShots.expected)}</span>
          <span className="pr-badge pr-badge-green">In porta {fmtN(shotsPrediction.combined.totalOnTarget.expected)}</span>
        </div>
      </div>
      <div className="pr-card-body">
        <div className="pr-g2">
          <div>
            <div className="pr-sec">Tiri Totali</div>
            {Object.entries(shotsPrediction.combined.overUnder)
              .filter(([key]) => key.startsWith('over'))
              .map(([key, value]) => (
                <ProbBar key={key} label={`Over ${formatCompactOuKey(key)} tiri`} value={value} color="var(--blue)" />
              ))}
          </div>
          <div>
            <div className="pr-sec">Tiri in Porta</div>
            {Object.entries(shotsPrediction.combined.onTargetOverUnder)
              .filter(([key]) => key.startsWith('over'))
              .map(([key, value]) => (
                <ProbBar key={key} label={`Over ${formatCompactOuKey(key)} in porta`} value={value} color="var(--green)" />
              ))}
          </div>
        </div>
      </div>
    </div>
  </div>
);

export default ShotsSection;
