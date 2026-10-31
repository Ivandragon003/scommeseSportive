# Modello C: esperimenti Nightly e adozione controllata — 31 ottobre 2026

> **Audit successivo:** le metriche di questo snapshot sono aritmeticamente
> riproducibili, ma cinque dei 1.975 forecast risultano successivi alla partita
> reale e la storia contiene altre date errate. Non usare questo campione come
> prova pre-match valida. L'[audit e la ricostruzione C](c-data-benchmark-audit-2026-10-31.md)
> isolano 22 record e ripetono il confronto su 1.969 target. La candidata qui
> preregistrata non soddisfa la nuova policy qualità; C906 resta il riferimento.

**C906 resta operativo. Nessun miglioramento predittivo o economico è certificato.**
Il lavoro aggiunge un percorso C candidato con tempi Nightly, feature versionate,
selezione dei payout completa e verifica futura. Il metodo A dell'app non è stato
modificato. La baseline research A80 è un oggetto diverso da A operativo.

## Dati e protocollo

L'export SELECT-only del database contiene 8.834 incontri delle cinque leghe,
7.486 con risultato. Sono ricostruite 6.587 osservazioni ammissibili, incluse
le partite senza puntata. I 745 target del vecchio test finale già consultato
sono esclusi prima di training, selezione, calibrazione e metriche di sviluppo.
Non si addestra sulle sole puntate o sulle sole sconfitte.

Il cutoff dell'export sperimentale è `2026-10-30T23:49:05.257Z`. Ogni previsione
nominale usa l'ultimo confine **03:07 Europe/Rome prima del kickoff**, inclusi
ora legale e cambi d'ora. Parametri e feature vengono ricostruiti a quell'istante:
un vecchio dataset T−15 non viene semplicemente rietichettato. Builder, trainer
Python e comparatore controllano gli orari. Le esecuzioni manuali ritardate
possono usare timestamp realmente registrati, distinti dal calendario nominale.

Lo storico non contiene la prova del primo istante di pubblicazione/ingestione
di ogni statistica. Conserva quindi la convenzione storica di disponibilità
non anteriore a kickoff + due ore, ulteriormente ritardata da `availableAt`
quando noto. **È una ricostruzione di sviluppo, non prova della disponibilità
storica esatta al provider.** Per l'adozione valgono esclusivamente nuovi
forecast immutabili registrati prima dei risultati.

I 745 incontri non sono cancellati dall'archivio. Il `ForecastCore` congelato
può usare un loro risultato come passato già disponibile per una previsione
successiva. I target protetti non diventano etichette di ottimizzazione C;
le nuove feature C li escludono anche dalla propria storia aggiuntiva.

## Esperimenti dichiarati

Sei configurazioni fisse, senza ricerca estesa di pesi o iperparametri:

| Variante | Componente ML | Feature aggiuntive | Peso / temperatura |
|---|---|---|---|
| `no_ml` | Nessuna; matrice statistica research | Nessuna | 0 / 1 |
| `development_current_replica` | Famiglia ensemble calibrato | Nessuna | 0,75 / 0,8 |
| `intensity_legacy` | Correzione intensità gol | Nessuna | 0,25 / 1 |
| `intensity_recent_xg` | Correzione intensità gol | xG/xGA recenti e forza avversaria | 0,25 / 1 |
| `intensity_schedule` | Correzione intensità gol | Riposo e gare osservate negli ultimi 7/14 giorni | 0,25 / 1 |
| `intensity_full` | Correzione intensità gol | Entrambi i blocchi | 0,25 / 1 |

CatBoost 1.2.8, CPU, 120 iterazioni, profondità 3, learning rate 0,05,
seed 20261027 e due thread per fit. La replica è riaddestrata sui nuovi input
e split: **non è l'artefatto C906 congelato**, che viene confrontato a parte.
Non sono aggiunte assenze, formazioni o classifica con timestamp non verificabili.
Il carico calendario misura le gare presenti nell'archivio, non inventa coppe
o altre competizioni mancanti.

Ogni fold separa cronologicamente training, scelta, calibrazione e test.
Le etichette di una finestra devono essere disponibili prima della successiva.
La scelta del candidato usa solo la finestra di selezione; i calibratori
coerenti usano solo quella di calibrazione. Il controllo senza ML passa dalla
stessa pipeline di calibrazione delle altre varianti.

| Fold | Training | Selezione | Calibrazione | Test di sviluppo | Scelta su selezione |
|---|---:|---:|---:|---:|---|
| 0 | 3.619 | 655 | 338 | 618 | Replica della famiglia corrente |
| 1 | 4.274 | 664 | 292 | 741 | Intensità + xG recenti |
| 2 | 4.938 | 678 | 355 | 616 | Replica della famiglia corrente |

Le 1.975 osservazioni test sono disgiunte tra fold. Tutti questi risultati
restano di sviluppo: non vengono riclassificati come nuova verifica indipendente.
La ripetizione dell'addestramento con gli stessi dati e seed ha prodotto
le stesse matrici previste, anche dopo la verifica del guard sugli orari.

## Risultati su identiche partite e condizioni

