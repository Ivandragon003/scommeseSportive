import React from 'react';
import { AnalysisFactors } from './predictionTypes';

interface AnalysisFactorsPanelProps {
  analysisFactors?: AnalysisFactors | null;
}

const AnalysisFactorsPanel: React.FC<AnalysisFactorsPanelProps> = ({ analysisFactors }) => {
  if (!analysisFactors) return null;

  const notes = analysisFactors.notes ?? [];

  return (
    <div className="pr-info" style={{ marginTop: 12 }}>
      <strong>Fattori contestuali nel ranking value</strong>
      <br />
      Home advantage index: <strong>{Number(analysisFactors.homeAdvantageIndex ?? 0).toFixed(3)}</strong> | Form delta:{' '}
      <strong>{Number(analysisFactors.formDelta ?? 0).toFixed(3)}</strong> | Motivation delta:{' '}
      <strong>{Number(analysisFactors.motivationDelta ?? 0).toFixed(3)}</strong>
      <br />
      Suspensions delta: <strong>{Number(analysisFactors.suspensionsDelta ?? 0).toFixed(3)}</strong> | Red cards delta:{' '}
      <strong>{Number(analysisFactors.disciplinaryDelta ?? 0).toFixed(3)}</strong> | Diffidati delta:{' '}
      <strong>{Number(analysisFactors.atRiskPlayersDelta ?? 0).toFixed(3)}</strong>
      {notes.length > 0 && (
        <ul style={{ margin: '8px 0 0 18px', padding: 0 }}>
          {notes.map((note, index) => (
            <li key={`analysis_note_${index}`}>{note}</li>
          ))}
        </ul>
      )}
    </div>
  );
};

export default AnalysisFactorsPanel;
