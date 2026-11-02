import { ProbBar, DistChart } from './PredictionStatPrimitives';
import ShotsSection from './ShotsSection';

/** Sporting probabilities only: no bookmaker prices or quote requests. */
export default function SportingAnalysis({ prediction, loading }: {
  prediction: any; teams: any[]; match: any; loading: boolean;
}) {
  if (!prediction) return <section className="pr-card"><div className="pr-card-body" role="status">
    {loading ? 'Calcolo dei dati sportivi in corso…' : 'Analisi sportiva non disponibile per questa partita.'}
  </div></section>;
  const gp = prediction.goalProbabilities || {};
  const totals: Record<string, number> = {};
  Object.entries(gp.exactScore || {}).forEach(([score, probability]) => {
    const parts = score.match(/^(\d+)-(\d+)$/);
    if (!parts || typeof probability !== 'number' || !Number.isFinite(probability) || probability < 0) return;
    const total = String(Number(parts[1]) + Number(parts[2]));
    totals[total] = (totals[total] || 0) + probability;
  });
  const shots = prediction.shotsPrediction;
  const hasShots = shots?.home?.totalShots?.distribution && shots?.home?.shotsOnTarget?.distribution
    && shots?.away?.totalShots?.distribution && shots?.away?.shotsOnTarget?.distribution
    && shots?.combined?.totalShots && shots?.combined?.totalOnTarget
    && shots?.combined?.overUnder && shots?.combined?.onTargetOverUnder;
  const probabilityRows: Array<[string, unknown]> = [
    ['1 · Vittoria casa', gp.homeWin], ['X · Pareggio', gp.draw], ['2 · Vittoria ospite', gp.awayWin],
    ['Over 1.5 gol', gp.over15], ['Over 2.5 gol', gp.over25], ['Over 3.5 gol', gp.over35],
    ['Entrambe segnano', gp.btts],
  ];
  return <div className="pr-sporting-analysis">
    <section className="pr-card" aria-label="Grafici gol"><header className="pr-card-head"><h2>Gol e risultato</h2></header>
      <div className="pr-card-body"><p>Probabilità sportive del modello, indipendenti dalla disponibilità delle quote.</p>
        <div className="pr-g2"><div>{probabilityRows.map(([label, value]) => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
          ? <ProbBar key={label} label={label} value={value} /> : null)}</div><div>
          {Object.keys(totals).length > 0 && Number.isFinite(prediction.lambdaHome) && Number.isFinite(prediction.lambdaAway)
            && <DistChart dist={totals} expected={prediction.lambdaHome + prediction.lambdaAway} title="Distribuzione dei gol totali" />}
          <dl className="pr-sporting-xg"><div><dt>{prediction.homeTeam} · gol attesi</dt><dd>{Number.isFinite(prediction.lambdaHome) ? prediction.lambdaHome.toFixed(2) : 'Non disponibile'}</dd></div>
            <div><dt>{prediction.awayTeam} · gol attesi</dt><dd>{Number.isFinite(prediction.lambdaAway) ? prediction.lambdaAway.toFixed(2) : 'Non disponibile'}</dd></div></dl>
        </div></div>
      </div></section>
    <section aria-label="Grafici tiri"><h2>Tiri e tiri in porta</h2>{hasShots ? <ShotsSection homeTeam={prediction.homeTeam} awayTeam={prediction.awayTeam} shotsPrediction={shots} />
      : <p className="pr-info">Previsione dei tiri non disponibile con i dati di questa partita.</p>}</section>
  </div>;
}
