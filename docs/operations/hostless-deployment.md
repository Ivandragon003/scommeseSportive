# Deploy web su Hostless

Hostless serve frontend React e backend Express; Turso conserva i dati
condivisi. Import e automazione A/C sono un job finito su GitHub Actions,
come descritto nella [guida Nightly](../github-actions-nightly-sync.md).
Non richiedono PC o smartphone accesi. Questa è una procedura di rilascio,
non una certificazione dello stato attuale dell'account o dei servizi.

## Configurazione da controllare

| Componente | Configurazione prevista dal repository |
| --- | --- |
| Backend | Build Docker con contesto `backend/`, [Dockerfile](../../backend/Dockerfile), target runtime e comando `node dist/index.js` |
| Frontend | Root `frontend/`, install `npm ci`, build `npm run build`, output `build/` |
| API | Porta `PORT` oppure 3001; healthcheck `/api/health` |
| Persistenza | `TURSO_DATABASE_URL` e `TURSO_AUTH_TOKEN` server-side; filesystem container effimero |
| Nightly | `NIGHTLY_ORCHESTRATOR=github_actions`; niente scheduler interno duplicato |
| Worker T−15 | Ritirato; non configurare `research-worker.js` come processo persistente |

Il Dockerfile usa Node 20, utente non root e healthcheck interno ogni
15 secondi. L'inferenza C legge gli alberi JSON in Node: Python/CatBoost
serve al training e alla verifica separata, non all'immagine runtime web.
Non aggiungere smoke ripetuti o training al comando d'avvio del servizio.

Controllare nel pannello Hostless repository/branch/commit, root e contesto
di build, comando, auto-deploy, risorse, worker e cron esistenti prima del
rilascio. Non dedurre piano, limiti gratuiti, fatturazione, continuità o
capacità residua dai limiti Docker o da una vecchia misura CPU.
Restare sui servizi esistenti e sul piano gratuito effettivamente disponibile;
un aumento di risorse o servizio a pagamento richiede una decisione esplicita.

## Persistenza per il recorder prospettico A

Prima di configurare `MODEL_A_PROSPECTIVE_SPOOL_DIR`, verificare un volume
effettivamente montato sul **processo che produce le previsioni**. Un percorso
nel codice o una cartella nell'immagine non costituiscono un volume.
Il Compose corrente non dichiara mount persistenti per il backend.

