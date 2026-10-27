import React, { useId } from 'react';
import { stateLabel } from './researchPresentation';

export const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="research-empty">{children}</p>
);

export const Badge = ({ state }: { state: string }) => (
  <span className={`research-badge research-badge--${String(state).toLowerCase()}`}>
    {stateLabel(state)}
  </span>
);

export const Metric = ({ label, value, help }: {
  label: string;
  value: React.ReactNode;
  help?: string;
}) => {
  const labelId = useId();
  return <div className="research-metric">
    <dt id={labelId}>{label}</dt>
    <dd aria-labelledby={labelId}>{value}</dd>
    {help && <small>{help}</small>}
  </div>;
};
