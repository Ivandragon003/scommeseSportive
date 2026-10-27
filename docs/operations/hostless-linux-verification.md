# Verifica locale Linux di C per Hostless — 27 ottobre 2026

## Esito e confini

L'inferenza C funziona nel target Docker `runtime` previsto per backend e worker, Linux x86_64, Node **20.20.2**. Non invoca Python: il runtime applicativo legge direttamente gli alberi numerici CatBoost JSON. Non è stato cambiato alcun modello, peso o risultato del benchmark precedente.

Artefatto verificato: candidato locale `C-906371b0b3a1e2c8`, 4.697.002 byte, 120 alberi home e 120 away, peso 0,75 e temperatura 0,8. Non è `diagnosticOnly`; conserva **`productionValidated=false` e `status=CANDIDATE`**. Questo test dimostra esecuzione tecnica, senza promuoverlo a champion, attestare qualità predittiva o provare che sia già presente nel registry remoto. La baseline usata dal microbenchmark è esplicitamente simulata.

La parità è verificata su 70 valori dei tre tipi di candidato esportati dal training locale: errore massimo Node rispetto ai riferimenti **0**; ricaricamento degli stessi JSON con **CatBoost nativo Linux 1.2.8**: errore massimo **5,55 × 10⁻¹⁷**. Il confronto nativo usa Python 3.11 e NumPy 2.2.6 nel solo target `ml-verification`. Tutte le dipendenze Python risolte di questo target sono fissate in `requirements-linux-verification.txt`; il training settimanale mantiene il proprio file requisiti e processo separato.

Il test Linux `research-catboost.test.js` passa **4/4, zero skip**, incluso vero training CatBoost sui dati dichiaratamente sintetici della fixture. Non viene eseguito training sui dati reali durante questo collaudo.

## Misure ripetibili

Docker Desktop Linux locale, rete disabilitata durante l'esecuzione, limite RAM 256 MiB, stesso artefatto e 1.000 inferenze dopo riscaldamento. Valori di un'esecuzione: le quote CPU imposte dal container introducono pause di throttling.

| Misura | 0,25 vCPU | 0,5 vCPU |
| --- | ---: | ---: |
| Caricamento e validazione artefatto/parity | 313 ms | 206 ms |
| Inferenza C mediana | 0,134 ms | 0,134 ms |
| Inferenza C p95 | 0,345 ms | 0,277 ms |
| Massimo singola inferenza | 93,4 ms | 80,6 ms |
| Gruppo di 20 inferenze sequenziali | 73,9 ms | 2,7 ms |
| Tempo totale script, inclusi controlli/parity | 1,79 s | 0,87 s |
| CPU utente + sistema dello script | 384 ms | 359 ms |
| Picco RSS del processo Node | 82,3 MiB | 83,9 MiB |

Il target nativo di verifica raggiunge 106,1 MiB RSS nell'esecuzione parity; questa memoria non si aggiunge al worker in produzione. L'immagine runtime risultante occupa circa **95 MB** locali, contro circa 1,74 GB dell'immagine precedente disponibile sulla macchina. Dimensione immagine e RAM sono grandezze diverse.

Queste misure comprendono il componente ML e gli oggetti parity caricati nello stesso processo. Non comprendono fit A, rete Turso, quote, frontend o storico completo. **256 MiB e 0,25 vCPU sono sufficienti per questo microbenchmark**, ma il dimensionamento del worker completo deve usare anche il test end-to-end e le misure del fit A/liquidazione. Hostless deve essere collaudato con i limiti effettivi dell'account; queste misure non equivalgono a una garanzia di latenza remota.

### Storico locale completo, fit A e inferenza C

`scripts/hostless-resource-sample.js` esegue un secondo carico di sola misura, usando l'export privato locale già esistente `backend/artifacts/research/matches.json`: **8.834 righe**, cinque leghe. Un processo separato prepara il database libSQL su file temporaneo ed esce; un nuovo processo legge con il vero `DatabaseService.getMatches()`, carica C e chiama `buildForecastInput` più `predictHybrid` per le prime venti partite future del file, ordinate cronologicamente. Non crea decisioni, puntate, quote o metriche di benchmark. Non usa il database remoto. I target futuri servono soltanto al carico tecnico.

Nel container Linux a **0,25 vCPU e 256 MiB** il campione passa: RSS 67,2 MiB prima della lettura, 105,8 MiB dopo lo storico, 120,4 MiB dopo il caricamento C, **145,4 MiB massimo** dopo venti elaborazioni. `getMatches` richiede 1,91 s; le prime tre elaborazioni complete A+C richiedono 5,70 s, le venti 22,50 s e 5,38 s CPU; totale della misura 25,29 s e 6,01 s CPU. Risultato grezzo: `backend/artifacts/hostless-resource-linux-025cpu-256m.json`.

Ripetuto a **0,25 vCPU e 512 MiB** nell'immagine finale `sha256:418fb7e6c890b0e4fc923154461d2bc80d77582493d9989caa438fced0d64b1c`, con tutti gli script inclusi e nessun codice Windows montato: RSS 62,7 MiB prima della lettura, 101,3 MiB dopo lo storico, 116,3 MiB dopo C, **141,4 MiB massimo**; `getMatches` 2,11 s, tre elaborazioni 2,80 s, venti 15,31 s e 3,64 s CPU; totale 18,40 s e 4,23 s CPU. Risultato: `backend/artifacts/hostless-resource-linux-025cpu-512m.json`. Le differenze di durata fra esecuzioni comprendono carico locale e throttling; non dimostrano che il solo aumento RAM acceleri il codice.

