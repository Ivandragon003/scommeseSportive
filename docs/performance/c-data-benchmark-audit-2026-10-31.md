# Audit dei dati e del benchmark C — 31 ottobre 2026

**Il benchmark precedente è riproducibile aritmeticamente, ma non è un benchmark pre-match temporalmente affidabile.** Cinque dei 1.975 target erano previsti dopo il programma ufficiale della partita; altri risultati e statistiche di incontri sospesi potevano entrare nella storia prima del completamento. L'accordo con Understat non bastava a verificare il calendario reale.

La correzione riguarda esclusivamente C. Nessun dato condiviso è stato riscritto e nessun sorgente di A operativo è cambiato. C906 resta il riferimento operativo; nessun modello è stato adottato sulla base di queste prove di sviluppo.

## 1. Perimetro, dati congelati e significato delle verifiche

L'archivio congelato contiene **8.834 incontri**, 7.486 conclusi e 1.348 senza risultato, in cinque leghe e 25 coppie lega/stagione, dal 2022/23 al 2026/27. Il cutoff del confronto resta `2026-10-30T23:49:05.257Z`. Il registro squadre letto separatamente contiene 139 club.

Il nuovo export SELECT-only conferma gli stessi 8.834 ID. Cinque partite del 30 ottobre hanno ora il risultato, e una ha un orario differente: questi aggiornamenti **non sono aggiunti retroattivamente al corpus congelato**. Gli orari `created_at` del database indicano l'inserimento nell'app, non la prima pubblicazione delle statistiche né ogni successiva revisione.

| Livello | Verificato | Limite |
|---|---|---|
| Integrità locale | Chiavi, domini, valori mancanti, coorti, matrici e metadati controllati | Un file coerente può contenere un calendario sbagliato |
| Fedeltà a Understat | Tutti gli 8.834 ID riconciliati; risultati/xG dei 7.486 conclusi coerenti con la fonte attuale | La fonte attuale può conservare programmi obsoleti o essere stata revisionata |
| Statistiche dettagliate | 25 partite mirate, cinque per lega, 200 campi confrontati con `/getMatchData`, zero differenze | Campione selezionato sugli scarti: non è una verifica HTTP completa di ogni statistica |
| Calendario ufficiale | Dossier specifici per i casi contestati, con URL, acquisizione e hash | Non è una certificazione indipendente del kickoff di tutti gli incontri |
| Disponibilità storica | Confini computazionali e dati effettivamente esportati verificati | Nessun timestamp osservato di prima disponibilità per i 7.486 risultati storici |
| Previsioni prospettiche | Esiste un percorso con congelamento pre-risultato e verifica separata degli esiti | Il replay storico non diventa una prova prospettica |

Le 122 acquisizioni HTTP dell'audit conservano URL, SHA256 e data di acquisizione. L'acquisizione odierna verifica il contenuto disponibile oggi; non dimostra che fosse identico o già disponibile al forecast storico. Non sono utilizzati provider a pagamento o scraper browser.

## 2. Completezza, duplicati e confronto delle fonti

Non risultano duplicati di ID o fixture, orfani rispetto al registro dei 139 club, collisioni o frammentazioni dell'identità locale. Nei conclusi sono presenti risultati, xG, tiri, tiri in porta e cartellini; manca una coppia di valori dei falli. Nei 1.975 target questi campi sono presenti. I controlli non hanno trasformato null in zero.

Un controllo aggiuntivo SELECT-only confronta anche tutti i valori normalizzati con i dettagli Understat persistiti: **59.880 campi su 7.485 partite coincidono**, senza differenze. Per `understat_27930` gli otto campi del payload primario persistito non sono disponibili e restano non verificati da quel controllo; non vengono trasformati in zero. Il payload persistito non è una seconda fonte indipendente: conferma la normalizzazione e va distinto dai 25 riscontri HTTP attuali. Il replay offline dei derivati conservati riproduce i conteggi.

Le quote non fanno parte di questa riconciliazione statistica: nessuna quota CSV closing o ricostruita è stata ammessa come prezzo Nightly per calcolare ROI.