La [documentazione del filesystem Hostless](https://docs.hostless.cloud/app/filesystem)
descrive root in sola lettura e cartelle temporanee eliminate alla ripartenza;
solo il mount di un volume conserva i file. Permessi, hard link, backup e
recupero devono essere provati sul mount reale. Secondo il
[listino dei volumi](https://docs.hostless.cloud/billing/costbreakdown), i volumi
persistenti hanno costi separati e non usano la quota gratuita condivisa:
non crearne o collegarne uno automaticamente per questo progetto.
Disponibilità e costo dell'account richiedono conferma nel pannello.

La Nightly A/C gira su un runner GitHub separato: un volume del web non
diventa il suo spool. Il workflow non esporta i flag `MODEL_A_PROSPECTIVE_*`
e non predispone un mount durevole per il runner. Gli artefatti caricati a
fine job non provano sopravvivenza a un arresto precedente al caricamento.
Non abilitare il recorder finché processo, calendario, persistenza e
monitoraggio non sono verificati insieme; vedere il
[passaggio Fase 4](../models/MODEL-A-FASE-4-HANDOFF.md).

## Effetti operativi del push su main

La CI non è l'unico effetto del push: il workflow
[calibration-warm.yml](../../.github/workflows/calibration-warm.yml) reagisce
alle modifiche ammesse su `main`, usa i secret Turso ed esegue
`npm run calibration:warm`. Lo [script](../../backend/scripts/warm-calibration.js)
applica lo schema della cache `014_runtime_calibration_cache.sql` e salva
profili nel database configurato. Le modifiche a `PredictionService.ts`
ricadono nei suoi filtri. Un'integrazione osservativa può quindi produrre
scritture remote anche con recorder spento.

Se il task vieta migrazioni o modifiche operative, sospendere il push su
`main` e segnalare questa conseguenza. Verificare inoltre l'auto-deploy del
provider: la sua assenza dai workflow GitHub non dimostra che sia spento.
Non modificare silenziosamente trigger, credenziali o servizio per aggirare
il blocco.

## Ambiente, accesso e URL

Usare il pannello nativo del provider per i secret già autorizzati. Le
variabili `REACT_APP_*` sono pubbliche nella build: non contengono password,
token Turso o chiavi quote. Il riferimento locale è [.env.example](../../.env.example).

- Backend: `NODE_ENV=production`, `SHARED_ADMIN_AUTH_ENABLED=true`,
  `SHARED_ADMIN_PASSWORD_HASH` valido, `SHARED_DATA_USER_ID` coerente con i
  dati esistenti. La produzione rifiuta l'avvio senza hash richiesto.
- `CORS_ORIGIN` deve ammettere l'origine frontend effettiva e
  `https://localhost` per Android. Verificare HTTPS, proxy e cookie di sessione.
- Turso deve essere lo stesso canonico per web, Nightly, calibrazione,
  training e manutenzione; il watchdog usa un token dedicato RO sul medesimo DB.
- Quote: chiave backend/runner e `ODDS_API_ACCOUNT_SCOPE` coerenti fra processi.
  Budget pianificato e quote residue misurate sono informazioni diverse.
- Tenere bootstrap e scheduler web disabilitati quando GitHub è l'orchestratore;
  `RESEARCH_T15_SCHEDULER_ENABLED=false`. I flag A/C sul web dichiarano stato,
  ma il job è avviato soltanto dal workflow.

Il [client API](../../frontend/src/utils/api.ts) usa `REACT_APP_API_URL` se
presente, altrimenti `/api` nel browser e
`https://scommese-sportive-backend.hostless.app/api` su Android.
Per il frontend Hostless separato impostare in fase di build l'URL HTTPS
corretto del backend; non assumere che `/api` sia inoltrato automaticamente.
Il valore incorporato nell'APK cambia solo con una nuova build autorizzata.

Per generare un hash condiviso usare `npm run auth:hash` da `backend`, con
password fornita via standard input, senza password negli argomenti o nella
cronologia. Conservare hash e password nei canali privati appropriati;
non inserirli nella documentazione, nel frontend o nell'APK.

## Sequenza di rilascio e verifica

1. Verificare checkout, commit da distribuire, diff, compatibilità delle
   migrazioni additive e [backup](turso-backup.md) quando il DB è coinvolto.
   Eseguire i controlli di codice pertinenti prima del rilascio.
2. Distribuire il backend dal commit previsto. Attendere l'esito finale del
   provider: Queued, Building o una CI verde non significano LIVE.
3. Controllare `/api/health`, login/sessione e le API necessarie al frontend
   (in particolare `/api/wallets` dopo modifiche ai portafogli). Verificare
   l'identità del DB senza esporre credenziali e mantenere invariati i saldi.
4. Distribuire il frontend dopo il backend compatibile, con l'URL API corretto.
   Controllare nel browser sessione, Partite, Giocate, Budget e Archivio,
   dispositivi stretti e messaggi di indisponibilità quote.
5. Verificare separatamente Nightly/watchdog quando il rilascio li riguarda.
   Evitare fetch quote o registrazioni manuali soltanto per provare il deploy:
   aprire Giocate nel dettaglio può richiedere quote reali e consumare crediti.

Il backend previsto dal client espone l'healthcheck a
[questo indirizzo](https://scommese-sportive-backend.hostless.app/api/health).
L'URL identifica il target configurato; non attesta che risponda ora.
Un aggiornamento web non aggiorna gli asset React già inclusi nell'APK:
vedere [procedura Android](../android-private-apk.md).

## Worker legacy, CPU e rollback

La CLI [research-worker.js](../../backend/scripts/research-worker.js) stampa
`worker_retired` e termina normalmente. Un worker incorporato rimasto con
quel comando può fallire il proprio ciclo di vita mentre il web è LIVE.
Verificare separatamente deployment web e inventario worker; non riattivare
T−15 e non sostituire il comando con la Nightly finita per simulare un demone.
La rimozione di configurazioni cloud obsolete richiede verifica dell'esatto
oggetto e del resto della configurazione; non eliminare altri servizi o dati.

Un avviso CPU, un campione aggregato e un deploy in coda descrivono fenomeni
diversi. Correlare orario, processo, log e metriche prima di attribuire una
causa al modello o dichiarare risolto il problema. Una cache di calibrazione
non riusabile può richiedere calcolo completo su richiesta; un hash di codice
diverso non prova riuso del warmup.

Per fermare nuove registrazioni recommendation spegnere il relativo flag
GitHub, mantenendo il ciclo di manutenzione e liquidazione. Per rollback di
codice usare una versione compatibile con schema e payload esistenti,
coordinando frontend, backend e workflow sul DB canonico. Un backup locale
non autorizza un restore remoto; non ripristinare collegamenti a vecchi DB
o cancellare ledger e storico.
