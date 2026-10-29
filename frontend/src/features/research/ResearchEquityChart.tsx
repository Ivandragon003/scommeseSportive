import React from 'react';
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { EconomicMetrics } from './researchTypes';
import { comparativeEquity, dateTime, finiteNumber, isTimestamp, money } from './researchPresentation';
import { Empty } from './ResearchPrimitives';

const EquityChart = ({ a, c, title }: { a?: EconomicMetrics['equity']; c?: EconomicMetrics['equity']; title: string }) => {
  const points = comparativeEquity(a, c);
  if (!points.length) return <Empty>Andamento del patrimonio non ancora disponibile.</Empty>;
  const hasTrend = [a, c].some((series) => (series || []).filter((point) => finiteNumber(point.equityCents)).length >= 2);
  if (!hasTrend) return <Empty>Il grafico comparirà quando saranno disponibili più movimenti per almeno un portafoglio.</Empty>;
  return <figure className="research-chart" aria-label={title}>
    <figcaption>{title}</figcaption>
    <p>Due patrimoni indipendenti, espressi in euro virtuali.</p>
    <div className="research-chart__plot">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 12, right: 16, bottom: 4, left: 6 }}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="at" minTickGap={40} tickFormatter={(value) => isTimestamp(value) ? new Date(value).toLocaleDateString('it-IT', { timeZone: 'Europe/Rome' }) : value} />
          <YAxis width={60} domain={['auto', 'auto']} tickFormatter={(value) => `${value} €`} />
          <Tooltip formatter={(value: number) => money(value * 100)} labelFormatter={(value) => isTimestamp(value) ? dateTime(value) : String(value)} />
          <Legend />
          <Line type="stepAfter" dataKey="A" name="Modello A" stroke="var(--blue)" strokeWidth={2} dot={{ r: 2 }} connectNulls />
          <Line type="stepAfter" dataKey="C" name="Modello C" stroke="var(--purple)" strokeWidth={2} dot={{ r: 2 }} connectNulls />
        </LineChart>
      </ResponsiveContainer>
    </div>
    <details className="research-chart__data"><summary>Leggi i valori del grafico</summary><div className="research-table-wrap"><table className="fp-table"><caption>Patrimoni separati nel tempo</caption><thead><tr><th>Data / osservazione</th><th>A</th><th>C</th></tr></thead><tbody>{points.map((point) => <tr key={point.at}><td>{isTimestamp(point.at) ? dateTime(point.at) : point.at}</td><td>{finiteNumber(point.A) ? money(point.A * 100) : '—'}</td><td>{finiteNumber(point.C) ? money(point.C * 100) : '—'}</td></tr>)}</tbody></table></div></details>
  </figure>;
};

export default EquityChart;
