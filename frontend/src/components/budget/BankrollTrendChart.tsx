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
  const fullData = useMemo<TrendPoint[]>(() => {
    let runningBudget = initialBudget;
    const orderedBets = [...settledBets]
      .map((bet) => ({ bet, timestamp: new Date(bet?.placed_at ?? 0).getTime() }))
      .filter(({ timestamp }) => Number.isFinite(timestamp))
      .sort((left, right) => left.timestamp - right.timestamp);
    const startTimestamp = orderedBets[0]?.timestamp ?? Date.now();
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
  }, [initialBudget, settledBets]);

  const { data, movementCount } = useMemo(() => {
    if (range === 'ALL' || fullData.length <= 1) {
      return { data: fullData, movementCount: Math.max(0, fullData.length - 1) };
    }
    const selected = ranges.find((item) => item.value === range);
    const latestTimestamp = fullData[fullData.length - 1]?.timestamp ?? Date.now();
    const cutoff = latestTimestamp - Number(selected?.days ?? 30) * 24 * 60 * 60 * 1000;
    const earlier = fullData.filter((point) => point.timestamp < cutoff);
    const inside = fullData.filter((point, index) => index > 0 && point.timestamp >= cutoff);
    const baseline = earlier[earlier.length - 1] ?? fullData[0];
    return {
      data: [{ ...baseline, label: 'Inizio periodo', result: 'Valore a inizio periodo' }, ...inside],
      movementCount: inside.length,
    };
  }, [fullData, range]);

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
