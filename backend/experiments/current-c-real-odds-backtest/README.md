# Matematica retrospettiva C con quote reali

## Perimetro del replay

Il runner valuta i pesi congelati della release corrente contro quote reali di
chiusura Bet365. Non riaddestra il modello, non cambia soglie o parametri e non
riscrive gli archivi. I CSV mantengono le colonne originali `B365CH/CD/CA`,
`B365C>2.5/C<2.5`, `B365CAHH/CAHA` e la linea `AHCh`; medie e massimi del mercato
non sono sostituti del prezzo di un bookmaker. La distinzione apertura/chiusura
segue le [note della fonte](https://www.football-data.co.uk/notes.txt).

Il confronto comprende soltanto target successivi alla calibrazione del modello.
I pesi attuali non possono essere retrodatati per valutare fuori campione le
stagioni usate in training, selezione o calibrazione. Il test già consultato
rimane una diagnostica retrospettiva. Per stagioni precedenti servirebbero nuovi
fit cronologici della stessa ricetta, con identità e pesi distinti.

Le feature seguono il confine nominale Nightly delle 03:07 Europe/Rome; la scelta
con prezzi closing è uno scenario separato, perché quei prezzi non sono
dimostrati disponibili al confine Nightly. Le etichette storiche sono ammesse
solo dopo kickoff + due ore o la disponibilità esplicita successiva, quando nota.
La ricostruzione non prova l'assenza di revisioni storiche dei dati.

Sono escluse le identità del holdout originale protetto e della quarantena C.
Il matching CSV richiede lega, data, alias squadra, unicità e risultato concorde.
Le famiglie disponibili sono 1X2, totale gol 2,5 e handicap asiatico; l'assenza
di prezzi storici per BTTS, doppia chance, DNB, altri totali o mercati statistici
non autorizza quote inventate né una valutazione dell'intero C operativo.

Tutte le selezioni con percentuale dinamica valida sono contate, senza top N.
Non si simula il saldo del portafoglio: il numero di opportunità non dimostra
quante sarebbero state finanziate. La classifica distingue sconfitte, mezze
sconfitte, rimborsi, mezze vittorie e vittorie; ordina per esiti negativi
`LOST + HALF_LOST`, con la percentuale calcolata escludendo i rimborsi. Una
frequenza di errore maggiore non equivale da sola a una perdita monetaria maggiore.

## Esecuzione e dati congelati

Usare una directory nuova sotto `backend/artifacts/research/`. Il congelamento
usa esclusivamente il token `TURSO_WATCHDOG_READONLY_TOKEN` e istruzioni SELECT,
senza avvio applicativo. URL e segreti restano nel `.env` privato della radice.
Il runner verifica release, hash del registro e configurazione di probabilità.

```powershell
node backend/experiments/current-c-real-odds-backtest/freeze-inputs.cjs backend/artifacts/research/NEW_RUN
python backend/experiments/current-c-real-odds-backtest/prepare-quotes.py --out backend/artifacts/research/NEW_RUN --refresh-current
node backend/experiments/current-c-real-odds-backtest/run.cjs --inputs backend/artifacts/research/NEW_RUN --out backend/artifacts/research/NEW_RUN/report.json
python backend/experiments/current-c-real-odds-backtest/audit-report.py --report backend/artifacts/research/NEW_RUN/report.json --out backend/artifacts/research/NEW_RUN/audit.json
```

Questi strumenti sono vincolati agli input congelati della release C75 e al
manifest storico esistente; `--refresh-current` acquisisce solo i cinque CSV
2026/27 tramite HTTP. Omettendolo si riusano esclusivamente i CSV già verificati.
Il runner richiede il dataset originale identificato da `artifact.datasetHash`,
non una copia arbitraria con lo stesso nome. Un cambiamento di release, baseline,
pipeline o build richiede una nuova verifica del protocollo; non aggiornare gli
hash attesi per aggirare un'incompatibilità.

L'output conserva coorte completa, astensioni, ogni selezione, quota, fonte,
riga CSV, esito, classifica complessiva/per stagione, hash e limiti. I file sono
dati di prova locali, separati dalle guide correnti. `--limit N` produce una
prova esplicitamente parziale, da non confondere con il replay completo.

La verifica indipendente riconta le selezioni, legge prezzi e risultati dalle
righe CSV originali e confronta tutti gli esiti. Il replay confronta anche gli
input ricostruiti con il dataset per ciascuna lega, sulle sole feature consumate
dal modello, con tolleranza assoluta `1e-12` per il rumore numerico di piattaforma.
Due controlli perturbano il risultato e gli xG del target per rilevare eventuale
uso del risultato nel proprio input. Nessun controllo equivale a una validazione
prospettica o a una prova di redditività reale.

`selector-math.cjs` è un adattatore locale per valutazioni retrospettive. Non
registra previsioni, puntate o prove prospettiche e non modifica sorgenti operativi,
database, provider o `require.cache` globale.

Il selettore operativo richiede quote `odds_api` prepartita fresche e un'identità
tecnica convalidata. I CSV di chiusura scaricati oggi non soddisfano questi
requisiti: l'adattatore separa esplicitamente l'ammissione operativa dalla
matematica, senza inventare `validated`, provenienza o orari storici di cattura.
Il risultato non prova quanto sarebbe stato selezionabile prima della partita.

## Meccanismo e identità

- Legge il TypeScript corrente. Estrae senza riscrittura il blocco di ranking e il
  blocco dei mercati gol di `ChallengerTeamRecommendation`, fermandosi prima dello
  specialista statistico A.
- Calibra tramite `applyCoherentProbabilityPipeline` effettiva con `quotes: []`.
  Per il blending esegue il blocco corrente estratto dalla pipeline, con i suoi
  helper originali e i pesi appresi del profilo. Il controllo della cronologia del
  profilo rimane attivo: il chiamante deve dichiarare un orario di valutazione
  compatibile, senza scambiarlo con una previsione realmente salvata allora.
- Compila gli estratti in moduli isolati con TypeScript. Gli import normali
  risolvono nei moduli `backend/dist` della build corrente.
- Converte tutte le opportunità mediante i blocchi effettivi del runtime per
  candidati, confidenza e percentuali dinamiche; `bestPaperSelections` conserva il
  prezzo migliore per ogni selezione. Il top 3 riguarda solo il picker visivo,
  mentre `qualifyAll` considera tutte le opportunità.
- `identities()` registra SHA-256 di sorgenti completi, estratti, moduli compilati,
  adattatore e pipeline operativa. `buildParity` confronta la compilazione dei tre
  sorgenti principali con i corrispondenti file della build; il runner deve
  richiedere tutti i valori `true`. Se gli ancoraggi degli estratti non sono più
  presenti o univoci, il caricamento fallisce.

Le quote CSV devono conservare `source: football_data_csv`, `priceType: closing`,
`timestampEvidence: observed_snapshot`, `capturedAt` uguale all'osservazione
effettiva del file e `updatedAt` assente. Il timestamp non afferma quando il
bookmaker avesse pubblicato quel prezzo. Fogli incompleti, conflittuali o con alias
incoerenti restano esclusi. Sono supportati solo mercati gol; nessun fallback
inventa statistiche dello specialista.

## Interfaccia

```javascript
const math = require('./selector-math.cjs');
const probabilities = math.calibrateAndBlend({
  matrix, rawProbabilities, profile, mode, forecastAt, quotes,
});
const recommendation = math.evaluateGoalRecommendations({
  decision: {
    prospectiveMatrix: probabilities.matrix,
    modelVersion,
    probabilityConfiguration,
    probabilityConfigurationHash,
  },
  quotes, competition, allowedMarkets,
});
const allQualified = math.qualifyAll(
  recommendation.opportunities, recommendation.probabilityConfiguration,
);
```

Le proprietà `.raw`, `.calibrated`, `.decision` e `.matrix` conservano gli stadi
distinti. I candidati qualificati espongono probabilità ed EV in frazione, la quota
originale e la percentuale dinamica suggerita dal motore; nessun limite di top N o
saldo viene applicato da questo adattatore matematico.

## Verifica locale

Dalla root del repository, dopo la build backend corrente:

```powershell
node --test backend/experiments/current-c-real-odds-backtest/selector-math.test.cjs
```

I test usano fixture artificiali dichiarate e confrontano il codice effettivo:
calibrazione identity/isotonica/temperatura, blending con pesi appresi, 1X2,
over/under interi/mezzi/quarti, handicap asiatici positivi/negativi/interi/mezzi/quarti,
assenza di opportunità, fogli incompleti/conflittuali, alias errati, provenienza CSV
e ammissione operativa negata. Una fixture stantia dimostra la differenza voluta
fra matematica dei prezzi e freschezza operativa, senza spostarne i timestamp.
