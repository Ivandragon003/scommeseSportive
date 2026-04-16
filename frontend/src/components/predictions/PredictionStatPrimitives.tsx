import React from 'react';
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts';
import { fmtN } from './predictionFormatting';

export const ProbBar: React.FC<{ label: string; value: number; color?: string }> = ({ label, value, color = 'var(--blue)' }) => (
  <div className="pr-prob-row">
    <span className="pr-prob-lbl" title={label}>
      {label}
    </span>
    <div className="pr-prob-track">
      <div className="pr-prob-fill" style={{ width: `${Math.min(100, value * 100)}%`, background: color }}>
        {(value * 100).toFixed(1)}%
      </div>
    </div>
  </div>
);

export const DistChart: React.FC<{
  dist: Record<string, number>;
  expected: number;
  title: string;
  color?: string;
}> = ({ dist, expected, title, color = 'var(--blue)' }) => {
  const data = Object.entries(dist)
    .map(([key, probability]) => ({ key: parseInt(key, 10), pct: parseFloat((probability * 100).toFixed(2)) }))
    .filter((item) => item.pct >= 0.05)
    .sort((a, b) => a.key - b.key);

  return (
    <div style={{ marginBottom: 14 }}>
      <div className="pr-chart-head">
        <span>{title}</span>
        <span>
          Atteso = <strong>{fmtN(expected)}</strong>
        </span>
      </div>
      <ResponsiveContainer width="100%" height={110}>
        <BarChart data={data} margin={{ top: 2, right: 2, bottom: 2, left: 0 }}>
          <CartesianGrid strokeDasharray="2 2" stroke="rgba(115,136,161,0.18)" />
          <XAxis dataKey="key" tick={{ fontSize: 9, fill: 'var(--text-3)' }} />
          <YAxis tickFormatter={(value) => `${value}%`} tick={{ fontSize: 9, fill: 'var(--text-3)' }} width={28} />
          <Tooltip
            contentStyle={{ background: 'var(--surface2)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 11 }}
            formatter={(value: number) => [`${value}%`, 'P']}
            labelFormatter={(label: number) => `k=${label}`}
          />
          <ReferenceLine x={Math.round(expected)} stroke="rgba(74,96,120,0.45)" strokeDasharray="3 3" />
          <Bar dataKey="pct" fill={color} radius={[3, 3, 0, 0]} opacity={0.85} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
};
