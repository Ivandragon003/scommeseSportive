import { DistChart, ProbBar } from './PredictionStatPrimitives';

const validNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const distribution = (value: unknown): Record<string, number> => value && typeof value === 'object' && !Array.isArray(value)
  ? Object.fromEntries(Object.entries(value).filter(([key, probability]) => /^\d+$/.test(key) && validNumber(probability) && probability <= 1)) : {};
const count = (value: unknown) => validNumber(value) ? value.toFixed(2) : 'Non disponibile';

/** Pre-match sporting estimates, never substitutes for observed fixture statistics. */
export default function DisciplineSection({ prediction }: { prediction: any }) {
  const cards = prediction?.cardsPrediction;
  const fouls = prediction?.foulsPrediction;
  const groups = [
    { title: 'Falli', tone: 'fouls', expected: fouls?.totalFouls?.expected, home: fouls?.homeFouls?.expected,
      away: fouls?.awayFouls?.expected, dist: distribution(fouls?.totalFouls?.distribution), ou: fouls?.overUnder },
    { title: 'Cartellini gialli', tone: 'yellow', expected: cards?.totalYellow?.expected, home: cards?.homeYellow?.expected,
      away: cards?.awayYellow?.expected, dist: distribution(cards?.totalYellow?.distribution), ou: cards?.overUnder },
    { title: 'Cartellini rossi', tone: 'red', expected: cards?.totalRed?.expected, home: undefined, away: undefined,
      dist: distribution(cards?.totalRed?.distribution), ou: null },
  ];
  return <section className="pr-card sporting-discipline" aria-label="Falli e cartellini">
    <header className="pr-card-head"><div><h2>Falli e cartellini</h2><p>Stime pre-partita del modello, distinte dagli eventi osservati.</p></div></header>
    <div className="pr-card-body sporting-discipline__grid">{groups.map(group => <article key={group.tone} className={`discipline-panel discipline-panel--${group.tone}`} aria-label={`Previsione ${group.title.toLowerCase()}`}>
      <h3>{group.title}</h3><dl className="discipline-panel__values"><div><dt>Totale atteso</dt><dd>{count(group.expected)}</dd></div>
        {group.tone !== 'red' && <><div><dt>{prediction.homeTeam || 'Casa'}</dt><dd>{count(group.home)}</dd></div><div><dt>{prediction.awayTeam || 'Ospite'}</dt><dd>{count(group.away)}</dd></div></>}
      </dl>
      {validNumber(group.expected) && Object.keys(group.dist).length > 0
        ? <DistChart dist={group.dist} expected={group.expected} title={`Distribuzione ${group.title.toLowerCase()}`} color={`var(--discipline-${group.tone})`} />
        : <p className="discipline-panel__empty">Distribuzione non disponibile per questa partita.</p>}
      {group.tone === 'red' && validNumber(cards?.totalRed?.probAtLeastOne) && cards.totalRed.probAtLeastOne <= 1
        && <ProbBar label="Almeno un rosso" value={cards.totalRed.probAtLeastOne} color="var(--discipline-red)" />}
      {group.ou && typeof group.ou === 'object' && Object.entries(group.ou).filter(([line]) => Number.isFinite(Number(line)))
        .sort(([a], [b]) => Number(a) - Number(b)).slice(0, 3).map(([line, chances]: [string, any]) => validNumber(chances?.over) && chances.over <= 1
          ? <ProbBar key={line} label={`Over ${line}`} value={chances.over} color={`var(--discipline-${group.tone})`} /> : null)}
    </article>)}</div>
  </section>;
}
