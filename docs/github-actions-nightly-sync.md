# Nightly GitHub Actions

Questa è la procedura corrente di importazione, manutenzione e registrazione
delle giocate **virtuali** A/C. La configurazione eseguibile è in
[nightly-sync.yml](../.github/workflows/nightly-sync.yml), nello
[script del ciclo](../scripts/ci/nightly-sync.sh) e nel
[processo A/C](../backend/scripts/research-nightly.js). Per portafogli, azioni
manuali e quote consultare la [guida operativa](operations/README.md).
Le impostazioni remote effettive e l'esito dell'ultima esecuzione vanno
verificati su GitHub e nel database: questo documento non certifica un run live.

## Orario e protezione dai duplicati

Il workflow dichiara tre trigger con timezone `Europe/Rome`: principale alle
**03:07**, recuperi alle **04:17** e **05:27**. GitHub può avviarli in ritardo;
non è uno scheduler al minuto e non realizza un'esecuzione T−15 dal kickoff.
La concorrenza `nightly-sync`, con `cancel-in-progress: false`, serializza i run.

Prima di npm, build e accesso al DB, il
[guard](../backend/scripts/nightly-schedule-guard.js) legge le API GitHub.
Un completamento A/C valido richiede nello stesso job i passi riusciti
`Run nightly sync` e `Confirm enabled A/C completion`. Un semplice badge verde,
una cancellazione o un run saltato non provano quel completamento.
Un successo valido della giornata italiana evita un secondo ciclo normale;
metadati incerti o identità incoerente bloccano l'ammissione.
Lease e vincoli DB proteggono ulteriormente dalle doppie registrazioni.
Un recupero dopo errore può ripetere import e richieste: non garantisce zero
consumi aggiuntivi.
Un avvio manuale prima delle **03:07 Europe/Rome** viene normalmente saltato
dal guard, anche con gli input di recupero: un run verde con il ciclo saltato
non prova il ripristino della Nightly.

Per un ciclo anticipato esplicitamente richiesto usare l'input manuale
`allow_early_manual_run=true`, lasciando spenti gli altri recuperi. Il guard
ammette l'eccezione soltanto per `workflow_dispatch`, conserva i controlli
su identità, giornata, concorrenza e successi precedenti, ed espone
`early_manual=true` quando ammette il tentativo prima delle 03:07. In quel
caso il workflow imposta una finestra di **24 ore**: il default fino alle
03:07 della stessa notte escluderebbe le partite del pomeriggio.

Il ciclo anticipato è aggiuntivo e non consuma il ciclo ordinario delle
03:07. Un altro tentativo anticipato dopo un successo viene saltato, così
come il rerun dello stesso ID già completato. Il ciclo ordinario conserva
le decisioni completate e può riprendere job `ERROR` senza input definitivo
o nuove fixture. Import e manutenzione possono ripetersi e consumare risorse;
l'assenza di giocate duplicate va verificata nel registro, non dedotta dal
solo successo del workflow.

La finestra A/C parte dall'esecuzione effettiva e termina alla successiva
Nightly prevista. `RESEARCH_NIGHTLY_WINDOW_HOURS`, se impostata, ammette
1–48 ore. Retry, kickoff modificati e partite iniziate sono ricontrollati;
non si ricostruiscono giocate retroattive.

## Flusso effettivo

`NIGHTLY_SOURCE_MODE=primary` conserva l'import Understat. Con l'opt-in
`verified-alternatives`, il ciclo chiama
[nightly-alternative-sources.js](../backend/scripts/nightly-alternative-sources.js):
football-data.org aggiorna calendario/risultati, i CSV riempiono soltanto campi
ammessi e mancanti, gli xG Understat restano intatti. Il ricalcolo delle medie
precede le previsioni. I blocchi sono applicati alla singola fixture e al
mercato, senza richiedere il successo globale di Understat. Non si attiva il
pilot scientifico; collector indipendente e `data:stage` conservano il proprio
scopo separato.

### Preparare il passaggio alle fonti alternative

Il percorso alternativo è collegato al workflow, ma resta opt-in e richiede
configurazione e autorizzazione operativa. Il job espone il secret FDO senza
stamparlo. Preparare `NIGHTLY_SOURCE_TARGET_SHA256` (SHA-256 dell'esatto URL
Turso), `NIGHTLY_SOURCE_SEASON` e `NIGHTLY_SOURCE_MAPPING_JSON` nel formato
`reviewed-source-mapping-v1`, con reference/reviewedAt/teams revisionati.
Il JSON viene scritto in un file locale del runner, senza sovrascrivere un
mapping discordante. Il manifest dell'import è sigillato e legato al target;
prima dell'inferenza vengono ricontrollati fonte corrente, identità e stato
effettivo A/C. Un file manifest modificato non autorizza scritture o previsioni.

Nel percorso alternativo la CLI impone anche `allowChampionRollback:false` e
`collectChallengerForecasts:false` a tutti i runtime, diagnostici e recommendation.
Disattivare soltanto `reviewCandidates` non basta: i rami legacy potrebbero
altrimenti raccogliere forecast challenger o cambiare il champion dopo errori C.
Il fallimento C resta registrato e produce astensione; la nuova modalità non
promuove, ripristina o avvia raccolte scientifiche. I default degli altri
percorsi sono conservati. Le osservazioni diagnostiche interne già previste
e la liquidazione delle evidenze esistenti restano distinte dal pilot A.

La preparazione di una prima esecuzione reale richiede, nell'ordine:

1. Revisionare e pubblicare il codice esatto con CI superata, dopo autorizzazione.
   Conservare SHA, hash C adottato e fingerprint A; controllare separatamente
   gli eventuali auto-deploy esterni prima del push. Pubblicare non abilita i
   due flag A/C e non autorizza scritture o ricalibrazione.
2. Risolvere o escludere esplicitamente le identità contestate. Per PSG–Lyon
   la LFP e il club confermano il rinvio al 26 ottobre alle 20:30 locali;
   la correzione richiede un piano con vecchia riga esatta e compare-and-set.
   Non estendere quella correzione a Toulouse/Troyes–Le Havre o al ritorno
   Rennes–PSG, ancora discordanti. Provare import e ripetizione su una copia.
3. Autorizzare separatamente il bootstrap additivo delle sei tabelle cache
   condivise, verificarne il target e conservare un backup ripristinabile.
   Il comando `nightly-alternative-sources.js --initialize-source-cache
   --authorize-schema-writes --target-sha256 HASH` è distinto dall'import:
   nessuna Nightly crea quelle tabelle automaticamente. La cache CSV conta
   anche tentativi falliti/interrotti, massimo due raccolte in sette giorni;
   fra successi attende 84 ore. Il bootstrap parte con sette giorni di blocco
   delle nuove raccolte per non azzerare consumi legacy sconosciuti. Usare i
   dati già acquisiti con provenienza originale; non falsificare l'acquisizione.
   È predisposto `seed-nightly-csv-cache.js`: legge cinque file e una ricevuta
   con stagione, timestamp originale e hash dei file. Il piano è SELECT-only;
   `--execute --authorize-cache-writes --expected-plan-sha256 HASH` richiede il
   piano esatto e inserisce atomicamente un tentativo storico e gli snapshot,
   senza rete o DDL. Conserva il cooldown e non azzera tentativi precedenti.