Questa misura supera il microbenchmark ML per utilità nel dimensionamento, ma resta priva di latenza Turso remota, calibrazione completa, validazioni di mercato, acquisizione quote, commit al ledger, liquidazione e carico HTTP. **256 MiB passano questo campione; 512 MiB per il worker offrono un margine prudente**, se il piano dell'account lo consente. Non considerare il tempo delle venti elaborazioni una garanzia sul tick remoto da concludere entro 60 secondi.

La simulazione end-to-end sulla stessa immagine finale, a 0,25 vCPU e 512 MiB, usa fixture interamente sintetiche e include backend, processi worker, polling, registrazione, riavvio e liquidazione: tre partite 1,37 s, intervallo osservato del polling 14,90 s, riavvio 1,30 s, liquidazione 106 ms. Picco RSS backend 90,2 MiB, worker 97,9 MiB, picco aggregato del container 161,4 MiB. È una prova funzionale separata dal carico storico completo: non sommare né confondere questi tempi con le misure precedenti. Risultato: `backend/artifacts/hostless-integration-linux-final.json`.

I risultati grezzi locali restano nella cartella ignorata `backend/artifacts/hostless-verification/`: `ml-runtime-025cpu.json`, `ml-runtime-050cpu.json`, `ml-native-parity.json`. Il controllo ripetuto sull'immagine runtime finale `sha256:6a3f3423b32ec9775e74f4fb9718f03e1535aff204617e8ebf47e485eab585b6`, senza montare codice Windows, è in `ml-runtime-final.json`: a 0,25 vCPU e 256 MiB ha confermato 70 confronti esatti, 85,4 MiB RSS massimo, p95 0,853 ms e tempo complessivo 3,00 s. La variazione rispetto alla tabella riflette anche il carico della macchina locale; non è una regressione probabilistica. Non contengono credenziali o risultati di puntate reali.

## Comandi

Dalla radice, con Docker Linux attivo e gli artefatti privati locali già disponibili:

```powershell
docker build --target runtime -t footpredictor-hostless:local backend
docker build --target ml-verification -t footpredictor-hostless-ml:local backend
$researchFixtures = Join-Path (Get-Location) 'backend/artifacts/research'
docker run --pull never --rm --network none --cpus 0.25 --memory 256m --mount "type=bind,source=$researchFixtures,target=/fixtures,readonly" footpredictor-hostless:local node scripts/research-ml-smoke.js --artifact /fixtures/followup-coherent-candidate/artifact.json --parity /fixtures/run-20261027/parity.json
docker run --pull never --rm --network none --cpus 0.5 --memory 256m --mount "type=bind,source=$researchFixtures,target=/fixtures,readonly" footpredictor-hostless:local node scripts/research-ml-smoke.js --artifact /fixtures/followup-coherent-candidate/artifact.json --parity /fixtures/run-20261027/parity.json
docker run --pull never --rm --network none --cpus 0.5 --memory 512m --mount "type=bind,source=$researchFixtures,target=/fixtures,readonly" footpredictor-hostless-ml:local /opt/ml/bin/python ml/verify_linux_parity.py --parity /fixtures/run-20261027/parity.json
docker run --pull never --rm --network none footpredictor-hostless-ml:local node --test test/research-catboost.test.js
docker run --pull never --rm --network none --cpus 0.25 --memory 256m --mount "type=bind,source=$researchFixtures,target=/fixtures,readonly" footpredictor-hostless:local node scripts/hostless-resource-sample.js --matches /fixtures/matches.json --artifact /fixtures/followup-coherent-candidate/artifact.json --count 20
```

Gli artefatti non sono copiati nel Dockerfile né versionati. Su un'altra macchina occorre fornire gli stessi artefatti legittimamente esportati o nuovi artefatti accompagnati dai relativi riferimenti parity; la loro assenza non autorizza dati sintetici spacciati per modelli reali.

## Errori, scadenze e avvio

La verifica rifiuta feature non finite, schema incompatibile, modelli mancanti e modello non ancora disponibile al momento della previsione. Il codice C è sincrono e non effettua chiamate di rete: non esiste un subprocesso Python che richieda un timeout. Non è stato introdotto un timeout fittizio attorno a una Promise che non potrebbe interrompere il calcolo sincrono.

La scadenza T−15 deve essere ricontrollata al commit della decisione; un risultato arrivato tardi non può diventare una puntata retroattiva. Il processo persistente e il watchdog esterno devono rilevare un event loop fermo tramite heartbeat. La misura locale non dimostra tolleranza a guasti del nodo Hostless o al rallentamento della rete Turso.

`runtime` usa `npm ci --omit=dev`, utente non privilegiato `node`, digest dell'immagine base fissato e healthcheck HTTP scritto in Node, senza dipendere da `wget`. Lo stesso Dockerfile contiene gli script del worker; **Compose disabilita l'healthcheck HTTP per il worker**, che si controlla tramite il monitor persistente sul database e il watchdog esterno. Python/CatBoost sono presenti soltanto nel target di verifica, che non va selezionato per il deploy web o worker.

Durante il build `npm` ha segnalato advisory già presenti nel lock delle dipendenze di produzione (7, di cui una critical). Questo task non li ha corretti né ha eseguito aggiornamenti automatici: richiedono analisi dell'applicabilità e verifica separata prima di attribuire al pacchetto una nuova garanzia di sicurezza.
