import React from 'react';
import AnalysisFactorsPanel from './AnalysisFactorsPanel';
import { fmtN } from './predictionFormatting';
import { AnalysisFactors, BestValueOpportunity, MethodologySnapshot } from './predictionTypes';

interface MethodologyDrawerProps {
  methodology?: MethodologySnapshot;
  fallbackLambdaHome?: number;
  fallbackLambdaAway?: number;
  fallbackTotalShotsExpected?: number;
  fallbackTotalYellowExpected?: number;
  fallbackTotalFoulsExpected?: number;
  topOpportunity?: BestValueOpportunity | null;
  analysisFactors?: AnalysisFactors | null;
}

const MethodologyDrawer: React.FC<MethodologyDrawerProps> = ({
  methodology,
  fallbackLambdaHome = 0,
  fallbackLambdaAway = 0,
  fallbackTotalShotsExpected = 0,
  fallbackTotalYellowExpected = 0,
  fallbackTotalFoulsExpected = 0,
  topOpportunity,
  analysisFactors,
}) => (
  <div className="pr-card">
    <div className="pr-card-head">
      <div className="pr-card-title">Come Calcola l'Algoritmo</div>
    </div>
    <div className="pr-card-body">
      <div className="pr-g2">
        <div className="pr-info">
          <strong>Goal model</strong>
          <br />
          Dixon-Coles stima lambda casa/ospite e costruisce la matrice punteggi 0..10.
          <br />
          Runtime attuale: lambda casa <strong>{fmtN(Number(methodology?.runtime?.lambdaHome ?? fallbackLambdaHome), 3)}</strong>,
          lambda ospite <strong>{fmtN(Number(methodology?.runtime?.lambdaAway ?? fallbackLambdaAway), 3)}</strong>.
        </div>
        <div className="pr-info">
          <strong>Mercati avanzati</strong>
          <br />
          Tiri, cartellini e falli usano Binomiale Negativa con dispersione dedicata.
          <br />
          Attesi correnti: tiri totali <strong>{fmtN(Number(methodology?.runtime?.totalShotsExpected ?? fallbackTotalShotsExpected), 2)}</strong>,
          gialli <strong>{fmtN(Number(methodology?.runtime?.totalYellowExpected ?? fallbackTotalYellowExpected), 2)}</strong>,
          falli <strong>{fmtN(Number(methodology?.runtime?.totalFoulsExpected ?? fallbackTotalFoulsExpected), 2)}</strong>.
        </div>
      </div>
      <div className="pr-g2" style={{ marginTop: 12 }}>
        <div className="pr-info">
          <strong>Value betting</strong>
          <br />
          P_imp = 1/quota, EV = p*quota - 1, edge = p - P_imp.
          <br />
          Stake = Kelly frazionale (1/4) con limiti min/max.
        </div>
        <div className="pr-info">
          <strong>Esempio live</strong>
          <br />
          {topOpportunity ? (
            <>
              Mercato: <strong>{topOpportunity.marketName}</strong>
              <br />
              P. nostra {topOpportunity.ourProbability}% | quota {topOpportunity.bookmakerOdds} | EV +{topOpportunity.expectedValue}% | stake{' '}
              {topOpportunity.suggestedStakePercent}% bankroll
            </>
          ) : (
            'Nessuna value bet disponibile su questa partita.'
          )}
        </div>
      </div>
      <div className="pr-alert pr-alert-info" style={{ marginTop: 12 }}>
        Formula sintetica pipeline: dati storici -&gt; stima parametri squadre -&gt; probabilita mercati -&gt; confronto quote bookmaker
        -&gt; filtro EV -&gt; staking Kelly.
      </div>
      <AnalysisFactorsPanel analysisFactors={analysisFactors} />
    </div>
  </div>
);

export default MethodologyDrawer;