<!-- GENERATED_RESULTS_START -->
| Variante | n comune | Log loss | Brier | ECE |
|---|---:|---:|---:|---:|
| `no_ml` | 1975 | 0,983602 | 0,584662 | 0,016097 |
| `development_current_replica` | 1975 | 0,983539 | 0,585233 | 0,018972 |
| `intensity_legacy` | 1975 | 0,984179 | 0,585089 | 0,018275 |
| `intensity_recent_xg` | 1975 | 0,983217 | 0,584507 | 0,019587 |
| `intensity_schedule` | 1975 | 0,984457 | 0,585252 | 0,019066 |
| `intensity_full` | 1975 | 0,983914 | 0,585024 | 0,017757 |

Per xG recenti contro la replica, la differenza nuova − replica è -0,000321 in log loss e -0,000726 in Brier. Gli IC al 95% per settimana sono [-0,006106; 0,005323] e [-0,004107; 0,002628], su 43 blocchi. Entrambi comprendono zero. L’ECE peggiora rispetto alla replica. **Non è dimostrato un miglioramento robusto; niente adozione da questo risultato.**
<!-- GENERATED_RESULTS_END -->

Le metriche principali sono calcolate **dopo la calibrazione coerente**. Il
market blending con quote contemporanee non è simulato dove tali quote non
esistono. Log loss e Brier più bassi indicano errore minore; il Brier è la
somma multiclasse senza divisione per tre. L'ECE è top-label con dieci
intervalli, distinto dall'ECE classwise del report grezzo Python. Le tabelle
di calibrazione e i confronti per lega sono nel riepilogo JSON.

Gli intervalli usano differenze appaiate e bootstrap per settimana, 500
ricampionamenti, seed 20261031. Per giudicare un confronto si usa la coorte
comune di quel confronto, non metriche di modelli su partite diverse.

### C906 effettivo e ricostruzione

L'artefatto C906 e il suo benchmark effettivo sono stati esportati in sola
lettura e verificati: la configurazione di probabilità coincide. Il vincolo
di disponibilità nel registro personale arriva a `2026-10-29T10:40:00.219Z`.
Nel dataset non ci sono target conclusi non protetti successivi a quel limite
con una previsione nominale ammissibile: il confronto operativo rigoroso ha
**zero osservazioni**, non un risultato favorevole o sfavorevole.

`C906_reconstructed` ricalcola le probabilità dell'artefatto congelato sui soli
dieci target non protetti successivi alla sua validazione, ammettendo una
ricostruzione di sviluppo. Non afferma che il modello fosse già operativo in
quel momento. Il confronto C precedente/nuovo su questi dieci stessi incontri
è nel JSON, ma un solo blocco settimanale non consente una conclusione robusta.
Cambiare soltanto il selettore mantiene identiche le probabilità di C906.

### Rendimenti

ROI e drawdown restano **non disponibili**. Non ci sono prezzi reali freschi
entro cinque minuti dall'istante Nightly per le coorti storiche valutate.
Le quote closing, successive alla previsione o di sola osservazione storica
non vengono anticipate. Le cinque snapshot operative del 30 ottobre sono
conservate, ma i relativi esiti non erano ancora presenti nel database
all'export: non vengono completati o inventati per produrre un ROI.

## Selettore C e conservazione di A

Il nuovo selettore C è autonomo e solo candidato. Valuta dalla matrice i
rendimenti di vittoria, perdita, rimborso, mezza vittoria e mezza perdita;
calcola EV, varianza, rischio negativo e crescita logaritmica al fisso 1%.
Non converte i quarti in scommesse binarie e non usa il ranking di A.
Rifiuta quote senza provenienza, temporalmente invalide o senza il foglio
complementare coerente. Conserva campioni, copertura xG e tempi reali quando
forniti; l'incertezza dei parametri non disponibile resta esplicitamente ignota.
Non viene inventata una confidenza o una penalità quantitativa.

C906 mantiene il vecchio selettore finché non c'è un'adozione approvata.
Gli importi restano 1%, esposizione aperta massima 5% e una sola puntata per
partita e portafoglio. Nessun mercato squadra nuovo è stato aggiunto.

Per A operativo sono congelati **36 sorgenti** proprietari e condivisi contro
il commit `a474e36c`. Sei golden del vero `PredictionService.predict()` verificano
probabilità raw/finali, calibrazione applicata, filtri, ranking, confidenza,
stake e pacchetto finale; il settimo controllo verifica gli hash dei sorgenti.
Coprono anche cartellini, tiri, dati deboli, assenza del partner Poisson e NO_BET.
I sette controlli passano dopo la compilazione C e nella CI Linux.
Le fixture sono sintetiche e dichiarate; non vengono presentate come quote
o risultati sportivi reali. Limiti: curve storiche congelate, non nuovo fit
di calibrazione, e player props disabilitate nelle fixture comportamentali.

## Aggiornamento automatico e stato verificato

