import { BestValueOpportunity } from './predictionTypes';
export default function OpportunityQuality({ opportunity }: { opportunity: Partial<BestValueOpportunity> }) {
  const confidence = String(opportunity.confidence || '').toUpperCase();
  const labels: Record<string, string> = { HIGH: 'HIGH · Alta', MEDIUM: 'MEDIUM · Media', LOW: 'LOW · Bassa' };
  const ev = opportunity.expectedValue == null ? null : Number(opportunity.expectedValue);
  const speculative = [opportunity.marketTier, opportunity.bestBetStatus, opportunity.bestBetDecision?.status].some(value => value === 'SPECULATIVE');
  return <div className="opportunity-quality" aria-label="Qualità della selezione">
    <div className="opportunity-quality__confidence-group"><span className={`opportunity-quality__confidence confidence-${confidence.toLowerCase()}`}>Confidenza: <b>{labels[confidence] || 'Non disponibile'}</b></span>
    {speculative && <span className="confidence-speculative">Speculativa</span>}
    </div><span className={`opportunity-quality__ev ${ev != null && Number.isFinite(ev) && ev > 0 ? 'ev-positive' : ''}`}>Valore atteso (EV): <b>{ev != null && Number.isFinite(ev) ? `${ev > 0 ? '+' : ''}${ev.toFixed(2)}%` : 'Non disponibile'}</b></span>
  </div>;
}
