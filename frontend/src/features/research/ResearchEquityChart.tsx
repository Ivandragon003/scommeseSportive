import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { EconomicMetrics } from './researchTypes';
import { comparativeEquity, dateTime, finiteNumber, isTimestamp, money } from './researchPresentation';
import { Empty } from './ResearchPrimitives';

const EquityChart = ({ a, c, title, showData = true, kind = 'equity' }: { a?: EconomicMetrics['equity']; c?: EconomicMetrics['equity']; title: string; showData?: boolean; kind?: 'equity' | 'profit' }) => {
  const points = comparativeEquity(a, c);
  if (!points.length) return <Empty>{kind === 'profit' ? 'Profitto non disponibile nei filtri scelti.' : 'Andamento del patrimonio non ancora disponibile.'}</Empty>;
  const hasTrend = [a, c].some((series) => (series || []).filter((point) => finiteNumber(point.equityCents)).length >= 2);
  if (!hasTrend) return <Empty>{kind === 'profit' ? 'Nessuna liquidazione nei filtri scelti.' : 'Il grafico comparirà quando saranno disponibili più movimenti per almeno un portafoglio.'}</Empty>;
  return <figure className="research-chart" aria-label={title}>
    <figcaption>{title}</figcaption>
    <p>{kind === 'profit' ? 'Profitto cumulato delle sole giocate filtrate, espresso in euro virtuali.' : a !== undefined && c !== undefined ? 'Due patrimoni indipendenti, espressi in euro virtuali.' : `Patrimonio del modello ${a !== undefined ? 'A' : 'C'}, espresso in euro virtuali.`}</p>
    <div className="research-chart__plot">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 12, right: 42, bottom: 12, left: 6 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
          <XAxis stroke="var(--text-3)" tick={{ fontSize: 12 }} dataKey="at" padding={{ left: 8, right: 18 }} minTickGap={80} interval="preserveStartEnd" tickFormatter={(value) => isTimestamp(value) ? new Date(value).toLocaleString('it-IT', { timeZone: 'Europe/Rome', day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) : value} />
          <YAxis stroke="var(--text-3)" tick={{ fontSize: 12 }} width={68} domain={['auto', 'auto']} tickFormatter={(value) => `${value} €`} />
          <Tooltip contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 10, color: 'var(--text)' }} formatter={(value: number) => money(value * 100)} labelFormatter={(value) => isTimestamp(value) ? dateTime(value) : String(value)} />
          <Legend />
          {a !== undefined && <Line type="stepAfter" dataKey="A" name="Modello A" stroke="var(--blue)" strokeWidth={2} dot={{ r: 2 }} connectNulls />}
          {c !== undefined && <Line type="stepAfter" dataKey="C" name="Modello C" stroke="var(--purple)" strokeWidth={2} dot={{ r: 2 }} connectNulls />}
        </LineChart>
      </ResponsiveContainer>
    </div>

    {showData && <details className="research-chart__data"><summary>Leggi i valori del grafico</summary><div className="research-table-wrap"><table className="fp-table"><caption>Patrimoni separati nel tempo</caption><thead><tr><th>Data / osservazione</th>{a !== undefined && <th>A</th>}{c !== undefined && <th>C</th>}</tr></thead><tbody>{points.map((point) => <tr key={point.at}><td>{isTimestamp(point.at) ? dateTime(point.at) : point.at}</td>{a !== undefined && <td>{finiteNumber(point.A) ? money(point.A * 100) : '—'}</td>}{c !== undefined && <td>{finiteNumber(point.C) ? money(point.C * 100) : '—'}</td>}</tr>)}</tbody></table></div></details>}
  </figure>;
};

export default EquityChart;