Il workflow settimanale ricostruisce i dati Nightly, esegue i sei esperimenti,
finalizza la calibrazione e preregistra una candidata. Non promuove usando i
risultati di sviluppo. Il registro additivo 025 congela modello, configurazione,
selettore, riferimento corrente e prova del dataset. La Nightly raccoglie
forecast comparativi anche sulle astensioni, senza puntate aggiuntive.

Una candidatura viene giudicata una sola volta sui **primi 500 FUTURE_TEST**
preregistrati, tutti con risultati disponibili. Servono almeno quattro leghe,
quattro mesi di calendario distinti e quattro periodi, intervalli appaiati interamente favorevoli per log loss
e Brier, calibrazione non peggiore e stabilità in almeno quattro leghe.
I dati CALIBRATION non entrano nel verdetto. Il confronto corrente viene
congelato; un riferimento cambiato non viene sostituito di nascosto.
Un NO-GO chiude quella candidatura invece di ripetere il test fino a ottenere GO.

L'adozione cambia solo la tupla C; tre fallimenti tecnici del modello su
partite e snapshot distinti possono ripristinare la tupla precedente, anche
C906. Errori del provider o del lettore del registro non autorizzano un
rollback implicito. Se il registro è illeggibile C si astiene, mentre A può
proseguire. La policy fallback v2 conserva il proprio hash; adozioni, rollback
e sospensioni hanno identità v3 distinte.

La migrazione 025 è stata applicata al database condiviso e sono verificate
le dieci guardie di immutabilità. È preregistrata `C-63f359b9e5cd3d89`, con
selettore `payout-aware-v1`, dal `2026-10-31T00:12:30.534Z`. Il primo riesame
ha risposto `independent_future_evidence_insufficient`: zero forecast futuri
raccolti e zero eventi di adozione. **C906 è rimasto attivo.**
La variabile GitHub `RESEARCH_REGISTRY_WRITES_ENABLED` è ora `true` per il
nuovo ciclo. La prima raccolta della candidata durante la Nightly resta da
osservare. La pubblicazione del codice GitHub non attesta un nuovo deploy web.

Prima/dopo la preregistrazione sono identici gli hash di portafogli, ledger,
puntate e cancellazioni: due portafogli, otto movimenti, sei puntate e cinque
cancellazioni archiviate. Nessuna puntata o movimento è stato aggiunto.

## Riproducibilità

I file completi congelati sono locali, esclusi da Git per dimensione. Il
[riepilogo versionato](c-hybrid-improvements-2026-10-31.json) conserva metriche,
intervalli, finestre, versioni e SHA256. Directory locale:
`backend/artifacts/research/c-improvement-20261031/`.

Per ricostruire un export di sviluppo da un archivio congelato, dalla root:

```powershell
node backend/scripts/research-challenger-development.js dataset --matches backend/artifacts/research/c-improvement-20261031/matches.json --asof 2026-10-30T23:49:05.257Z --out backend/artifacts/research/reproduction/dataset.json --hour 3 --minute 7
python backend/ml/train.py --input backend/artifacts/research/reproduction/dataset.json --output backend/artifacts/research/reproduction/training --experiment controlled-challenger --iterations 120 --depth 3 --folds 3
node backend/scripts/prepare-challenger-comparison.js --training backend/artifacts/research/reproduction/training --dataset backend/artifacts/research/reproduction/dataset.json --incumbent backend/artifacts/research/c-improvement-20261031/actual-incumbent-artifact.json --incumbent-registry backend/artifacts/research/c-improvement-20261031/actual-incumbent-registry.json --out backend/artifacts/research/reproduction/inputs
node backend/scripts/research-challenger-development.js evaluate --dataset backend/artifacts/research/reproduction/dataset.json --plan backend/artifacts/research/reproduction/inputs/plan.json --variants backend/artifacts/research/reproduction/inputs/variants.json --out backend/artifacts/research/reproduction/comparison.json --markdown backend/artifacts/research/reproduction/comparison.md
```

Gli output devono essere nuovi. Per ripetere esattamente il confronto registrato
usare il dataset `nightly-extended-canonical.json`, il manifest e il piano in
`comparison-canonical-inputs/` e gli stessi argomenti `evaluate` in una nuova
destinazione. Gli hash distinguono anche i metadati del dataset. L'orario e le
righe non sono modificati per far superare un guard di disponibilità.

Controlli eseguiti: build, typecheck e lint backend; 95 test mirati, 21 Python;
CI completa [41148331411](https://github.com/Ivandragon003/scommeseSportive/actions/runs/41148331411)
su `96720fb2`, backend 1.109 totali / 1.108 passati / uno opzionale saltato,
zero fallimenti, e frontend riuscito. Compose isolato con database sintetico:
build/avvio, health backend, frontend/proxy HTTP 200, accesso amministratore,
bootstrap 025, trigger e riapertura verificati. I container di prova sono rimossi.

Il primo report parziale è scartato: una compilazione concorrente aveva
temporaneamente rimosso file letti dal comparatore. I risultati utilizzati
sono quelli del ricalcolo a compilazione ferma, senza esclusioni di filesystem.
La pulizia di quattro cartelle temporanee residue di test è stata rifiutata
dalla revisione automatica (`blocked by policy`); non riguarda i dati applicativi.
