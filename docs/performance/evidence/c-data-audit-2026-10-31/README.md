# Dati di audit per la qualità dello storico C

Asset tecnici congelati a supporto della
[quarantena C](../../../../backend/src/research/challenger-data-quarantine.json)
e del [protocollo Research](../../../research-platform.md). Non sono istruzioni
operative o una certificazione corrente delle fonti esterne.

- `matches-frozen.json.gz` e `teams-reference.json.gz`: export sorgente e alias.
- `actual-c906-registry.json`: metadati dell'identità e della disponibilità
  dichiarate del vecchio C906, senza retrodatazione. I vecchi pesi sono esclusi
  dal ripristino per rispettare la richiesta di eliminarli senza archiviarli.
- `source-evidence.json`: dossier sui conflitti e riferimenti delle acquisizioni.
- `persisted-primary-derived.json.gz`, `persisted-primary-statistics.json`:
  derivati ripetibili del payload primario conservato, non una nuova acquisizione.
- `frozen-split-plan.json`: finestre fissate per il confronto qualità.
- `before/` e `after/`: probabilità e metadati prima/dopo le esclusioni. Il campione
  precedente contiene conflitti temporali: non è una prova pre-match valida.
- Gli altri JSON sono controlli dell'audit e non stato del sito o del provider.

Il ripristino dati delle tre stagioni legge `matches-frozen.json.gz` nel suo
percorso attuale e conserva dataset, finestre e probabilità già salvate. Non
ripristina modelli storici. La policy di quarantena contiene propri hash e
riferimenti storici: non
aggiornarla per risolvere collegamenti documentali o rendere accettabile un modello.

## Ricalcolo senza sorgenti esterne

Dalla radice, con destinazione nuova:

```powershell
python backend/scripts/audit-challenger-metrics.py --bundle docs/performance/evidence/c-data-audit-2026-10-31/after --out backend/artifacts/research/audit-c-metrics --expected-records 6573 --expected-cohort 1969 --gzip
```

Per ripristinare i dati e le probabilità salvate usare la
[guida del bundle a tre stagioni](../c-three-season-backtest-2026-10-31/README.md).
La rigenerazione delle previsioni dai vecchi pesi non è più disponibile; il
ricalcolo delle metriche dalle probabilità conservate resta supportato.
I resoconti degli audit sui tempi dichiarati e sui payload restano consultabili.
Le verifiche che richiedevano i vecchi artefatti non sono ripetibili senza quei
pesi. `audit-challenger-sources.py` effettua nuove richieste HTTP: non è richiesto
per il ricalcolo delle metriche e non dimostra quando i vecchi dati furono
pubblicati.

Le evidenze locali complete nominate dalla policy possono trovarsi sotto
`backend/artifacts/research/c-data-audit-20261031/sources/`; non sono credenziali
né contenuti da ricostruire inventando timestamp. I 22 conflitti noti sono
esclusi; l'assenza di conflitti sconosciuti non è certificata.