4. Con nuove giocate ancora spente, preparare il piano d'import sul target,
   revisionarne conflitti e righe e autorizzare l'aggiornamento dati. Da `backend`,
   con ambiente privato configurato e mapping revisionato:

   ```powershell
   node scripts/nightly-alternative-sources.js --plan --target-sha256 $env:NIGHTLY_SOURCE_TARGET_SHA256 --season $env:NIGHTLY_SOURCE_SEASON --mapping $env:NIGHTLY_SOURCE_MAPPING_FILE
   ```

   Il piano usa la cache presente, senza chiamate ai provider. Se il target
   non ha ancora snapshot, autorizzare prima una raccolta nella cache: il
   piano vuoto non convalida payload futuri. Dopo revisione, eseguire lo stesso
   import con `--execute` al posto di `--plan`, conservare privatamente l'output
   come `NIGHTLY_SOURCE_MANIFEST_FILE`, poi eseguire
   `node scripts/nightly-source-context.js --recompute-imported-teams`.
   `--collect-fdo` e `--collect-csv` sono opt-in aggiuntivi e possono cambiare
   il piano acquisendo nuovi dati: richiedono l'autorizzazione alla raccolta e
   all'applicazione del sottoinsieme verificato, non un'approvazione implicita
   del vecchio piano. Il runner usa questi due flag nel ciclo autorizzato.
5. **Dopo l'import e il ricalcolo**, verificare sul target parametri A, esatta compatibilità della calibrazione,
   artefatto/deployment C, campioni e quote reali recenti. I profili con checksum
   valido ma fingerprint diverso sono cache miss. Se manca un profilo compatibile,
   astenersi per A: la Nightly usa `allowCalibrationRebuild:false` e non esegue
   warmup impliciti. La preparazione separata richiede autorizzazione; non rinominare
   la chiave cache per riutilizzare il vecchio profilo. Verificare budget quote
   e reset confermato senza azzerare consumi o inventare nuovi portafogli.
   `ODDS_API_ACCOUNT_SCOPE` deve identificare lo stesso account della chiave:
   il default del workflow è `primary`, non il valore configurato su un PC.
   Non copiare un saldo da uno scope diverso e non dedurre l'identità del
   secret GitHub dal suo solo nome.
6. Solo dopo una prova end-to-end ammissibile, un backup verificato e il consenso
   alle scritture, configurare il secret nel job, autorizzare il piano dati e
   attivare `RESEARCH_NIGHTLY_ENABLED` insieme a
   `RESEARCH_NIGHTLY_RECOMMENDATION_ENABLED` per una prima esecuzione controllata.
   Il primo flag da solo produce diagnostica; con entrambi spenti restano
   manutenzione e liquidazioni già previste, senza nuove giocate. Verificare
   SHA effettivo, esiti dei singoli gate, motivi di astensione, input/quote,
   contabilità, deduplicazione e completamento effettivo A/C.

Cambiare `NIGHTLY_SOURCE_MODE` abilita la manutenzione alternativa anche con
i flag delle nuove giocate spenti: autorizzare quindi prima le scritture di
import. Le chiavi e il mapping non vanno pubblicati nei log; la presenza del
nome di un secret non prova il suo contenuto. Per una run manuale fuori
dall'orario normale, `RESEARCH_NIGHTLY_WINDOW_HOURS=24` è un'opzione esplicita
già supportata: senza di essa la finestra termina alla prossima 03:07 italiana
e può correttamente contenere zero fixture. Non anticipare il clock per
simulare una run futura. Il runner rilegge fonti e profili prima dell'uso;
uno snapshot scaduto richiede una nuova acquisizione ammissibile.

Per l'arresto, disabilitare prima le nuove recommendation e poi il processo
A/C se necessario. Conservare ledger, piani, snapshot e cache; non annullare
puntate cancellando righe. Un rollback del codice non ripristina i dati già
importati: per quelli serve un piano inverso basato sulle precondizioni oppure
un restore separatamente autorizzato. La validazione prospettica A rimane
indipendente e spenta: non è un prerequisito implicito che questa procedura
attiva, né un risultato dimostrato dal funzionamento ordinario.

| Operazione persistente | Controllo prima/dopo | Arresto o rollback |
|---|---|---|
| Pubblicazione codice | CI, SHA, diff, hash C, auto-deploy esterni | Tornare a codice compatibile; nessun ripristino dati implicito |
| Bootstrap cache/riuso CSV | Backup, target, sei tabelle; ricevute e hash CSV originali | Disabilitare raccolta; conservare cache e tentativi, senza DROP o reset dei limiti |
| Import e medie | Piano, conflitti, precondizioni di riga, manifest, ripetizione idempotente | Fermare import concorrenti; piano inverso autorizzato anche per gli aggregati, oppure restore verificato |
| Profili A | Backup completo cache con hash; build/config/input esatti; HIT su nuovo servizio | Tenere A spento su MISS/errore; restore cache autorizzato in transazione, senza cambiare parametri o C |
| Nuove puntate virtuali | Scope, budget API, quote reali, saldo disponibile, confidenza, origini, ledger, deduplicazione | Spegnere recommendation; preservare giocate e liquidazioni, senza cancellare o riprodurre il ledger |

Un nuovo risultato importato o un cambio di build/configurazione può cambiare
la chiave A: ripetere il preflight sul runtime effettivo prima dell'uso.
La preparazione una tantum non garantisce HIT perpetui. La Nightly si astiene
per A in assenza di profili compatibili; non rigenera curve senza autorizzazione.

### Gate di rilascio e autorizzazioni separate

Ogni fase si arresta prima della successiva finché i suoi controlli non sono
superati. Le autorizzazioni seguenti non sono incluse nella sola analisi del
repository. Le variabili di sicurezza e i consensi non vanno impostati soltanto
per rendere verde il controllo.

| Fase e autorizzazione richiesta | Prerequisiti e azione eseguibile | Successo verificabile | Arresto e rollback |
|---|---|---|---|
| 1. Commit/push su main, senza deploy | Diff revisionato, file locali conservati, test della build finale; ricontrollare auto-deploy e hook esterni. Pubblicare piccoli commit coerenti e registrare SHA/lock/hash C | Remote main uguale allo SHA approvato, CI verde sul medesimo SHA; nessun effetto operativo esterno | Stop se auto-deploy/hook non verificabili, CI fallita o diff inatteso. Correzione/revert di codice compatibile, senza force-push e senza cancellare lavoro locale |
| 2. Backup e preparazione DB | Target canonico verificato; preflight/backup/restore locale secondo guida backup, quota/spazio verificati. Consenso distinto al bootstrap additivo delle sei tabelle cache, al riuso CSV con ricevute e alla migrazione 029 finanziata | Backup complete=true, integrity ok, FK zero; tabelle e trigger 029 verificati in sandbox, piano di transizione e backup limitato verificati, target/schema/trigger ispezionati, seed idempotente e limiti CSV conservati | Nessun import con backup parziale o schema inatteso. Fermare qui; conservare tabelle e contatori, niente DROP/reset/restore remoto automatico |
| 3. Raccolta/import operativo e medie | Build approvata, mapping revisionato, scrittori concorrenti coordinati, backup; piano cache-only seguito dall'esecuzione autorizzata descritta sopra | Manifest sigillato, sottoinsieme verificato, conflitti esclusi, xG/identità/valori osservati conservati; seconda applicazione zero modifiche; medie delle sole squadre aggiornate | Stop su target/piano cambiato, conflitto inatteso, xG sovrascritti o ricalcolo fallito. Piano inverso di righe e aggregati o restore con riconciliazione separatamente autorizzato |
| 4. Sola cache calibrazione A | Import concluso, stessa build/config/input del runtime, niente import concorrenti; comando calibration-operational sotto con target/flag/backup nuovo | Nuovo servizio: cinque HIT, chiavi/input/hash attesi, nessuna scrittura model_params o artefatto C | Stop su MISS/INVALID/errore o input cambiati. Tenere A fermo; cache parziale non autorizza avvio, ripristino cache solo da backup verificato |
| 5. Verifica quote e configurazione account | Consenso al solo workflow quota-only/read-only, eventuale correzione separatamente autorizzata di secret/scope dopo attestazione del titolare; niente chiamate quote a pagamento | Chiave effettiva del runner associata all'account e allo scope storico corretti, probe costo zero, residuo/reset/passività verificati; limiti del job espliciti | Stop se secret/account/scope non attestabili o saldo solo storico. Non creare uno scope nuovo per recuperare budget, non azzerare consumi; ripristinare configurazione precedente se incoerente |
| 6. Una Nightly manuale controllata | Tutti i gate precedenti, feed fresco, preflight A di nuovo HIT, C verificato, autorizzazione alle scritture accessorie e alle richieste quote entro tetto crediti concordato; cron non abilitato implicitamente | SHA corretto, marker A/C e job completi, quote reali/astensioni motivate, budget API rispettato, stake in euro LOW 1% / MEDIUM 3% / HIGH 5% sulla base disponibile iniziale del gruppo, saldo rispettato, zero duplicati, ledger coerente e storico preservato | Stop su errori/scope/costi/distribuzioni inattesi; spegnere recommendation mantenendo liquidazioni. Conservare evidenze e ledger; niente cancellazione/replay delle giocate. La successiva cadenza automatica richiede consenso distinto |

