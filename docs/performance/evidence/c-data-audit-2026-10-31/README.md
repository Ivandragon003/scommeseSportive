# Dati di audit per la qualità dello storico C

Asset tecnici congelati a supporto della
[quarantena C](../../../../backend/src/research/challenger-data-quarantine.json)
e del [protocollo Research](../../../research-platform.md). Non sono istruzioni
operative o una certificazione corrente delle fonti esterne.

- `matches-frozen.json.gz` e `teams-reference.json.gz`: export sorgente e alias.
- `actual-c906-artifact.json.gz`, `actual-c906-registry.json`: artefatto congelato
  e metadati necessari a verificarne identità e disponibilità, senza retrodatazione.
- `source-evidence.json`: dossier sui conflitti e riferimenti delle acquisizioni.
- `persisted-primary-derived.json.gz`, `persisted-primary-statistics.json`:
  derivati ripetibili del payload primario conservato, non una nuova acquisizione.
- `frozen-split-plan.json`: finestre fissate per il confronto qualità.
- `before/` e `after/`: probabilità e metadati prima/dopo le esclusioni. Il campione
  precedente contiene conflitti temporali: non è una prova pre-match valida.
- Gli altri JSON sono controlli dell'audit e non stato del sito o del provider.

Il ripristino delle tre stagioni legge due di questi gzip nel loro percorso
attuale. La policy di quarantena contiene propri hash e riferimenti: non
aggiornarla per risolvere collegamenti documentali o rendere accettabile un modello.

## Ricalcolo senza sorgenti esterne

Dalla radice, con destinazione nuova:

```powershell
python backend/scripts/audit-challenger-metrics.py --bundle docs/performance/evidence/c-data-audit-2026-10-31/after --out backend/artifacts/research/audit-c-metrics --expected-records 6573 --expected-cohort 1969 --gzip
```

Per il ripristino completo usare la [guida del bundle a tre stagioni](../c-three-season-backtest-2026-10-31/README.md).
I programmi `audit-challenger-temporal.py` e `audit-challenger-persisted-details.js`
verificano tempi dichiarati e payload salvati. `audit-challenger-sources.py`
effettua invece nuove richieste HTTP: non è richiesto per un ricalcolo offline
e non dimostra quando i vecchi dati furono pubblicati.

Le evidenze locali complete nominate dalla policy possono trovarsi sotto
`backend/artifacts/research/c-data-audit-20261031/sources/`; non sono credenziali
né contenuti da ricostruire inventando timestamp. I 22 conflitti noti sono
esclusi; l'assenza di conflitti sconosciuti non è certificata.