Football-data.co.uk riconcilia data civile e squadre di **1.969 dei 1.975 target**. Nei 728 target con statistiche differenti ci sono 916 differenze di campo: non sono automaticamente errori Understat. Il campione di 200 campi direttamente verificato nella fonte primaria coincide con il database, anche quando differisce dal CSV. Si conserva quindi la priorità Understat; non sono effettuate sovrascritture o matching con tolleranze di data silenziose.

## 3. Anomalie temporali e semantiche dimostrate

### Cinque previsioni successive alla partita

Gli orari ufficiali sotto sono convertiti dai programmi locali dei club con i fusi Europe/Rome o Europe/Paris. Non derivano dall'aggiunta arbitraria di `Z` a una data naive di Understat.

| ID | Partita | Forecast congelato UTC | Programma ufficiale UTC | Evidenza |
|---|---|---|---|---|
| `understat_27724` | Genoa–Atalanta | 18/05/2025 01:07 | 17/05/2025 18:45 | [Atalanta, convocati del 16 maggio](https://www.atalanta.it/news/i-convocati-per-genoa-atalanta-x2722) |
| `understat_29720` | Brest–Lorient | 08/02/2026 02:07 | 07/02/2026 18:00 | [Lorient, informazioni della trasferta](https://www.fclorient.bzh/stade-brestois-29-fc-lorient-les-informations-pratiques-pour-le-deplacement/) |
| `understat_29722` | Lens–Rennes | 08/02/2026 02:07 | 07/02/2026 16:00 | [Rennes, programmazione](https://www.staderennais.com/actualites/programmation/lens-srfc-programme) |
| `understat_29723` | Metz–Lille | 08/02/2026 02:07 | 06/02/2026 19:45 | [Metz, informazioni della partita](https://www.fcmetz.com/articles/metz-lille%2C-les-infos-pratiques) |
| `understat_29724` | Nantes–Lyon | 08/02/2026 02:07 | 07/02/2026 20:05 | [Nantes, programmazione](https://www.fcnantes.com/articles/article2809.php?num=48436) |

Risultati e xG coincidevano con Understat, ma la previsione non era realmente pre-match. Il vecchio controllo verificava la coerenza con il calendario importato, non la correttezza di quel calendario. Cinque righe su 1.975 non dimostrano da sole la dimensione del bias: anche le feature e i parametri degli incontri successivi possono dipendere dalla storia errata.

Valencia–Oviedo (`understat_29218`) è il sesto target contestato: il rinvio dal 29 al 30 settembre 2025 non rendeva il forecast precedente post-match, ma anticipava artificialmente di un giorno la disponibilità del risultato nella storia. [Comunicazione del Valencia](https://www.valenciacf.com/aplazado-el-partido-del-valencia-cf-ante-el-real-oviedo1).

### Partite sospese e risultato finale attribuito troppo presto

Udinese–Roma (`understat_22621`) è archiviata al 14 aprile 2024 con il risultato finale 1–2, ma fu completata il 25 aprile. Il risultato finale non era disponibile due ore dopo la prima data. Questo può contaminare le feature delle partite nei giorni intermedi. [Udinese, comunicazione della ripresa](https://www.udinese.it/Apps/WebObjects/Udinese.woa/wa/viewSection?id=74517&lang=ita).

Granada–Athletic (`understat_22842`) fu sospesa il 10 dicembre 2023 e ripresa l'11; Understat la colloca il 12. Un semplice spostamento del kickoff non ricostruisce in modo affidabile il momento di disponibilità di tutte le statistiche. [Athletic Club, programma della ripresa](https://www.athletic-club.eus/noticias/2023/12/10/el-athletic-club-granada-cf-se-reanudara-el-lunes-a-las-21-00-horas/).

### Risultato sul campo, risultato assegnato e orientamento

Union–Bochum (`understat_27866`) ha 1–1 sul campo in Understat e 0–2 assegnato dal giudice sportivo nel CSV. La decisione del 9 gennaio 2025 non può essere anticipata al 14 dicembre 2024. I gol sul campo, il risultato amministrativo e il settlement del bookmaker sono concetti diversi; l'audit non ne inventa l'equivalenza. [Decisione DFB](https://www.dfb.de/news/dfb-sportgericht-wertet-bundesligaspiel-in-berlin-fuer-bochum).

`understat_31948` è PSG–Rennes nell'archivio, mentre il resoconto ufficiale indica Rennes–PSG al Roazhon Park, 2–2. Un risultato simmetrico non rende irrilevante l'inversione: cambia l'associazione casa/trasferta di xG e statistiche. [Resoconto PSG](https://www.psg.fr/matchs/football-masculin/20262027/paris-vs-rennes-2026-08-23).

### Nice–Rennes: non attribuire verità alla revisione sbagliata

La snapshot del 30 ottobre usa 18:00 UTC e il forecast 17:35:04 UTC. L'archivio aggiornato riporta invece 16:15 senza una prova affidabile del suo significato temporale. I comunicati ufficiali confermano **19:00 locali, cioè 18:00 UTC**: questo caso non dimostra una previsione post-kickoff. Conferma invece che anche una revisione della fonte primaria può essere sbagliata. Il conflitto viene isolato nel percorso C, senza riscrivere lo storico o liquidare una puntata con un orario arbitrario. [Programma OGC Nice](https://www.ogcnice.com/index.php/fr/article/131046/nice-rennes-avance-a-vendredi-19h.html), [resoconto Rennes](https://www.staderennais.com/actualites/ligue-1-mcdonalds/soiree-sans-a-nice-5-2).

## 4. Correzione C e contratto di qualità

Il [manifesto versionato](../../backend/src/research/challenger-data-quarantine.json) isola **22 ID**: 19 conflitti di data tra fonti, l'inversione Rennes/PSG, il risultato amministrativo Union/Bochum e il conflitto di orario Nice/Rennes. Le date alternative CSV rimangono diagnostiche: non sono convertite automaticamente in timestamp corretti.

Il builder C esclude questi record sia dai target sia dalla storia usata per ricostruire probabilità, Elo, intensità, xG recenti e carico del calendario. Non si limita a rimuovere sei righe dal report o a ricalcolare le sole feature aggiuntive.

- Storia grezza: 8.834 → 8.812, **22 esclusioni**.
- Target conclusi prima del cutoff: 7.486 → 7.465, **21 esclusioni**; Nice/Rennes non aveva risultato nel congelato.
- Dataset finale: 6.587 → **6.573**; alcuni record isolati erano già esclusi dai 745 target protetti.
- Target protetti esclusi: **745**, senza riuso per scegliere o certificare il candidato.
- Test di sviluppo: 1.975 → **1.969**.

`dataQualityPolicyHash` identifica esattamente il manifesto. `dataQualityBaselineClean=true` significa **esclusione dei 22 casi noti prima del fit**, non certificazione di tutti i timestamp o di ogni dato rimasto. Una baseline legacy non viene rinominata come pulita: deve essere ricostruita. Trainer, inferenza, registrazione, raccolta e adozione controllano il contratto; una calibrazione che reintroduce uno degli ID bloccati viene rifiutata.

Solo i nuovi artefatti C qualificati ricostruiscono la propria baseline filtrata. A operativo e C906 legacy mantengono il percorso precedente. Nel confronto prospettico il riferimento C906 conserva l'input originale e il candidato riceve separatamente lo storico filtrato.

La precedente candidata `C-63f359b9e5cd3d89` resta nello storico, ma non soddisfa la nuova policy e viene esclusa dalla raccolta e dall'adozione. Il workflow settimanale genera nuove candidature qualificate; nessuna viene promossa dai risultati di sviluppo.

## 5. Ricalcolo indipendente delle metriche

L'[auditor Python](../../backend/scripts/audit-challenger-metrics.py) usa solo la libreria standard e le singole probabilità esportate. Non importa le formule TypeScript del benchmark, non rinormalizza probabilità malformate e verifica unicità, classi, coorte comune e ogni bin di calibrazione.

- Ordine classi: casa, pareggio, trasferta; a parità di probabilità vince la prima classe.
- Log loss: media di `-ln(max(1e-15, p_esito))`.
- Brier: media della somma dei tre errori quadratici, senza divisione per tre.
- ECE: top-label, dieci intervalli di uguale ampiezza, errore assoluto ponderato per la numerosità del bin.
- Accuracy: frazione di esiti correttamente classificati, comprese le partite NO_BET.

Sul vecchio report, LL/Brier/ECE e i dieci bin coincidono entro `1e-12`, con scarto massimo circa `1,78e-15`. Questo conferma i conti, **non sana i cinque target post-evento o la storia contaminata**.

### Vecchio corpus: ricalcolo dei 1.975 target

<!-- OLD_METRICS_START -->
| Variante | n | Log loss | Brier | ECE | Accuracy |
|---|---:|---:|---:|---:|---:|
| `no_ml` | 1975 | 0,983602 | 0,584662 | 0,016097 | 53,063% |
| `development_current_replica` | 1975 | 0,983539 | 0,585233 | 0,018972 | 52,405% |
| `intensity_legacy` | 1975 | 0,984179 | 0,585089 | 0,018275 | 52,709% |
| `intensity_recent_xg` | 1975 | 0,983217 | 0,584507 | 0,019587 | 52,658% |
| `intensity_schedule` | 1975 | 0,984457 | 0,585252 | 0,019066 | 52,861% |
| `intensity_full` | 1975 | 0,983914 | 0,585024 | 0,017757 | 52,658% |
<!-- OLD_METRICS_END -->

### Corpus ricostruito: 1.969 target e stessi confini temporali

Le sei varianti conservano iperparametri, seed e finestre originali. Ogni fold separa training, selezione, calibrazione e test; `--split-plan` impedisce di ricalcolare i quantili dopo le esclusioni.

| Fold | Training | Selezione | Calibrazione | Test |
|---|---:|---:|---:|---:|
| 0 | 3.613 | 653 | 338 | 617 |
| 1 | 4.266 | 664 | 291 | 740 |
| 2 | 4.930 | 676 | 355 | 612 |

<!-- NEW_METRICS_START -->
| Variante | n | Log loss | Brier | ECE | Accuracy |
|---|---:|---:|---:|---:|---:|
| `no_ml` | 1969 | 0,984031 | 0,584895 | 0,015408 | 52,920% |
| `development_current_replica` | 1969 | 0,981242 | 0,583742 | 0,017163 | 52,717% |
| `intensity_legacy` | 1969 | 0,984380 | 0,585221 | 0,017715 | 52,768% |
| `intensity_recent_xg` | 1969 | 0,984056 | 0,585064 | 0,019362 | 52,666% |
| `intensity_schedule` | 1969 | 0,984625 | 0,585391 | 0,018300 | 52,768% |
| `intensity_full` | 1969 | 0,984312 | 0,585212 | 0,017044 | 52,920% |
<!-- NEW_METRICS_END -->

L'audit indipendente conferma i nuovi conti entro `1e-12`, scarto massimo circa `2,55e-15`. Tutti gli 11.834 vettori esportati, inclusi i due confronti ricostruiti C906, hanno stadi raw/calibrated/decision validi; `decision` coincide esattamente con le probabilità finali. Le matrici complete non sono nel bundle compatto: il solo bundle non prova come siano stati addestrati gli alberi.

### Prima/dopo sulle identiche 1.969 partite

Il [confronto appaiato](evidence/c-data-audit-2026-10-31/common-cohort-before-after.json) ricalcola anche il vecchio report sulle sole 1.969 partite rimaste. Verifica stessi ID, kickoff, forecast, lega ed etichette: non sottrae metriche ottenute su popolazioni diverse.

<!-- COMMON_METRICS_START -->
| Variante | LL precedente sui 1.969 | LL ricostruita | Δ LL | Δ Brier |
|---|---:|---:|---:|---:|
| `no_ml` | 0,983742 | 0,984031 | 0,000289 | 0,000146 |
| `development_current_replica` | 0,983610 | 0,981242 | -0,002368 | -0,001538 |
| `intensity_legacy` | 0,984324 | 0,984380 | 0,000056 | 0,000038 |
| `intensity_recent_xg` | 0,983392 | 0,984056 | 0,000665 | 0,000441 |
| `intensity_schedule` | 0,984616 | 0,984625 | 0,000009 | 0,000037 |
| `intensity_full` | 0,984073 | 0,984312 | 0,000239 | 0,000085 |
<!-- COMMON_METRICS_END -->

Le differenze comprendono la ricostruzione delle feature e il riaddestramento sulla storia filtrata. Non dimostrano un miglioramento indipendente del modello: il corpus è già stato consultato e la correzione è stata decisa dopo l'audit.

Nel corpus nuovo, intensità+xG recenti ha log loss superiore alla replica. L'IC settimanale al 95% della differenza xG − replica è circa `[-0,003040; 0,008276]`; quello del Brier `[-0,002204; 0,004551]`, 43 blocchi e 500 ricampionamenti. Entrambi comprendono zero. Il piccolo vantaggio descrittivo precedente degli xG aggiuntivi non è confermato dopo la pulizia.

## 6. Split, calibrazione e limiti dell'indipendenza

L'auditor temporale ricostruisce separatamente 105.168 feature C, conteggi della storia, watermark, cutoff e 36 artefatti raw/coerenti. Nel nuovo corpus non trova incongruenze rispetto all'asse temporale dichiarato. Verifica anche il file hash e i confini del piano originale; i 1.969 test dei tre fold sono disgiunti.

Il riuso del test di un fold nel training o nella calibrazione di un fold successivo è cronologico e compatibile con il walk-forward. **Non rende l'unione dei fold un nuovo holdout globale mai consultato.** I calibratori sono costruiti soltanto sui rispettivi intervalli di calibrazione; gli ID protetti e quelli isolati non entrano come target in training, scelta, calibrazione o test C. I 22 isolati non entrano neppure nella storia C. I 745 protetti restano esclusi dalle nuove feature aggiuntive; la baseline research congelata può usare un loro risultato come passato già disponibile per una previsione successiva, secondo il protocollo precedente. Non è una nuova ottimizzazione sui loro target.

Resta un limite decisivo: tutti i 7.486 risultati del congelato erano privi di timestamp osservato di disponibilità. Il proxy kickoff + due ore non è un limite superiore garantito alla latenza del provider e non dimostra la disponibilità storica di xG e statistiche. L'audit computazionale PASS è dichiaratamente limitato a questo asse convenzionale. Le acquisizioni odierne e le date dichiarate negli articoli non sono un archivio immutabile di ogni versione storica.

## 7. C906 reale, repliche e registri

L'artefatto reale è `C-906371b0b3a1e2c8`, hash `3f18e05ee228d1c6fdbe92865b3b19635cdf68f3ecbd50ff53d83914b52993b3`. La configurazione coincide con il benchmark effettivo, hash `889ec90673beee4fc6fbe485db6d5263f9c7c2e3c3eb17122e04c2a83374f2dd`.

La [rilettura SELECT-only](evidence/c-data-audit-2026-10-31/current-c906-confirmation.json) del 31 ottobre alle 11:11 Europe/Rome conferma hash e configurazione ancora identici, con zero eventi di adozione.

C906 usa profondità 5, 120 iterazioni, peso 0,75, temperatura 0,8 e calibrazione di 335 partite. La `development_current_replica` usa profondità 3, nuovi split, nuovi input e nuovi calibratori: è una replica procedurale parziale, **non C906 identico riaddestrato**.

Nel corpus congelato il confronto C906 realmente disponibile dopo `2026-10-29T10:40:00.219Z` ha **zero casi ammissibili**, anche dopo la correzione. Le dieci osservazioni `C906_reconstructed` restano ricostruzioni di sviluppo successive alla sua validazione; non sono nuove previsioni storiche realmente effettuate. Non si può attribuire a C906 operativo il risultato dei 1.969 o dei 1.975 casi delle repliche.

Il preparatore ora richiede hash canonico dell'artefatto uguale al registro, identità della versione e del benchmark, configurazione coerente e date di disponibilità valide. Alberi alterati o timestamp mancanti vengono rifiutati prima di creare gli output.

Il vecchio lifecycle research può ancora emettere un'approvazione diagnostica offline: **non autorizza il deployment operativo C**. Quest'ultimo usa il registro separato e il test futuro congelato; non considera sufficiente quel vecchio champion research.

## 8. Evidenze prospettiche, A e contabilità

Il percorso dei residui C ora rifiuta una prima etichetta con kickoff incoerente o congelamento successivo al kickoff registrato. Appende una quarantena anche per osservazioni pending, preserva forecast e risultati originali ed esclude le evidenze invalidate dalla calibrazione. Non riscrive puntate o ledger. Nice/Rennes è trattata come conflitto tra fonti, non liquidata assumendo corretto il nuovo 16:15.

Il nuovo registro di adozione rifiuta già divergenze tra kickoff congelato e risultato. Una divergenza nei primi 500 casi può ancora lasciare la candidatura in attesa: non viene sostituito il campione per cercare GO. Una procedura documentata di risoluzione delle discrepanze future resta un limite aperto.

Sono invariati byte per byte [**68 file protetti**](evidence/c-data-audit-2026-10-31/operational-a-immutability.json): tutti i sorgenti backend esterni a research e le fixture/test A. Passano inoltre le sette regressioni A contro `a474e36c`, comprendenti 36 sorgenti e sei casi completi di `PredictionService`. I nuovi test runtime confrontano esplicitamente input, consiglio e pacchetto A quando C usa dati filtrati o si astiene. Le fixture non sono una prova esaustiva su ogni input possibile; il confronto dei sorgenti rafforza l'invarianza delle matematiche.

Nessuna query dell'audit ha scritto nel database condiviso. Non sono state registrate candidature, adozioni, puntate o movimenti. Stake C 1%, esposizione 5% e una puntata per partita restano invariati. La pubblicazione GitHub non attesta un nuovo deploy web.

## 9. Riproducibilità e controlli

I [bundle prima/dopo](evidence/c-data-audit-2026-10-31/README.md) e il [riepilogo dell'audit](c-data-benchmark-audit-2026-10-31.json) sono versionati. Le singole previsioni compresse consentono il ricalcolo indipendente senza accesso al database o ai provider. Sono inclusi anche archivio sportivo congelato, riferimento squadre, C906 e piano temporale; nessun segreto.

```powershell
python backend/scripts/audit-challenger-metrics.py --bundle docs/performance/evidence/c-data-audit-2026-10-31/before --out backend/artifacts/research/replay-audit-before --gzip
python backend/scripts/audit-challenger-metrics.py --bundle docs/performance/evidence/c-data-audit-2026-10-31/after --expected-records 6573 --expected-cohort 1969 --out backend/artifacts/research/replay-audit-after --gzip
python backend/scripts/compare-challenger-audit-bundles.py --before docs/performance/evidence/c-data-audit-2026-10-31/before --after docs/performance/evidence/c-data-audit-2026-10-31/after --out backend/artifacts/research/replay-audit-common.json
```

Gli output devono essere nuovi. Il README delle evidenze descrive decompressione, ricostruzione a cinque worker, training dei sei bracci, finalizzazione e nuovo confronto. Metadata temporali e GUID degli artefatti cambiano a un nuovo fit: il criterio riproducibile sono coorti, probabilità e metriche, non l'identità binaria di un artefatto creato in un altro istante.

<!-- CHECKS_START -->
Build, typecheck e lint backend riusciti; 91 test Node mirati e 73 test Python passati. Regresso A: sette controlli passati, 68 file protetti identici. Audit aritmetico prima/dopo e replay gzip passati, audit temporale del corpus ricostruito passato entro il suo perimetro dichiarato. Compose isolato con database sintetico: backend/frontend/proxy e accesso verificati; container di prova rimossi.

La suite completa locale Windows ha incontrato lock SQLite nelle fixture. La regressione iniziale del conteggio `checked` introdotta dal nuovo pending C è stata corretta e ricontrollata. Un tentativo Linux con workspace in sola lettura non è presentato come gate riuscito: otto fixture cercavano di crearvi database. La CI completa su checkout pulito viene verificata sul commit pubblicato.
<!-- CHECKS_END -->

## 10. Giudizio finale sull'affidabilità

- **Verificato:** correttezza aritmetica delle metriche, identità delle coorti, fedeltà di risultati/xG alla fonte primaria attuale, conflitti ufficiali elencati, esclusione dei casi noti e ricostruzione C, separazione computazionale degli split, A invariato nei controlli eseguiti.
- **Stimato:** disponibilità storica a kickoff + due ore e orario Nightly nominale; non sono osservazioni storiche reali.
- **Non certificato:** prima disponibilità e versioni storiche di ogni feature, calendario indipendente di tutti gli incontri, superiorità su C906 operativo e redditività bookmaker.

Il vecchio benchmark non va usato come prova pre-match valida. Il nuovo benchmark è più controllato e riproducibile come **sviluppo retrospettivo**, ma non è una certificazione indipendente. ROI e drawdown restano non misurabili con i prezzi contemporanei ammissibili disponibili. C906 rimane operativo; ogni futura adozione richiede nuove prove congelate e indipendenti.