### Pubblicazione e passaggio ai portafogli in euro

Il push del codice e l'avvio operativo richiedono autorizzazioni distinte.
Prima della finestra verificare tutte le run, incluse quelle vecchie ancora
in coda, e gli automatismi GitHub Apps, Hostless e Northflank con il proprietario.
La sola assenza di webhook del repository non esclude gli eventi delle Apps.
Northflank richiede il controllo di CI/CD dei servizi, job su cambio immagine,
workflow/release flow, GitOps e preview: nessun test delivery o avvio implicito.

Conservare lo stato precedente dei workflow; Nightly e watchdog già sospesi
restano tali. Per il solo intervallo di pubblicazione valutare la sospensione
autorizzata del training settimanale, che può scrivere nel registry se abilitato.
Una run in coda non è cancellata disabilitando il workflow: verificarla a parte.
La pausa rinvia import, liquidazioni e nuove quote delle run sospese, non
cancella dati né ferma l'app o altri processi esterni.

Commit logici e push devono essere fast-forward sullo SHA remoto ricontrollato,
con diff revisionato e scansione segreti anche sui file nuovi. La CI va verificata
sullo SHA effettivamente pubblicato, insieme all'assenza di build/deploy esterni.
Non includere DB, copie di backup, report privati, cache, node_modules o dist.
Non modificare i flag per ottenere una CI verde.

Il nuovo schema 029 non viene applicato dal push. Il normale bootstrap del
backend esegue le migrazioni pendenti: **non distribuire/avviare la nuova build
sul DB operativo prima dell'autorizzazione allo schema e del backup verificato**.
Tenere recommendation spente durante la preparazione. Applicare esplicitamente
la sola 029 autorizzata, non usare il bootstrap come comando di migrazione
generale. I portafogli `shadow_A` e `shadow_C`, i saldi e i movimenti precedenti
restano invariati. Le registrazioni paper selezionate dal piano sono annullate
logicamente con evidenze immutabili: escluse da conteggi operativi, ROI e
liquidazioni, senza DELETE o conversione da unità in euro. Le nuove decisioni
finanziate richiedono backend/frontend aggiornati e controllati prima di
riabilitare la Nightly. Dettagli nella guida Hostless.
I CLI operativi con `skipSchemaBootstrap:true` richiedono invece schema già pronto.
I profili A dipendono dall'hash della build: quelli di una build precedente non
sono una prova HIT per questa release e non vanno forzati o copiati con chiavi nuove.

Il [comando di transizione](../backend/scripts/transition-funded-wallet.js)
non carica l'applicazione, non acquisisce quote e non registra nuove puntate.
Da `backend`, con ambiente privato configurato, fissare esplicitamente giorno
italiano del kickoff e conteggio atteso delle sole registrazioni paper future,
non liquidate e non già annullate che si intende rimuovere dall'operatività.
Il target è lo SHA-256 dell'URL canonico senza spazi ai bordi, senza stampare
l'URL. Per il piano remoto serve `TURSO_WATCHDOG_READONLY_TOKEN`:

```powershell
node scripts/transition-funded-wallet.js --plan --target-sha256 $env:NIGHTLY_SOURCE_TARGET_SHA256 --day $env:FUNDED_TRANSITION_DAY --expected-count $env:FUNDED_TRANSITION_EXPECTED_COUNT --out C:\percorso-privato\nuovo-piano-transizione.json
```

Il piano è SELECT-only e rifiuta incongruenze, lease attive, risultati presenti,
kickoff trascorsi o conteggio diverso da quello atteso. Riesaminare piano,
saldi e `planSha256` prima dell'esecuzione distinta con `TURSO_AUTH_TOKEN`:

```powershell
node scripts/transition-funded-wallet.js --execute --authorize-wallet-transition --target-sha256 $env:NIGHTLY_SOURCE_TARGET_SHA256 --plan-file C:\percorso-privato\nuovo-piano-transizione.json --expected-plan-sha256 $env:FUNDED_TRANSITION_PLAN_SHA256 --backup-file C:\percorso-privato\nuovo-backup-transizione.json
```

Piano e backup sono file privati nuovi, mai sovrascritti. Il backup è limitato
alle tabelle e allo scope di portafogli/esecuzioni/origini previsti dal comando,
con massimo 50.000 righe e 100 MiB; viene riletto e verificato prima del DDL.
Non sostituisce il backup completo del database. Il comando rilegge stato,
saldi e hash del piano, applica soltanto 029 e registra le cancellazioni logiche.
DDL e cancellazioni sono transazioni distinte: un errore successivo può lasciare
lo schema additivo presente, senza giustificare DROP o replay automatici.
Verificare saldi e ledger invariati e il gruppo esatto di cancellazioni prima
del deploy e della nuova Nightly. Quest'ultima deve usare quote fresche e
nuovi calcoli, non gli stake o i prezzi delle registrazioni paper cancellate.

Rollback del codice mediante commit di revert e CI, senza force-push. Fermare
nuove registrazioni mantenendo le liquidazioni già autorizzate. Dopo l'avvio
finanziato non cancellare le nuove tabelle né riscrivere i movimenti nei wallet;
una versione vecchia non sa liquidarli. Prima di un ritorno a quella versione
preservare un runner di liquidazione compatibile o tenere documentati i pending.
Il ripristino del cron Nightly, watchdog e training è una fase esplicita:
riabilitarli quando i relativi prerequisiti sono verificati, senza attivare il pilot.

Da root, dopo autorizzazione alla fase 5, il solo probe già predisposto è:

```powershell
gh workflow run odds-api-smoke.yml --ref main -f quota_only=true
```

Controllare SHA e log del job quota: la risposta espone soltanto contatori,
non il valore del secret né l'identità del suo titolare. GitHub non consente
di rileggere un secret: attestare privatamente l'account/chiave presso il
provider, oppure autorizzare l'impostazione del secret da una chiave già
attestata del medesimo account. Un residuo coincidente non prova l'identità.
Il budget locale dello store è 500 crediti/mese e riserva 50 per richieste
informative con i default del job; le richieste Nightly essenziali possono
usare la riserva, sempre con il registro condiviso. Questi limiti non sono
un saldo live né autorizzano un numero illimitato di richieste. Concordare
il tetto del primo ciclo, inclusi gli extra-event market abilitati nel job.

