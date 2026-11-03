export function recordedBetQuality(bet: { classification?: unknown; confidence?: unknown }): string | null {
  const classification = typeof bet.classification === 'string' ? bet.classification.toUpperCase() : '';
  const confidence = typeof bet.confidence === 'string' ? bet.confidence.toUpperCase() : '';
  return ['HIGH', 'MEDIUM', 'LOW', 'SPECULATIVE'].includes(classification) ? classification
    : ['HIGH', 'MEDIUM', 'LOW'].includes(confidence) ? confidence : null;
}

export default function BetQualityBadge({ bet }: { bet: { classification?: unknown; confidence?: unknown } }) {
  const quality = recordedBetQuality(bet);
  if (!quality) return null;
  return <span className={`bet-quality-badge bet-quality-badge--${quality.toLowerCase()}`}
    aria-label={`Classificazione registrata: ${quality}`}>{quality === 'SPECULATIVE' ? 'SPECULATIVE · Speculativa' : `${quality} · ${quality === 'HIGH' ? 'Alta' : quality === 'MEDIUM' ? 'Media' : 'Bassa'}`}</span>;
}
