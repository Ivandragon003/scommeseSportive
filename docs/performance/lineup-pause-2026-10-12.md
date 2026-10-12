# Sincronizzazione e pausa formazioni — 12 ottobre 2026

Questo report documenta il primo intervento. La successiva richiesta di
sospendere anche i giocatori è attuata nel
[report sulla riduzione letture](db-read-reduction-2026-10-12.md): i riferimenti
seguenti agli import/player props attivi descrivono lo stato precedente.

## Evidenza osservata

- [Run dell'11 ottobre fallito](https://github.com/Ivandragon003/scommeseSportive/actions/runs/38119299507):
  Turso risponde `BLOCKED: SQL read operations are forbidden`. Il log certifica
  un blocco delle letture; non certifica il consumo preciso del piano o la causa
  amministrativa. Ripristinare i dati non dimostra che la quota letture sia disponibile.
- [Run effettivo del 12 ottobre riuscito](https://github.com/Ivandragon003/scommeseSportive/actions/runs/38215326732):
  25 coppie lega/stagione complete, 138 partite aggiornate, 2.191 giocatori
  aggiornati dalla fonte e ricostruzione derivata su 7.375 partite. Quest'ultima
  elaborazione resta attiva: sospendere le formazioni non elimina questo costo.
- Nel run del 12 ottobre API-Football segnala account sospeso. La fase opzionale
  continua col modello locale, salvando 283 righe di formazioni stimate.
- L'automazione registra otto giocate interne squadra; tre candidate player SOT
  LOW sono archiviate solo come simulazioni (`speculative_saved_only`), senza
  addebito operativo al budget. Questo snapshot non prova che i player props siano sempre
  assenti: il percorso operativo è implementato e richiede quote reali,
  matching univoco, campione/minuti e filtri di selezione.
- Lo stato finale comprende esecuzioni con trigger `scheduled` oltre a quelle
  `github_actions`: il backend distribuito ha ancora scheduler attivi, per
  configurazione esplicita o versione precedente. Verificare nel deployment
  `NIGHTLY_ORCHESTRATOR=github_actions` e riavviare/redeployare. Il codice corrente
  già disabilita Understat/quote/learning periodici con questo orchestratore.

## Intervento

Formazioni disabilitate per default con `PLAYER_AVAILABILITY_ENABLED=false`:
nessun collector, step nightly, lettura availability o snapshot nel predittore.
La UI non monta il pannello e non aggiorna availability dal refresh manuale o
dalla richiesta quote. Le route rispondono senza leggere/scrivere il DB o
contattare il provider, proteggendo anche vecchi APK dopo il deploy backend.
Il frontend ha un opt-in di build separato `REACT_APP_PLAYER_AVAILABILITY_ENABLED`.

Gli import Understat di giocatori/roster/shotmap e i player props restano attivi.
Le rose/statistiche alimentano anche copertura del contesto e tiri giocatore:
interrompere tutte queste letture cambierebbe il contesto delle previsioni.
Senza formazioni il filtro player usa le stime conservative già esistenti sulla
rosa e sui minuti, senza inventare titolari confermati o quote.

Nessuna eliminazione dati o modifica a fonti, mercati, formule e quote sintetiche.
La pausa riduce attività superflue ma non è una misura della quota Turso risparmiata.
Il codice locale richiede push/deploy per modificare GitHub Actions e produzione;
gli APK esistenti conservano il vecchio pannello finché non vengono ricompilati.

## Verifica locale

- Backend: build, 509 test su 509, typecheck e lint superati.
- Frontend: suite completa 130 test su 130; dopo l'aggiunta della regressione
  sulla pausa, test App 16 su 16. Typecheck, lint e build produzione superati.
- Guard delle quattro route availability verificato con DB/provider finti:
  zero accessi anche con provider configurato attivo.
- Sintassi Bash dello script nightly e `git diff --check` verificati.
- Avvio Node e healthcheck su porta 3301 con libSQL locale temporaneo e
  orchestratore GitHub; il flag collector precedente `true` è neutralizzato
  dalla pausa. GET e POST availability rispondono disabilitati.
- Docker non disponibile: daemon Docker Desktop spento. Nessuna verifica
  Compose completa, connessione al Turso di produzione o chiamata ai provider.