La fase 6 usa il workflow completo, non una CLI abbreviata. Prima delle 03:07
Europe/Rome il guard salta normalmente l'avvio manuale; l'opt-in separato
`allow_early_manual_run=true` e i suoi controlli sono descritti
[all'inizio della guida](#orario-e-protezione-dai-duplicati). Da quell'ora la finestra normale
termina alla successiva 03:07, anche nei giorni di 23/25 ore. La finestra
esplicita di 24 ore resta una scelta operativa distinta. Dopo configurazione
autorizzata dei due flag e della modalità alternativa:

```powershell
gh workflow run nightly-sync.yml --ref main
```

I flag sono variabili repository, quindi lasciarli true dopo il manuale
autorizzerebbe anche il prossimo cron: per una sola prova concordare
un intervallo privo di cron concorrenti e rimetterli false al termine.
Non disabilitare l'intero workflow per fermare soltanto le nuove puntate.

Le scritture accessorie richiedono consenso anche con A/C spenti: liquidazioni
legacy/manual/research, risultati delle prediction, eventuali dettagli Understat
per liquidare player props legacy, registro scheduler con retention periodica.
Gli store possono eseguire `CREATE TRIGGER IF NOT EXISTS` per proteggere le
evidenze: `skipSchemaBootstrap` non disattiva questi guard lazy. Con A/C acceso
si aggiungono lease/run/job/input/decisioni, registri e osservazioni diagnostiche,
notifiche e contabilità quote anche per dinieghi/cache hit. Prima di partire
verificare che i trigger necessari esistano; nessuna nuova tabella o migrazione
va autorizzata implicitamente da una semplice prova di salute.

L'audit prediction seleziona ora soltanto i match con entrambi i risultati
presenti e applica il limite ai match con almeno una liquidazione effettiva:
fixture future/mancanti e vecchi mercati senza osservazioni non possono
affamare le successive prediction liquidabili. Include tutte le prediction
pending dei match scelti. Le statistiche assenti restano pending, senza
convertirle in zero. `matches` conta anche i match esaminati ma irrisolti e
può quindi superare il limite delle liquidazioni; questa scansione locale non
contatta provider. Il fix non ripara lo storico né cambia le formule.

Distinguere i gate dei dati dai flag di esecuzione: se `RESEARCH_NIGHTLY_ENABLED` o `RESEARCH_NIGHTLY_RECOMMENDATION_ENABLED` non sono abilitati nell'ambiente effettivo, il relativo processo A/C non parte anche con import completo. La presenza di una schedule non dimostra analisi o puntate. Lo stato attuale dei flag richiede una lettura dell'ambiente; non si ricava dai log di una vecchia run.

Una riga CSV non abbinata non implica necessariamente un alias mancante: l'adapter del supplemento considera solo fixture primarie già concluse. Con identità e data corrette ma risultato primario ancora NULL, il supplemento non promuove la fixture a conclusa. Verificare separatamente CSV, fixture, risultato primario e relativo gate; uno 0–0 osservato è concluso, due NULL non lo sono. Non cambiare fonte del risultato o abbassare la copertura per rendere verde la Nightly.

1. Avvia un backend temporaneo sul runner, sul DB configurato nei secret,
   con `NODE_ENV=ci`, bootstrap e scheduler interni disabilitati. Attende
   `/api/health` e termina il processo al termine del job.
2. In modo `primary` importa Understat Top 5 con cinque stagioni e dettagli.
   In modo `verified-alternatives` usa calendario/risultati FDO verificati e
   conserva gli xG originali. Il supplemento CSV riempie i campi ammessi e
   mancanti attraverso la cache condivisa e il suo limite persistente; senza
   configurazione/cache valida non viene scaricato direttamente. Aggiorna, se abilitati,
   i [riferimenti fra competizioni](competition-transitions/README.md).
3. Sincronizza le giocate legacy, liquida le A/C esistenti tramite
   `POST /api/research/settle` e aggiorna l'audit delle prediction concluse.
   Le liquidazioni precedono il gate per le nuove giocate.
4. La manutenzione non ricalibra. La Nightly consuma solo profili esattamente
   compatibili; un MISS blocca A per le fixture interessate, senza impedire C
   se ha evidenze sufficienti. Il comando operativo di calibrazione è separato.
5. Se `RESEARCH_NIGHTLY_ENABLED=true`, avvia il processo finito A/C. Nel modo
   alternativo stato/orario provengono dal manifest FDO e vengono ricontrollati
   nella cache condivisa; `SCHEDULED` ha un orario provvisorio e non è ammesso.
   Nel modo primario resta il controllo del calendario eventi precedente.
6. Con `RESEARCH_NIGHTLY_RECOMMENDATION_ENABLED=true` registra i consigli dei
   rispettivi motori: A usa `PredictionService`, i mercati squadra supportati
   con tutte le opportunità qualificate; C usa il proprio percorso gol.
   La policy `funded-confidence-v1` registra importi in euro dal saldo esistente:
   **LOW 1%, MEDIUM 3%, HIGH 5%** del disponibile iniziale del gruppo nella
   transazione. Non applica top N, massimi per partita o tetto cumulativo del 5%.
   Il saldo finanzia importi completi in ordine HIGH, MEDIUM, LOW, poi EV
   decrescente e chiave; confidenza mancante o SPECULATIVE non ricevono fondi.
   Più mercati e A/C sulla
   stessa partita sono ammessi; una stessa selezione semantica per famiglia
   non è ripetuta cambiando bookmaker/prezzo/versione. Quote reali, bookmaker,
   freschezza, EV, prudenza, modello, qualità e kickoff sono verificati anche
   nella transazione, insieme al saldo. Migrazione additiva 029 richiesta prima
   dell'avvio, senza ricarica o conversione dello storico. Il calendario non ha limite numerico
   di partite; timeout, scadenze e budget API restano applicati e le astensioni
   tecniche sono esplicite. Con flag recommendation spento resta la diagnostica.
7. Nel solo modo primario, se i gate obbligatori riescono, esegue la learning review; recupera lo stato
   finale e segnala il completamento. Errori della liquidazione legacy,
   e dell'audit prediction sono avvisi distinti dai gate obbligatori.

Il ciclo non chiama la registrazione legacy `/api/automation/place-valid-bets`,
che risponde `410`. Non piazza scommesse presso bookmaker. Giocatori e
formazioni restano sospesi nella configurazione del workflow; una chiave
API-Football presente non li abilita da sola.

## Indisponibilità Understat e controllo del calendario

Un HTTP 200 non dimostra la disponibilità dei dati: Understat può restituire
HTML di manutenzione anche da `/getLeagueData/<lega>/<anno>`. Il parser
rifiuta risposte non oggetto JSON e payload lega senza array `dates` con
`UNDERSTAT_INVALID_RESPONSE`, senza includere il body nell'errore o ritentare
un payload malformato. Un array `dates: []` esplicito resta una stagione vuota
valida: completezza e pending pre-campionato mantengono i gate esistenti.
Non si inventano partite, risultati o xG per superare il controllo.

Una pagina identica su homepage, più leghe e una stagione precedente sostiene
un'indisponibilità comune ai percorsi provati, non prova un cambio di endpoint.
Messaggio di manutenzione e header Last-Modified non dimostrano la causa
infrastrutturale, l'inizio esatto dell'incidente o una data di ripristino.
Le alternative e i relativi limiti sono nella [guida delle fonti](data-sources.md);
il calendario research non è un ripristino già implementato della fonte primaria.

Il [diagnostico pubblico](../.github/workflows/source-connectivity.yml),
senza credenziali o DB, verifica separatamente i cinque endpoint della stagione
corrente UTC, formato JSON e presenza di partite. Calendario vuoto, formato
invalido e errore di rete rimangono distinguibili; il successo richiede tutte
le cinque leghe disponibili. Legge al massimo 4 MiB per risposta e non stampa
i payload. La fonte CSV supplementare non sostituisce Understat.

```powershell
gh workflow run source-connectivity.yml --ref main
```

Controllare la conclusione e i log del run, non il solo avvio. La verifica
legge le fonti ma non aggiorna il calendario del DB: confrontare poi fonte e
partite persistite sul target autorizzato. La copertura del calendario già
importato non certifica quella corrente del provider durante un disservizio.
Non usare una Nightly operativa come semplice probe: comprende import, pruning,
settlement e, se abilitata, registrazione di nuove decisioni virtuali. Se
Understat è in manutenzione il modo primario resta bloccato; il percorso
alternativo autorizzato può continuare sulle fixture ammissibili. Nessun
deploy, modifica DNS o rilassamento dei gate è implicito nella diagnosi.

Regressioni locali: `understat-response-validation`, `understat-network-retry`,
`understat-read-reduction`, `understat-commit-state`, `nightly-five-season-window`
e `source-connectivity-workflow` verificano mapping delle cinque leghe,
calendario vuoto, risposta HTML e gate di completezza con fixture, senza
modificare lo storico o certificare un import operativo riuscito.

## Limiti per la raccolta prospettica A

La Nightly non è un generatore universale di previsioni A. Nel percorso
recommendation `ResearchRecommendationRuntime.prepare` invoca
`PredictionService.predict` solo dopo aver ottenuto almeno una quota app
reale e fresca. Mancanza di quote, matching, cache-only o budget provider
possono quindi impedire l'inferenza A, non soltanto la giocata. Una
decisione già registrata, origini diagnostiche mancanti o entrambe le
famiglie già puntate possono escludere il lavoro prima dell'inferenza.
Il saldo disponibile per finanziare le selezioni viene invece verificato dopo
il calcolo, all'interno della transazione, senza tetto cumulativo del 5%.

La finestra effettiva del job termina alla successiva Nightly, mentre il
protocollo prospettico richiede una prima previsione tra T−24h e T−60min.
Ritardi del job e variazioni del calendario non permettono di equiparare
le due finestre. Visite utente, worker T−15 ritirato e baseline diagnostica
research non sostituiscono un generatore A con copertura verificata.

Il workflow non passa `MODEL_A_PROSPECTIVE_*` al runner e non configura
persistenza dello spool. Il CLI tenta il drain nel `finally` ordinario;
non installa lo shutdown web su SIGTERM e il timeout shell può terminarlo.
Il timer risultati vive solo mentre quel processo è in esecuzione:
abilitare il recorder sul web non lo abilita automaticamente nella Nightly.
Il generatore separato descritto qui sotto risolve questa dipendenza dalle
quote senza modificare il percorso Nightly. Stato e blocchi nel
[passaggio di consegne A](models/MODEL-A-FASE-4-HANDOFF.md).

## Raccolta prospettica A separata, spenta di default

Il workflow [Collect prospective Model A observations](../.github/workflows/model-a-prospective.yml)
esegue un ciclo finito ogni 30 minuti. Non reagisce a push o pull request.
La [regola GitHub](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
richiede il workflow sul branch predefinito per la pianificazione; anche il
dispatch iniziale richiede il file sul branch predefinito. La pubblicazione
del solo branch di preparazione non rende disponibile questa automazione.
La scelta consigliata, dopo verifica del target Turso esistente e dei limiti
effettivi dell'account, è il runner con conferma DB: non richiede un nuovo
volume a pagamento. Richiede prima l'integrazione sicura del workflow in
`main` e la verifica separata dell'auto-deploy Hostless. Se la continuità del
cron non è sufficiente, la CLI offre già un loop su un processo esistente
autorizzato, configurando `MODEL_A_COLLECTION_INTERVAL_SECONDS` almeno a 60
(300 nell'esempio Compose). Non riattiva T−15 e non cambia il processo web.
Il job intero, inclusi installazione e accesso al DB, richiede la variable
repository `MODEL_A_PROSPECTIVE_COLLECTION_ENABLED` uguale a `true`.
Se assente o diversa, il job non parte. L'avvio manuale richiede anche
`authorize_collection=true`, booleano obbligatorio con default `false`.
La [documentazione GitHub sullo schedule](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
segnala possibili ritardi e scarto di job in coda sotto carico. Nei repository
pubblici la pianificazione viene disabilitata dopo 60 giorni senza attività
del repository. Controllare run effettivi e copertura: la cadenza dichiarata
non garantisce continuità o completezza.

Prima dell'attivazione autorizzata configurare e congelare:

| Variable repository | Contenuto richiesto |
| --- | --- |
| `MODEL_A_COLLECTION_PROTOCOL_ID` | Identificativo del protocollo |
| `MODEL_A_COLLECTION_MANIFEST_SHA256` | SHA-256 del manifest canonico, 64 caratteri esadecimali minuscoli |
| `MODEL_A_COLLECTION_SEASONS` | Stagioni separate da virgole, con identificativi corrispondenti al DB |
| `MODEL_A_COLLECTION_FROM`, `MODEL_A_COLLECTION_TO` | Intervallo UTC, inizio incluso e fine esclusa |
| `MODEL_A_PROSPECTIVE_RESULTS_REFRESH_ENABLED` | Refresh HTTP Understat degli esiti solo se `true`; default `false` |
| `MODEL_A_PROSPECTIVE_MONITORING_ENABLED` | Controllo del DB e diagnostica GitHub solo se `true`; default `false` |
| `MODEL_A_COLLECTION_PREDICT_BUDGET_MS` | Budget osservato della chiamata A; default `30000` ms |
| `MODEL_A_COLLECTION_CONFIRMATION_BUDGET_MS` | Budget dall'inizio della chiamata alla conclusione della consegna del recorder; default `45000` ms |
| `MODEL_A_RESEARCH_CALENDAR_ENABLED` | Calendario alternativo del solo collector se `true`; default `false` |
| `MODEL_A_RESEARCH_CALENDAR_MAPPING_JSON` | Mapping revisionato, per lega, degli ID squadra football-data.org agli ID squadra Understat locali |
| `MODEL_A_RESEARCH_CALENDAR_EXPECTED_TEAM_COUNTS` | JSON con numero atteso di squadre per ciascuna delle cinque leghe; obbligatorio con opt-in |
| `MODEL_A_RESEARCH_CALENDAR_MAX_AGE_SECONDS` | Età massima dell'acquisizione, intero fra `60` e `86400`; obbligatoria con opt-in, `3600` nell'esempio ambiente |

Il manifest include le cinque leghe, l'origine `prospective_a` e la finestra
T−24h–T−60min. Con scope già configurato in ambiente, il comando seguente
stampa manifest e hash senza aprire il DB; richiede una build backend coerente:

```powershell
node backend/scripts/model-a-prospective-collect.js --print-scope
```

Il [collector](../backend/scripts/model-a-prospective-collect.js) legge il
calendario importato, chiama A senza richiedere quote e registra claim,
esclusioni e conferme. La conferma richiede la previsione effettivamente
salvata, associata a protocollo, fixture, kickoff e finestra. Un tentativo
non confermato resta distinto da una previsione; non viene rigenerato
automaticamente. Questo non certifica completezza del calendario né
disponibilità storica rigorosa degli input.

### Calendario alternativo del solo collector

Con `MODEL_A_RESEARCH_CALENDAR_ENABLED=false` o assente rimangono il calendario
Understat importato e il manifest precedenti; non partono richieste al nuovo
provider. L'opt-in usa [football-data.org](../backend/src/services/modelAResearchCalendar.ts)
soltanto per identità, stato e kickoff delle fixture. Understat resta la fonte
degli xG, dello storico e degli esiti; la Nightly A/C ordinaria non cambia fonte.

Occorrono un account Free autorizzato, condizioni accettate e il secret
repository **`FOOTBALL_DATA_ORG_API_KEY`**. È una credenziale distinta da
API-Football: `API_FOOTBALL_ENABLED` resta `false` e la sua chiave non abilita
questo calendario. Registrazione, disponibilità reale e copertura dell'account
vanno verificate prima dell'uso; l'implementazione locale non le dimostra.
Non inserire la chiave nelle variabili pubbliche, nei file versionati o nei log.

Il mapping richiede revisione esplicita degli ID, senza deduzione dai nomi:
la coppia ordinata casa/trasferta deve risolvere una sola partita Understat
nella stessa lega e stagione. Usare una sola stagione e un **nuovo protocollo**:
`--print-scope`, con opt-in e configurazione completi ma senza chiave, include
nel manifest fonte, hash SHA-256 del mapping, conteggi attesi e massima età.
Congelare il nuovo `MODEL_A_COLLECTION_MANIFEST_SHA256` prima della raccolta;
non riutilizzare il protocollo precedente con una policy diversa.

Ogni lega richiede il calendario completo di andata/ritorno, squadre attese,
abbinamenti univoci e acquisizione ancora fresca. Feed parziale, duplicati,
mapping mancante, errore o scadenza escludono la lega senza ripiegare sul vecchio
calendario. Le leghe utilizzabili possono proseguire: il run conserva `partial`,
`calendar_feed_unavailable` e exit code `1`; il loop può tentare il ciclo
successivo. Solo fixture `TIMED` nella finestra prevista avviano inferenze.

Le evidenze append-only sono in `model_a_calendar_attempts` e
`model_a_calendar_fixtures`, previste dallo
[schema manuale](../backend/experiments/model-a-prospective/schema.sql).
Non vengono riscritte `matches` o `teams`; il collector congela una copia della
fixture e ricontrolla la prova dopo il claim. `acquiredAt` indica acquisizione
locale, `providerLastUpdated` una revisione dichiarata e `publicationAt` resta
null: nessuno di questi dati prova la disponibilità storica degli xG. I record
restano `technical_only`. La configurazione non applica schema, non attiva
raccolta e non distribuisce servizi. Dettagli nel
[protocollo prospettico](models/MODEL-A-VALIDAZIONE-PROSPETTICA.md#calendario-alternativo-solo-ricerca-e-opt-in).

### Persistenza e controlli del runner

Sul runner il job usa `MODEL_A_PROSPECTIVE_STORAGE=database`, recorder attivo
e `MODEL_A_COLLECTION_INTERVAL_SECONDS=0`: un solo ciclo, senza dipendere
dal filesystem effimero per considerare acquisito un evento. Richiede i
secret Turso esistenti e lo schema prospettico applicato **separatamente e
con autorizzazione**. Non installa lo schema, non esegue il comando dedicato
di warmup, non avvia il backend HTTP e non riceve chiavi provider quote.
Questo non limita le scritture alle sole nuove tabelle: PredictionService
può salvare runtime_calibration_cache a cache miss, e il recorder attivo
avvia l'associazione agli esiti già presenti nel DB. Il refresh HTTP è
un opt-in separato. Verificare questi effetti e la cache esistente nel piano
autorizzato del target, senza usare il warmup come migrazione implicita.
La configurazione del workflow non attesta che schema, credenziali, flag o
raccolta siano stati attivati sul target.

I budget sono soglie di monitoraggio, non timeout che interrompono il calcolo.
Ogni run conserva in `model_a_collection_runs.performance_json` soglie,
campioni, massimo e numero di superamenti per previsione e conferma; gli
esiti `stored` e `unconfirmed` restano distinti. Il CLI segnala
`collection_performance_budget_exceeded` e imposta exit code `1`, senza
troncare richieste in corso, cambiare formule o scartare eventi per rispettare
la soglia. In modalità loop il superamento non arresta automaticamente i
cicli successivi. Una modifica delle soglie richiede una motivazione prima
della valutazione: alzarle dopo una misura non dimostra un miglioramento.

Se il monitoraggio è abilitato, dopo il collector il job tenta anche in caso
di errore:

```powershell
node backend/scripts/check-model-a-prospective.js --configured-database
```

Il controllo usa sole `SELECT`, scope e hash congelati nel DB; non avvia
`DatabaseService`, bootstrap o notifiche esterne. Il report aggregato mantiene
distinti copertura, attività del collector, consegne non confermate ed esiti.
Il riepilogo GitHub mostra stato e numero di alert; JSON e log diagnostici
sono conservati come artifact per 14 giorni. La pipeline conserva l'exit
code del controllo, quindi gli alert non diventano un successo per effetto
di `tee`. Gli artifact non sono un backup degli eventi. Questo monitor nello
stesso job non avvisa autonomamente se il workflow non parte o termina prima
del controllo. Il job `model_a_inspect` separato nel watchdog orario esistente usa obbligatoriamente `TURSO_WATCHDOG_READONLY_TOKEN`, senza dipendere dall’esito Nightly. Parte soltanto con `MODEL_A_PROSPECTIVE_MONITORING_ENABLED=true` e rileva anche un collector mai partito. Un fermo globale di GitHub può impedire anche il watchdog; controllare comunque la continuità della piattaforma.
Leggere anche `performanceStatus` e le relative notice: dati assenti,
incompatibili o senza campioni non equivalgono a latenza zero o budget
rispettato. Un `status=ok` generale con prestazioni `unverified` non è una
prova positiva sulle prestazioni; provenienza temporale e validità scientifica
restano criteri separati.

Per sospendere nuove raccolte disabilitare
`MODEL_A_PROSPECTIVE_COLLECTION_ENABLED`, conservando DB, ledger e previsioni.
Le quattro abilitazioni — raccolta, recorder, refresh e monitoraggio — restano
distinte per il processo locale; il workflow imposta recorder e raccolta solo
dopo il gate del job. Il profilo Compose opzionale è descritto nella
[guida hosting e storage](operations/hostless-deployment.md).

## Configurazione

| Impostazione | Comportamento dichiarato |
| --- | --- |
| Secret `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | DB condiviso del job; verificare che corrisponda a web e altri workflow |
| Secret `ODDS_API_KEY` | Quote bookmaker; solo server/runner |
| Variable `ODDS_API_ACCOUNT_SCOPE` | Default `primary`; stesso scope per chiavi dello stesso account, anche dopo rotazione |
| Variables `RESEARCH_NIGHTLY_ENABLED`, `RESEARCH_NIGHTLY_RECOMMENDATION_ENABLED` | Due opt-in distinti, entrambi con fallback `false` |
| `RESEARCH_NIGHTLY_MINUTE` | `7` nel workflow; allineare dashboard e monitor. Il runtime isolato ha default `0` |
| `RESEARCH_NIGHTLY_QUOTE_MAX_AGE_SECONDS` | `300`, freschezza alla decisione notturna, non al kickoff |
| `RUN_ODDS_SYNC`, `ODDS_INFORMATIONAL_NETWORK_ENABLED` | `false`: niente raccolta informativa generale; il feed essenziale A/C resta distinto |
| `ODDS_EXTRA_EVENT_NETWORK_ENABLED` | `true` nel workflow: mercati per evento di A soggetti a cache, costo e disponibilità |
| `RESEARCH_T15_SCHEDULER_ENABLED` | `false`; il worker continuo è ritirato |
| `RESEARCH_NIGHTLY_TIMEOUT_SECONDS` | `1200` per il processo A/C; job complessivo massimo 180 minuti |

I default locali sono in [.env.example](../.env.example); i valori remoti
non derivano automaticamente dal file locale. I flag Hostless dichiarano
lo stato al web, ma non avviano il job GitHub. Budget e cache provider sono
persistenti e condivisi: le soglie locali non attestano il piano o il residuo
reale dell'account. Quote mancanti, obsolete o sintetiche non diventano quote
bookmaker per evitare un'astensione.

Per sostituire una chiave esaurita, verificare separatamente il saldo delle
due credenziali con il probe gratuito e aggiornare il secret `ODDS_API_KEY`.
Una rotazione sullo stesso account conserva `ODDS_API_ACCOUNT_SCOPE`; una
sottoscrizione con quota indipendente richiede invece uno scope distinto e
stabile, condiviso dai processi che usano quella sottoscrizione. Conservare
il ledger precedente: cambiare soltanto la chiave lascia attivo il budget
esaurito del vecchio scope. Verificare il secret effettivo del runner con
`Odds API Smoke`, input `quota_only=true`, prima del successivo ciclo.

## Recupero controllato

Prima di ritentare, verificare giornata italiana, commit, stato dei run,
assenza di una Nightly attiva, completamenti già riusciti e causa dell'errore.
Un tentativo della giornata precedente non recupera una diversa giornata.

- **Errore ordinario prima del completamento:** correggere la causa, poi
  avviare la Nightly della giornata corretta conservando guard e idempotenza.
- **Fixture mancanti dopo un successo A/C odierno:** input manuale
  `recover_missing_fixtures=true`. È un'eccezione esplicita al salto giornaliero,
  non un ricalcolo delle decisioni già registrate.
- **Astensioni per blocco tecnico recuperabile:** input
  `recover_technical_failures=true`, `recovery_source_policy` con hash SHA-256
  della policy originale e `recovery_day` nel formato `YYYY-MM-DD`
  (vuoto significa oggi a Roma). Il recupero richiede A/C e recommendation
  abilitate, fonti verificate e kickoff futuro; crea una policy figlia e
  preserva giocate esistenti e decisioni non tecniche. Controlla i recuperi
  già conclusi anche al commit.

Il recupero tecnico con policy figlia supporta soltanto le policy legacy
`virtual-recommendation-v2/v3`, non `paper-fixed-unit-v1` o `funded-confidence-v1`. Nel ciclo finanziato
ordinario distinguere i job `ERROR` senza input definitivo, ritentabili secondo
i controlli del registro, dalle decisioni già completate, che restano immutabili.
`recovery_day` seleziona la giornata italiana del **kickoff**, non quella del
run originale; kickoff passato o finestra originale scaduta escludono il recupero.

Il [planner tecnico](../backend/scripts/recover-recommendation-technical.js)
legge il DB e scrive soltanto un piano privato locale. Da `backend`, con
credenziali già caricate in ambiente e preferibilmente token RO dedicato:

```powershell
node scripts/recover-recommendation-technical.js plan --source-policy <hash-originale> --day <YYYY-MM-DD> --out artifacts/recovery/<nome-univoco>.json
```

Richiede dipendenze e build backend coerenti. La produzione del piano non
esegue il recupero e non prova nuove giocate.

### Recupero degli esiti prospettici fuori dall'orizzonte ordinario

Il [CLI risultati](../backend/scripts/model-a-prospective-results-recover.js)
prepara per default un piano con sole `SELECT`, senza richieste Understat,
lease, bootstrap o migrazioni. Richiede build coerente e credenziali già
configurate in ambiente; non carica `.env`. Per il piano su file locale è
richiesto Node >=22.13, con apertura SQLite in sola lettura; il percorso
remoto conserva compatibilità Node 20. Sostituire gli argomenti fra parentesi
con intervallo UTC e ID effettivi del target autorizzato:

```powershell
node backend/scripts/model-a-prospective-results-recover.js --from "<inizio-UTC>" --to "<fine-UTC>" --match-id "understat_<id>" --limit 20
```

Gli estremi kickoff sono inclusi, l'inizio deve precedere la fine, la fine
non può essere futura e l'intervallo non supera 366 giorni. `--match-id` è
ripetibile e restringe alle fixture indicate; senza l'opzione lo scope
comprende l'intervallo richiesto. Si considerano solo previsioni esistenti:
non si ricostruiscono pronostici pre-match mancanti.

Solo dopo revisione del piano e autorizzazione alle scritture, ripetere lo
stesso comando aggiungendo **entrambi** gli argomenti
`--execute --authorize-results-writes`. Servono anche
`MODEL_A_PROSPECTIVE_ENABLED=true` e
`MODEL_A_PROSPECTIVE_RESULTS_REFRESH_ENABLED=true`; un solo argomento o un
flag mancante non autorizza l'esecuzione. Questa modalità può contattare
Understat e salvare osservazioni/esiti; non è una lettura diagnostica.

Ogni invocazione lavora una pagina, default 20 elementi (`--limit` 1–200).
Ripetere lo stesso scope riprende il suo cursore persistito indipendente dal
refresh ordinario degli ultimi 30 giorni. Verificare riepilogo, motivi ed
eventuali errori prima di proseguire: un piano prodotto non prova che gli
esiti siano stati acquisiti o verificati.

Per un errore DNS Understat, controllare separatamente DNS e HTTPS della
fonte ufficiale, senza DB o provider quote:

```powershell
Resolve-DnsName understat.com
Invoke-RestMethod 'https://dns.google/resolve?name=understat.com&type=A'
Invoke-RestMethod 'https://cloudflare-dns.com/dns-query?name=understat.com&type=A' -Headers @{accept='application/dns-json'}
```

Il workflow manuale [Source connectivity diagnostic](../.github/workflows/source-connectivity.yml)
prova DNS/HTTPS pubblici dal runner senza credenziali. Usa endpoint stagionali
codificati: verificarne la pertinenza prima di interpretare il risultato.
Un HTTP raggiungibile non dimostra copertura importata. Non sostituire
Understat, non fissare IP storici, non disabilitare TLS e non allentare il
matching football-data per superare il gate. Ricontrollare il supplemento
dopo il recupero della fonte primaria.

## Monitoraggio e prova del risultato

Il [watchdog](../.github/workflows/research-watchdog.yml) parte ogni ora al
minuto 37, dopo `Nightly Sync` e manualmente. Usa
[check-research-nightly.js](../backend/scripts/check-research-nightly.js),
indipendente dal backend Hostless: non avvia l'app, non migra il DB, non
contatta il provider quote e non registra giocate.

- `RESEARCH_NIGHTLY_MONITOR_ENABLED=true` richiede un completamento A/C
  programmato; il default remoto dichiarato nel workflow è `false`.
  `expect_enabled=true` lo richiede per il controllo manuale.
- `RESEARCH_NIGHTLY_DB_MONITOR_ENABLED=true` attiva il controllo DB separato.
  Richiede `TURSO_DATABASE_URL` e `TURSO_WATCHDOG_READONLY_TOKEN` dedicato:
  non ripiega sul token di scrittura.
- Il monitor DB valuta la quota Odds API dello scope configurato in
  `ODDS_API_ACCOUNT_SCOPE` (default `primary`); l'overview conserva anche gli
  account storici. Un vecchio scope esaurito non blocca il nuovo account.
  `activeOdds` distingue osservazione salvata, esaurimento e quota non verificata:
  budget assente o senza osservazione utilizzabile non attestano crediti disponibili.
  Con monitoraggio della Nightly abilitato, una quota non verificata resta un allarme.
- Gli errori osservati, gli stalli recenti, le liquidazioni arretrate e la
  coerenza contabile restano distinti dall'aspettativa di una nuova Nightly.
  Un errore di accesso non è un esito sano.
- `RESEARCH_NIGHTLY_ACKNOWLEDGED_ORPHAN_RUN_IDS` è un'eccezione stretta per
  run storici senza job, ancora queued e di una giornata precedente.
  Non cancella run o allarmi generici; un run che riparte torna segnalato.

Da `backend`, con ambiente privato già configurato:

```powershell
npm run research:watchdog -- --github-only
npm run research:watchdog -- --database-only
```

Il primo richiede `GITHUB_TOKEN` e `GITHUB_REPOSITORY`, senza build o accesso DB.
Il secondo richiede dipendenze/build e token RO; esegue SELECT e non crea schema.
Senza opzioni, il controllo DB è `NOT_CHECKED` se mancano le sue credenziali.
Exit code `0` indica controlli superati; `1` indica problemi.

Per attestare il recupero servono passi Sync e marker A/C riusciti, gate dati
coerenti, controllo GitHub e controllo DB superati. Zero giocate può essere
una corretta astensione: verificare decisioni, motivi, quote, ledger e
liquidazioni, senza forzare una puntata. Una Nightly riuscita non dimostra
redditività o completamento futuro del ciclo sportivo.

Il controllo di ammissibilità legge lo storico con le colonne statistiche
normalizzate, senza scaricare i payload `raw_json` dei provider: questi non
sono input dei controlli A/C. Le informazioni originali restano conservate nel
database. La liquidazione dell'archivio tecnico usa invece batch di partite
prima del download delle predizioni e conserva i dettagli necessari ai mercati
giocatore; continua oltre le partite non liquidabili. Il limite di manutenzione
riguarda soltanto quell'archivio e non limita le nuove selezioni finanziate.

Il salvataggio dei nuovi job ordinari raggruppa le letture e gli INSERT
con `Transaction.batch` nella stessa transazione, mantenendo validatori,
deduplicazione e controlli finali su lease, kickoff e freschezza delle quote.
Un errore annulla l'intero gruppo. Questo riduce i passaggi HTTP delle
[transazioni interattive libSQL](https://docs.turso.tech/sdk/ts/reference#interactive-transactions),
per cui Turso documenta un timeout di cinque secondi; non aumenta quel limite
e non impone un massimo alle selezioni. Replay già completati, recuperi tecnici
e policy precedenti conservano il percorso originale: il batching ordinario
non ne dimostra le prestazioni su grandi volumi.

Gli errori globali riportano `failedStage` e, quando riconosciuto da una
whitelist, `failureCode`. Il riepilogo conserva l'esito negativo e il cleanup;
messaggi grezzi, query e credenziali non vengono inclusi nella diagnostica.

Il riepilogo in-app della giornata precedente è preparato dopo reconcile
con contabilità stabile e reso visibile dalle 09:00 Europe/Rome.
Il GET non lo crea e non invia email: verificare la riga effettivamente
preparata, non dedurla dal solo badge del workflow.

## Calibrazione, arresto e rollback

[Prepare prediction calibration](../.github/workflows/calibration-warm.yml)
non parte più al push. L'unico trigger è manuale e il job richiede insieme
`authorize_database_writes=true` e la variable repository
`OPERATIONAL_CALIBRATION_ENABLED=true`; l'input è obbligatorio e ha default
`false`. Lo script applica lo schema additivo della cache e salva i profili
sul DB dei secret: pubblicare codice non autorizza questa operazione.
Il ciclo Nightly non richiama più quel warmup e non usa il rebuild implicito.
Per una preparazione senza DDL usare il comando separato, da `backend`, con
ambiente privato già configurato:

```powershell
node scripts/calibration-operational.js --plan
node scripts/odds-account-preflight.js --plan --target-sha256 $env:NIGHTLY_SOURCE_TARGET_SHA256
```

Il primo comando è SELECT-only, verifica lo schema esistente ed emette le
chiavi esatte richieste; il secondo legge solo il namespace quote configurato.
Non prova che il secret GitHub corrisponda alla chiave locale e non certifica
un saldo live. Il probe esistente `probe-odds-quota.js` usa soltanto `GET /sports`,
[senza consumo di crediti](https://the-odds-api.com/liveapi/guides/v4/#get-sports).
Per verificare la chiave del runner è predisposto anche `Odds API Smoke` con
`quota_only=true`: è un'esecuzione manuale separata, non avviata dal preflight.

Dopo consenso esplicito alla sola scrittura della cache, backup del DB e
blocco degli import concorrenti, usare la **stessa build/configurazione**:

```powershell
$env:OPERATIONAL_CALIBRATION_ENABLED = 'true'
node scripts/calibration-operational.js --execute --authorize-calibration-writes --target-sha256 $env:NIGHTLY_SOURCE_TARGET_SHA256 --backup-file C:\percorso-privato\nuovo-backup-calibrazione.json
```

Il file deve essere nuovo, resta privato e contiene tutte le righe cache con
hash verificato prima del calcolo. Il comando rifiuta schemi mancanti, non
applica migrazioni, non contatta provider, non aggiorna `model_params` e limita
le scritture alla cache. Le curve sono quelle del calibratore già esistente;
non modifica formule o C. Richiede un nuovo servizio con HIT esatti dopo la
generazione. Le scritture delle singole curve non costituiscono un'unica
transazione per tutte le leghe: su errore mantenere la Nightly spenta, verificare
il backup e autorizzare un eventuale ripristino della sola cache in transazione.
Ripristinare vecchie curve non le rende compatibili con un codice diverso.

Prima dell'accensione verificare anche data e copertura dei parametri A,
artefatto e deployment C, budget condiviso e scope della chiave effettiva.
Pubblicazione, inizializzazione delle cache fonti, import operativo, scrittura
delle curve e attivazione sono autorizzazioni distinte. Lo stato remoto non si
deduce dai default o da una prova locale.
La CI ordinaria conserva lint, typecheck, build e test su push/PR di `main`.
Il controllo sorgente ripetibile, senza credenziali o accesso remoto, è:

```powershell
node backend/scripts/check-operational-workflow-gates.js
```

Verifica i contratti dei workflow supportati; non certifica impostazioni di
auto-deploy esterne a GitHub, valori remoti o disponibilità del database.
[Research training](../.github/workflows/research-training.yml) gestisce il
training separato: un risultato di benchmark non promuove automaticamente C.

Per fermare le nuove giocate recommendation disabilitare
`RESEARCH_NIGHTLY_RECOMMENDATION_ENABLED`, conservando workflow completo,
import e liquidazioni. `RESEARCH_NIGHTLY_ENABLED=false` disabilita tutto il
processo A/C ma non le liquidazioni esistenti eseguite prima nello script.
La sola CLI A/C o un retry saltato non sostituiscono il ciclo manutentivo.
Non riattivare `AUTO_BET_*` o il worker T−15. Preservare ledger, input,
snapshot, versioni e migrazioni; usare soltanto rollback di codice compatibili
con lo schema e [backup verificati](operations/turso-backup.md).

## Preflight del target Modello A senza scritture

Il workflow `model-a-target-preflight.yml` si avvia solo manualmente con `expected_host_sha256` e stagione YYYY/YYYY. Usa URL canonico, token Turso dedicato di sola lettura (senza fallback al token operativo), chiave FDO del runner e mapping revisionato già configurato, verifica l'impronta dell'hostname prima dell'accesso e invia soltanto SELECT fissi. Non importa il bootstrap applicativo, non applica schema e non attiva collector/recorder. Confrontare privatamente la medesima impronta dal processo Hostless e dal target locale; non stampare URL o token.

Il report aggregato distingue identità, accesso read-only, presenza delle nove tabelle prospettiche/calendario e `runtime_calibration_profiles`, copertura delle cinque leghe e mapping. Schema assente dà blocked/exit1 anche se calendario e credenziale funzionano. La sola presenza delle tabelle non certifica colonne/indici/trigger; completare l'ispettore e le prove autorizzate. `persistenceVerified` e `collectionVerified` restano false: nessuna SELECT dimostra la durabilità di una nuova previsione. Nessun cron, secret su push o infrastruttura aggiuntiva.
