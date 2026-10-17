# Riuso della calibrazione runtime — 17 ottobre 2026

## Problema e intervento

Il primo pronostico di una competizione poteva ricostruire fino a 450 forecast
storici, con refit settimanali, calibrazione globale/per famiglia e apprendimento
del blending. La cache in RAM non sopravviveva al riavvio del processo.

Ora il profilo completo può essere riusato dalla tabella additiva
`runtime_calibration_profiles` in libSQL/Turso. Il riuso evita solamente il
ricalcolo: non cambia formule, iterazioni, campioni, quote ammesse o filtri.

La chiave SHA-256 comprende:

- tutti i dati/label della coorte ammessa al cutoff e le quote d'ingresso usate;
- la competizione e la configurazione effettiva dei modelli, incluse le opzioni da ambiente;
- l'impronta del codice backend distribuito, normalizzando i fine riga.

Due cutoff possono condividere un profilo soltanto quando producono la stessa
coorte disponibile. Il confine esatto kickoff + due ore resta obbligatorio.
Un risultato nuovo o corretto, una quota d'ingresso modificata, una configurazione
diversa o codice diverso producono una chiave differente. Il payload è verificato
con checksum e controlli strutturali. Errori/danni della cache mantengono il
calcolo cronologico completo. Le cache RAM, la deduplicazione e le invalidazioni
per generazione preesistenti restano operative, con TTL di sei ore; scritture
esterne possono quindi restare invisibili fino alla scadenza come in precedenza.

Le curve precedenti usate nel blending sono condivise anche tra partite con
lo stesso prefisso di osservazioni già disponibili. Il prefisso conserva
esattamente ordine e campioni della precedente selezione cronologica.

La nightly prepara le cinque leghe sul proprio backend temporaneo prima delle
giocate automatiche. I modelli girano sul runner GitHub Actions; il backend web
può leggere il risultato compatibile dal database condiviso. La cache conserva
al massimo 128 profili e non elimina dati calcistici o archivi di previsioni.

## Verifiche locali

- `npm test`: build e suite backend superate; verifica finale con
  `npm run test:ci`: 530 test superati, inclusi i nove casi della cache.
- Typecheck e lint backend superati; lint mirato del file di test finale superato.
- Sintassi Bash della nightly e `git diff --check` verificati.
- Avvio Node isolato con libSQL in memoria: healthcheck HTTP 200 e warmup delle
  cinque leghe HTTP 200. Nessun accesso a provider o dati reali.
- Docker Desktop non disponibile: il gate Docker Compose non è stato eseguito.

Un confronto con `PredictionService.ts` del commit `83ac4faf`, eseguito con i
modelli reali su 1.900 fixture sintetiche, ha verificato con `deepStrictEqual`
l'uguaglianza di curve globali, curve per famiglia e pesi appresi su 57.374
osservazioni. Questo verifica equivalenza computazionale, non accuratezza
predittiva o rendimento economico su nuove partite.

Benchmark riproducibile offline dalla cartella `backend`:

```powershell
npm run benchmark:calibration
```

| Percorso | Tempo locale | CPU locale | Refit Dixon–Coles |
| --- | ---: | ---: | ---: |
| Calcolo completo su 1.900 partite | 18.824 ms | 20.406 ms | 45 |
| Riuso RAM nello stesso servizio | < 1 ms | < 1 ms | 0 |
| Nuovo servizio, profilo persistito in libSQL locale | 16 ms | 16 ms | 0 |

I profili del benchmark sono profondamente identici. I tempi escludono latenza
Turso, rete/provider, costruzione del resto del pronostico e quote correnti;
non rappresentano una misura del tempo totale su Hostless.

## Attivazione e limiti

Occorrono la pubblicazione del backend e del workflow aggiornati. La migrazione
viene applicata all'avvio; la nightly popola la cache. Non è necessario
ricompilare il frontend o il pacchetto Android.

La prima coorte mai calcolata resta costosa, soprattutto prima della prima
nightly della nuova versione. Un aggiornamento del codice invalida i profili
precedenti per prudenza. Parametri personalizzati su Hostless devono coincidere
con quelli del runner per condividere il profilo; altrimenti il backend calcola
quello corretto per la propria configurazione. Non è garantita l'eliminazione
di ogni episodio di throttling, che dipende anche dalle risorse e dal traffico.
