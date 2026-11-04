import json, random, collections, sys
from pathlib import Path
from datetime import datetime
p=Path(sys.argv[1]);data=json.loads((p/'summary.json').read_text(encoding='utf-8'));rows=[json.loads(s) for s in (p/'predictions.jsonl').read_text(encoding='utf-8').splitlines()];rng=random.Random(10429);out={}
for league in data['groups']:
 a=[r for r in rows if league=='ALL' or r['competition']==league];clusters=collections.defaultdict(list)
 for r in a:
  date=datetime.fromisoformat(r['date'].replace('Z','+00:00'));y,w,_=date.isocalendar();clusters[(r['competition'],y,w)].append(r)
 groups=list(clusters.values());d=[]
 for _ in range(1000):
  selected=[rng.choice(groups) for j in groups];num=sum((r['contextual']-r['outcome'])**2-(r['ensemble']-r['outcome'])**2 for g in selected for r in g);den=sum(map(len,selected));d.append(num/den)
 d.sort();out[league]={'clusters':len(groups),'replicates':1000,'seed':10429,'brier_delta_95pct':[d[24],d[974]]}
data['bootstrap']=out;(p/'summary.json').write_text(json.dumps(data,indent=2,ensure_ascii=False),encoding='utf-8')
lines=['# Replay Modello A: contesto storico parziale','','Replay appaiato sulle 6.022 partite; le stime contestuali non costituiscono la probabilità finale operativa.','','| Campionato | N | Over osservati | Ensemble grezzo: Brier / Log Loss | Con contesto parziale: Brier / Log Loss | Delta Brier | IC95% delta |','|---|---:|---:|---:|---:|---:|---:|']
for league,g in data['groups'].items():
 a=g['ensemble'];b=g['contextual'];ci=out[league]['brier_delta_95pct'];lines.append(f"| {league} | {a['n']} | {a['observed']*100:.2f}% | {a['brier']:.5f} / {a['logLoss']:.5f} | {b['brier']:.5f} / {b['logLoss']:.5f} | {b['brier']-a['brier']:+.5f} | [{ci[0]:+.5f}; {ci[1]:+.5f}] |")
lines+=['','Bootstrap appaiato per campionato e settimana, 1.000 repliche, seed 10429; intervalli descrittivi, non prova di causalità.','','## Limiti','- Timestamp storici di pubblicazione e revisione xG non disponibili.','- Contesto ricostruito dalle sole statistiche delle partite esportate: mancano dati giocatori, arbitri e altri segnali storici.','- Calibrazione completa, quote prepartita e blending di mercato non ricostruiti; i relativi campi sono null.','- Parametri di configurazione attuali applicati retrospettivamente; nessun holdout nuovo indipendente.','- Il confronto modifica insieme contesto e scala del vantaggio casa: non isola il contributo del solo contesto.','- Informazioni disponibili proxy: calcio d’inizio + due ore; non è una ricevuta del provider.','','Le fasce di calibrazione per ciascuna lega e stadio sono in `summary.json`; gli output individuali sono in `predictions.jsonl`.']
(p/'report.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
