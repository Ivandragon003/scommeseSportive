import React, { useId } from 'react';

export const Empty = ({ children }: { children: React.ReactNode }) => (
  <p className="research-empty">{children}</p>
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
