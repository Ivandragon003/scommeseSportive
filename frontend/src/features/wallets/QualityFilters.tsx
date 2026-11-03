import { Check } from 'lucide-react';
import './quality-filters.css';

export const QUALITY_KEYS = ['HIGH', 'MEDIUM', 'LOW', 'SPECULATIVE', 'UNKNOWN'];
export const qualityLabel = (value: string) => value === 'UNKNOWN' ? 'Non registrata' : value === 'SPECULATIVE' ? 'Speculative' : value[0] + value.slice(1).toLowerCase();
export default function QualityFilters({ value, onChange }: { value: string[]; onChange: (value: string[]) => void }) {
  return <fieldset className="quality-filters"><legend>Classificazione</legend><div><button type="button" aria-label="Tutte le classificazioni" aria-pressed={!value.length} onClick={() => onChange([])}><span>Tutte</span><Check size={14} aria-hidden="true" style={{ visibility: !value.length ? 'visible' : 'hidden' }} /></button>{QUALITY_KEYS.map(key => <button type="button" key={key}
    aria-pressed={value.includes(key)} onClick={() => onChange(value.includes(key) ? value.filter(item => item !== key) : [...value, key])}>
    <span>{qualityLabel(key)}</span><Check size={14} aria-hidden="true" style={{ visibility: value.includes(key) ? 'visible' : 'hidden' }} /></button>)}</div></fieldset>;
}
