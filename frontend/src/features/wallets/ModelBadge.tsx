import './model-badge.css';

export type DisplayModel = 'A' | 'C' | 'baseline';

export default function ModelBadge({ model }: { model: DisplayModel }) {
  const label = model === 'baseline' ? 'Baseline deterministica' : `Modello ${model}`;
  return <span className={`model-badge model-badge--${model.toLowerCase()}`}>
    <span className="model-badge__letter" aria-hidden="true">{model === 'baseline' ? 'B' : model}</span>
    <span>{label}</span>
  </span>;
}
