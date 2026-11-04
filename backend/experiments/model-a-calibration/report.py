"""Summarize paired, league-week cluster bootstrap; no model or database writes."""
import collections, datetime, json, math, random, sys
from pathlib import Path

folder = Path(sys.argv[1])
rows = [json.loads(line) for line in (folder / 'predictions.jsonl').read_text(encoding='utf8').splitlines()]
summary = json.loads((folder / 'summary.json').read_text(encoding='utf8'))
rng = random.Random(26427)
def losses(r, key):
    p = min(1-1e-15, max(1e-15, r[key])); y = r['outcome']
    return ((p-y)**2, -(y*math.log(p)+(1-y)*math.log(1-p)))
for name, group in summary['groups'].items():
    subset = [r for r in rows if r['calibrated'] is not None and (name == 'ALL' or r['competition'] == name)]
    blocks = collections.defaultdict(list)
    for r in subset:
        week = datetime.datetime.fromisoformat(r['date'].replace('Z', '+00:00')).date().isocalendar()[:2]
        blocks[(r['competition'], week)].append(r)
    clusters = list(blocks.values())
    group['bootstrap'] = {'replicates': 1000, 'unit': 'competition-week', 'seed': 26427, 'clusters': len(clusters)}
    for other in ('ensemble', 'contextual'):
        pairs = [[tuple(a-b for a,b in zip(losses(r,'calibrated'), losses(r,other))) for r in cluster] for cluster in clusters]
        draws = [[], []]
        for _ in range(1000):
            sampled = [pairs[rng.randrange(len(pairs))] for _ in pairs]
            n = sum(map(len,sampled))
            for metric in (0,1): draws[metric].append(sum(x[metric] for block in sampled for x in block)/n)
        group['bootstrap']['calibrated_minus_'+other] = {
            metric: {'difference': group['calibrated'][metric]-group[other][metric],
                     'ci95': [sorted(draws[i])[24], sorted(draws[i])[974]]}
            for i,metric in enumerate(('brier','logLoss'))}
(folder / 'summary.json').write_text(json.dumps(summary, indent=2, ensure_ascii=False)+'\n', encoding='utf8')
lines = [
    '# Modello A: replay indicativo della calibrazione Over 2,5', '',
    'La curva sperimentale usa solo Over 2,5 fuori campione, non la famiglia operativa completa: non è la calibrazione operativa ricostruita. Gli esiti si considerano disponibili al kickoff + 2 ore; il momento di previsione è approssimato al kickoff. Lo stesso algoritmo isotonico e shrinkage del motore sono applicati alle ultime 450 previsioni ammissibili per campionato, con almeno 120 osservazioni; i primi casi privi di curva sono esclusi da tutti i confronti.', '',
    'Il contesto è parziale e modificato insieme alla scala casa. Non sono verificabili i timestamp di disponibilità o revisione degli xG, né la configurazione operativa storica. I risultati non sono la probabilità finale né dimostrano redditività.', '',
    '## Metriche appaiate', '',
    '| Campionato | N | Over effettivi | Brier grezzo | Brier contesto | Brier curva proxy | Log Loss grezzo | Log Loss contesto | Log Loss curva proxy | Δ Brier proxy − contesto, IC95% | Δ Log Loss proxy − contesto, IC95% |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|'
]
for name,g in summary['groups'].items():
    a,b,c=(g[k] for k in ('ensemble','contextual','calibrated'))
    bs=g['bootstrap']['calibrated_minus_contextual']; bi=bs['brier']; li=bs['logLoss']
    lines.append(f"| {name} | {g['eligible']} | {a['observed']:.2%} | {a['brier']:.5f} | {b['brier']:.5f} | {c['brier']:.5f} | {a['logLoss']:.5f} | {b['logLoss']:.5f} | {c['logLoss']:.5f} | {bi['difference']:+.5f} [{bi['ci95'][0]:+.5f}; {bi['ci95'][1]:+.5f}] | {li['difference']:+.5f} [{li['ci95'][0]:+.5f}; {li['ci95'][1]:+.5f}] |")
lines += ['', 'Bootstrap appaiato con 1.000 repliche, campionamento per blocchi campionato-settimana (seed 26427). Intervalli non correggono per confronti multipli e non includono incertezza di disponibilità dei dati storici.', '', '## Calibrazione per fasce', '', 'Per ogni campionato e stadio: fascia prevista, numero, probabilità media e frequenza effettiva. Le celle vuote non vengono riportate.', '']
for name,g in summary['groups'].items():
    lines += [f'### {name}', '', '| Stadio | Fascia | N | Media prevista | Frequenza osservata |', '|---|---|---:|---:|---:|']
    for key in ('ensemble','contextual','calibrated'):
        for b in g[key]['bins']:
            if b['n']: lines.append(f"| {key} | {b['range']} | {b['n']} | {b['predicted']:.2%} | {b['observed']:.2%} |")
    lines.append('')
lines += ['## Verifica separata delle quote', '',
          'L’audit in sola lettura ha rilevato snapshot Over/Under completi pre-kickoff per 254 partite della coorte. Nelle decisioni research A esistono 4 partite con uno snapshot non sintetico acquisito prima di una decisione pre-kickoff (7 decisioni complessive); nessuna delle decisioni registrate riguarda Over 2,5. Gli snapshot individuati sono circa sei giorni precedenti alle decisioni: non è dimostrato che questi prezzi fossero usati o sufficientemente freschi. Le previsioni di questo replay sono as-of kickoff e quindi successive alle decisioni: non sono utilizzabili per un confronto decisionale senza potenziale contaminazione. Nessun blending di mercato viene imputato.', '',
          'Per un confronto occorrono probabilità calcolate allo stesso istante decisionale, configurazione e profilo as-of, prezzi effettivamente disponibili e accettabili a quell’istante. Quattro partite non costituirebbero comunque una base statistica affidabile.', '']
(folder / 'report.md').write_text('\n'.join(lines)+'\n', encoding='utf8')
