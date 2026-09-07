import React, { useMemo, useState } from 'react';
import { Minus } from 'lucide-react';
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

interface BankrollTrendChartProps {
  initialBudget: number;
  settledBets: any[];
}

interface TrendPoint {
  label: string;
  value: number;
  result: string;
  timestamp: number;
}

type TrendRange = '7D' | '30D' | '90D' | '180D' | '365D' | 'ALL';

const ranges: Array<{ value: TrendRange; label: string; days?: number }> = [
  { value: '7D', label: '7G', days: 7 },
  { value: '30D', label: '30G', days: 30 },
  { value: '90D', label: '3M', days: 90 },
  { value: '180D', label: '6M', days: 180 },
  { value: '365D', label: '1A', days: 365 },
  { value: 'ALL', label: 'Tutto' },
];

const formatCurrency = (value: number) => `EUR ${value.toFixed(2)}`;

const BankrollTrendChart: React.FC<BankrollTrendChartProps> = ({ initialBudget, settledBets }) => {
  const [range, setRange] = useState<TrendRange>('30D');
  const now = Date.now();
  const fullData = useMemo<TrendPoint[]>(() => {
    let runningBudget = initialBudget;
    const orderedBets = [...settledBets]
      .map((bet) => ({ bet, timestamp: [bet?.settled_at, bet?.placed_at]
        .map((date) => date ? new Date(date).getTime() : NaN).find(Number.isFinite) ?? NaN }))
      .filter(({ timestamp }) => Number.isFinite(timestamp) && timestamp <= now)
      .sort((left, right) => left.timestamp - right.timestamp);
    const startTimestamp = orderedBets[0]?.timestamp ?? now;
    const points: TrendPoint[] = [{
      label: 'Inizio',
      value: runningBudget,
      result: 'Bankroll iniziale',
      timestamp: startTimestamp - 1,
    }];

    for (const { bet, timestamp } of orderedBets) {
      const profit = Number(bet?.profit ?? 0);
      if (!Number.isFinite(profit)) continue;
      runningBudget += profit;
      points.push({
        label: new Date(timestamp).toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' }),
        value: Number(runningBudget.toFixed(2)),
        result: `${bet?.home_team_name ?? '-'} – ${bet?.away_team_name ?? '-'}`,
        timestamp,
      });
    }

    return points;
  }, [initialBudget, settledBets, now]);

  const { data, movementCount } = useMemo(() => {
    if (range === 'ALL') {
      return { data: fullData, movementCount: Math.max(0, fullData.length - 1) };
    }
    const selected = ranges.find((item) => item.value === range);
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - Number(selected?.days ?? 30) + 1);
    const cutoff = start.getTime();
    const earlier = fullData.filter((point) => point.timestamp < cutoff);
    const inside = fullData.filter((point, index) => index > 0 && point.timestamp >= cutoff);
    const baseline = earlier[earlier.length - 1] ?? fullData[0];
    return {
      data: [{ ...baseline, timestamp: cutoff, label: 'Inizio periodo', result: 'Valore a inizio periodo' }, ...inside,
        { ...fullData[fullData.length - 1], timestamp: now, label: 'Oggi', result: 'Valore attuale' }],
      movementCount: inside.length,
    };
  }, [fullData, range, now]);

  const finalBudget = data[data.length - 1]?.value ?? initialBudget;

  return (
    <section className="budget-chart-panel" aria-labelledby="bankroll-chart-title">
      <div className="budget-chart-panel__head">
        <h2 id="bankroll-chart-title">Andamento</h2>
        <div className="budget-chart-ranges" role="group" aria-label="Intervallo andamento bankroll">
          {ranges.map((item) => (
            <button
              key={item.value}
              type="button"
              className={range === item.value ? 'active' : ''}
              aria-pressed={range === item.value}
              onClick={() => setRange(item.value)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <div className="budget-chart-legend" aria-hidden="true">
          <span className="bankroll"><Minus size={20} />Bankroll</span>
          <span className="initial"><Minus size={20} />Budget iniziale</span>
        </div>
      </div>
      <p className="budget-chart-period" role="status">
        {movementCount === 0 ? 'Nessuna giocata conclusa nel periodo selezionato.'
          : `${movementCount} ${movementCount === 1 ? 'giocata conclusa' : 'giocate concluse'} nel periodo.`}
        {' '}Dal {new Date(data[0].timestamp).toLocaleDateString('it-IT')} al {new Date(now).toLocaleDateString('it-IT')}.
      </p>
      <figure
        className="budget-chart"
        data-testid="bankroll-trend-chart"
        role="img"
        aria-label={`Andamento bankroll da ${formatCurrency(data[0]?.value ?? initialBudget)} a ${formatCurrency(finalBudget)}, ${movementCount} movimenti`}
      >
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 12, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="var(--border)" vertical={false} />
            <XAxis dataKey="label" tick={{ fill: 'var(--text-3)', fontSize: 10 }} axisLine={false} tickLine={false} minTickGap={20} />
            <YAxis tick={{ fill: 'var(--text-3)', fontSize: 10 }} axisLine={false} tickLine={false} width={58} tickFormatter={(value) => `€${Number(value).toFixed(0)}`} domain={['auto', 'auto']} />
            <Tooltip
              contentStyle={{ background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 11 }}
              formatter={(value: any) => [formatCurrency(Number(value)), 'Bankroll']}
              labelFormatter={(_label, payload) => payload?.[0]?.payload?.result ?? 'Bankroll'}
            />
            <ReferenceLine y={initialBudget} stroke="var(--text-3)" strokeDasharray="4 4" />
            <Area type="monotone" dataKey="value" stroke="var(--green)" strokeWidth={2.5} fill="var(--green-dim)" fillOpacity={0.8} activeDot={{ r: 5 }} />
          </AreaChart>
        </ResponsiveContainer>
      </figure>
    </section>
  );
};

export default BankrollTrendChart;
