import React from 'react';

type Option = { value: string; label: string };

export const AppSelect: React.FC<{
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  id?: string;
  className?: string;
  'aria-label'?: string;
}> = ({ value, options, onChange, id, className = '', 'aria-label': ariaLabel }) => {
  // Android WebView opens the system picker; it cannot be clipped by a scroll
  // container or covered by the fixed bottom navigation like a custom menu.
  return <select id={id} className={className} aria-label={ariaLabel} value={value} onChange={(e) => onChange(e.target.value)}>{options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>;
};

export const AppDateInput: React.FC<React.InputHTMLAttributes<HTMLInputElement>> = (props) => {
  return <input {...props} type="date" />;
};
