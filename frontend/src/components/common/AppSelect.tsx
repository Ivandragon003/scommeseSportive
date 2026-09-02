import React, { useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { ChevronDown } from 'lucide-react';

type Option = { value: string; label: string };

export const AppSelect: React.FC<{
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  id?: string;
  className?: string;
  'aria-label'?: string;
}> = ({ value, options, onChange, id, className = '', 'aria-label': ariaLabel }) => {
  const [open, setOpen] = useState(false);
  if (!Capacitor.isNativePlatform()) return <select id={id} className={className} aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;
  const selected = options.find((o) => o.value === value)?.label ?? options[0]?.label ?? '';
  return <div className="app-select-native">
    <button id={id} type="button" className={`${className} app-select-native__trigger`} aria-label={ariaLabel} aria-expanded={open} onClick={() => setOpen((v) => !v)}><span>{selected}</span><ChevronDown size={16} className={open ? 'open' : ''} /></button>
    {open && <div className="app-select-native__menu" role="listbox" aria-label={ariaLabel}>{options.map((o) => <button key={o.value} type="button" role="option" aria-selected={o.value === value} className={o.value === value ? 'active' : ''} onClick={() => { onChange(o.value); setOpen(false); }}>{o.label}{o.value === value && <span>✓</span>}</button>)}</div>}
  </div>;
};

export const AppDateInput: React.FC<React.InputHTMLAttributes<HTMLInputElement>> = (props) => {
  if (!Capacitor.isNativePlatform()) return <input {...props} type="date" />;
  return <input {...props} type="text" inputMode="numeric" placeholder={props.placeholder ?? 'aaaa-mm-gg'} onChange={props.onChange} />;
};
