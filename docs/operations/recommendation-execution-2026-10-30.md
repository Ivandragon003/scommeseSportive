# Consigli dell'app e registrazione virtuale A/C — 30 ottobre 2026

## Stato del rilascio

Rilascio e prima esecuzione reale completati il 30 ottobre 2026:

- Backend Hostless LIVE su `eb5d838e0acb27f9f7b42456d698452873782221`,
  deployment `6ae4984bb53426f1e55ec75c`.
- Frontend Hostless LIVE su `3c503fa94dd92b93c1323f7eb47068a23b829cf2`,
  deployment `6ae49cd1e2d5898dc9ef7bb2`, bundle `main.19ac8816.js`.
- `RESEARCH_NIGHTLY_ENABLED=true` e
  `RESEARCH_NIGHTLY_RECOMMENDATION_ENABLED=true` verificati su GitHub.
- [Nightly 41069572500](https://github.com/Ivandragon003/scommeseSportive/actions/runs/41069572500)
  conclusa con successo: cinque partite, dieci decisioni, cinque puntate
  virtuali effettive, zero errori. Nessuna scommessa con denaro reale.

| Portafoglio | Capitale iniziale / patrimonio | Disponibile | Impegnato | Puntate aperte |
| --- | ---: | ---: | ---: | ---: |
| A | 1.000,00 euro | 955,80 euro | 44,20 euro | 3 |
| C | 1.000,00 euro | 980,00 euro | 20,00 euro | 2 |

Gli importi impegnati non sono perdite: le cinque partite devono ancora
produrre un risultato ufficiale e una liquidazione. Il primo ciclo
prospettico completo rimane **in corso**. Non è attestata la puntualità
di una futura esecuzione schedulata soltanto in base a questo run manuale.

## Comportamento richiesto

- **A:** il modello operativo della pagina Partite, con il suo consiglio
  canonico LOW/MEDIUM/HIGH e il suo `suggestedStakePercent`, applicato al
  patrimonio del portafoglio virtuale A. Nessun secondo fattore di confidenza
  o minimo automatico di un euro.
- **C:** il modello ibrido registrato, versione `C-906371b0b3a1e2c8`, con
  stake fisso dell'1% del proprio patrimonio. La sua baseline interna Research
  A80 rimane invariata; non viene sostituita con APP-A senza riaddestramento.
  Il caricamento è fissato a questa versione: nuove candidate settimanali non
  la sostituiscono. Se manca, C si astiene; A può continuare autonomamente.
- Due portafogli indipendenti, capitale iniziale 1.000 euro ciascuno,
  esposizione massima 5% e una sola puntata per partita e portafoglio.

Una raccomandazione tecnicamente valida viene registrata soltanto se quota,
saldo ed esposizione lo consentono. Uno stake che supera i limiti produce
un'astensione motivata: non viene ridotto silenziosamente. Le quote devono
essere realmente espresse dal bookmaker, aggiornate entro cinque minuti e
acquisite prima del calcio d'inizio. Non vengono create giocate retroattive.

Il nuovo percorso virtuale non richiede 50 risultati prospettici e non usa
la penalità Hoeffding come veto economico. Questi controlli restano nella
diagnostica e nei benchmark storici, separati dall'autorizzazione virtuale.
Non viene promossa l'affidabilità economica di un mercato sperimentale.

## Una sola selezione, con provenienza esplicita

Il backend applica il medesimo picker della pagina: filtri sulle quote reali,
preferenza HIGH/MEDIUM, condizioni per LOW e ordinamento deterministico.
Il frontend consuma il risultato senza un secondo ranking indipendente.
APP-A è distinto dalla precedente variante Research A80: probabilità e
stake provengono dal vero `PredictionService`, con hash di codice,
configurazione e stato del modello tracciati separatamente.

C conserva probabilità e artefatto registrati; non si applica nuovamente
calibrazione o blending. Usa il picker comune sulle alternative supportate.
L'adattatore corrente esclude le linee C con rimborso o payout parziale
quando il calcolo dell'engine non consente una confidenza coerente; il
motivo è esplicito e viene cercata un'altra alternativa valida. A conserva
il consiglio originale quando la liquidazione è già supportata.

Le politiche di stake A e C sono diverse per scelta dell'utente. Differenze
di profitto dei portafogli non dimostrano, da sole, superiorità predittiva.
C rimane Challenger e il precedente benchmark A80 non viene attribuito ad APP-A.

## Storico e contabilità

La migrazione additiva 023 introduce quattro tabelle `research_execution_*`
per policy, lease, input condivisi e decisioni. Le dieci astensioni precedenti
restano immutabili. Le nuove valutazioni hanno timestamp, quote e policy
propri; non si modifica il passato per farlo apparire come una giocata.

`research_bets.execution_decision_id` identifica l'autorizzazione effettiva.
Il precedente `decision_id` conserva esplicitamente la provenienza diagnostica.
Puntata e ledger vengono inseriti nella stessa transazione: lo stake diminuisce
il disponibile e aumenta l'impegnato. La liquidazione libera l'impegnato e
accredita il ritorno comprensivo dello stake restituito. I vincoli globali e
gli identificatori idempotenti impediscono secondo addebito e doppia liquidazione.

Il confronto mostra la decisione effettiva, conservando la provenienza
storica. I conteggi per periodo sono completi; i dettagli hanno limiti
espliciti e le letture non caricano tutti i grandi snapshot dei modelli.

## Cosa mostra la pagina Partite

Prima della valutazione automatica viene mostrato il consiglio canonico live.
Dopo la valutazione, il consiglio A congelato ha priorità, con importo
effettivamente registrato, stato e timestamp. La quota archiviata non viene
presentata come un prezzo bookmaker corrente. Anche un'astensione tecnica
rimane visibile con motivo e dati mancanti: non è sostituita da un consiglio
live e non si inventano modello, probabilità o quote.

I replay conservano il consiglio storico e valutano la selezione effettivamente
mostrata. Una puntata automatica già presente non viene registrata di nuovo
attraverso il comando manuale della pagina.

## Backup e verifica della migrazione

Unico export ufficiale del Turso personale completato il 30 ottobre,
11:37–11:38 UTC: snapshot e WAL, 530.429.352 byte. Due ripristini locali
hanno integrità `ok`, zero violazioni FK e dati delle 57 tabelle coincidenti.
Il piano esistente e gli overage disabilitati sono stati verificati senza upgrade.
Le credenziali e il database originale del collaboratore non sono stati modificati.

La 023 ha superato applicazione completa, doppio avvio e arresto subito dopo
`ADD COLUMN` seguito da ripresa. Il runner riconosce soltanto la colonna TEXT
nullable con la FK attesa; una struttura incompatibile causa errore. Tutti
i dati delle colonne originali sono rimasti identici nelle due copie di prova.
Gli artefatti privati sono in `backend/artifacts/backups/personal-migration-20261029/decision-policy-20261030/`.

La migrazione 023 è stata applicata anche al Turso personale di produzione,
`footpredictor-selloneciompi.aws-eu-west-1.turso.io`, alle 13:14 UTC.
I confronti prima/dopo hanno confermato le colonne originali di 21 tabelle
protette, inclusi utenti, sessioni, storico e contabilità. Le 258 giocate
legacy sono conservate. Nessuna migrazione distruttiva o ripristino sopra
dati più recenti è stato eseguito.

## Verifiche remote completate

- Backend: healthcheck HTTP 200, accesso privato non autenticato HTTP 401,
  vecchia route automatica `place-valid-bets` HTTP 410.
- Frontend e pagine Partite/Confronto raggiungibili; sessione autenticata
  e schermata A con la quota archiviata e l'importo realmente registrato
  verificati nel browser integrato. La pagina non presenta la quota
  archiviata come prezzo corrente.
- Audit SQL in sola lettura: **71 controlli superati su 71**, inclusi
  stake, separazione dei portafogli, provenienza, contabilità, unicità e
  conservazione dello storico. C ha eseguito cinque inferenze remote
  con la versione prevista; non è stato promosso o riaddestrato.
- Quote reali usate nelle puntate: Codere (IT) e Betsson, freschezza
  51,6–79,3 secondi al momento della registrazione, prima del calcio d'inizio.
  Snapshot condivisi tra A e C; nessuna quota sintetica o Eurobet attribuita
  a un altro operatore.
- A ha usato stake 0,42%, 1,8% e 2,2%; C l'1% per ciascuna puntata.
  Un ulteriore consiglio A è stato escluso perché avrebbe superato il 5%
  di esposizione. Le altre astensioni sono conservate e motivate.
- La riesecuzione ordinaria
  [41071349342](https://github.com/Ivandragon003/scommeseSportive/actions/runs/41071349342)
  è stata fermata da `daily_sync_already_succeeded`: installazione, build
  e sincronizzazione saltate prima di avviare l'app o contattare il provider.
  Una successiva SELECT aggregata in sola lettura ha confermato invariati
  cinque bet, sette movimenti contabili, dieci decisioni, saldi e crediti.
- Il watchdog indipendente
  [41070547360](https://github.com/Ivandragon003/scommeseSportive/actions/runs/41070547360)
  è riuscito: controlli GitHub e database `ok=true`, nessun problema
  segnalato e Nightly `SUCCESS`, non scaduta. Il vecchio run senza job
  `40940944902` è riconosciuto esplicitamente; non è dichiarato cancellato.

Il provider ha riportato 325 crediti usati e 175 residui alle 14:16:55 UTC,
con limite mensile 500 e riserva configurata 50. Il riepilogo mensile
conserva anche un precedente errore (`DEGRADED`): questa etichetta dipende
dal conteggio degli errori nell'intero mese, non soltanto dall'ultima
richiesta, che è riuscita. Il registro non è stato azzerato. Non sono stati attivati piani,
servizi o API a pagamento; le risorse Hostless esistenti sono invariate.

La Nightly opera nel cloud, senza PC o smartphone accesi, con target
03:07 Europe/Rome e monitoraggio separato. Il percorso T−15 non è attivo:
il record del vecchio worker allegato rimane non distribuito, con errore
Hostless e senza lease/heartbeat operativo. Non è stato eliminato né
riattivato per questo rilascio.

L'APK Android precedente incorpora il proprio frontend e non viene
aggiornato da questo deploy web. Non è stato generato un nuovo APK perché
manca la chiave di firma originale; non è stato collaudato un dispositivo
fisico. Il sito aggiornato è utilizzabile dal browser del telefono.
Dettagli e requisito della stessa firma: [guida Android](../android-private-apk.md).

## Attivazione controllata e rollback

Prima dell'attivazione: controlli locali e CI, review indipendente, backup e
rehearsal, preview remota senza scritture finanziarie, migrazione additiva e
rilascio web compatibile. La preview può registrare metadati reali del modello
e predisporre i guard idempotenti, ma non claim, puntate o liquidazioni.

Solo dopo i controlli vengono abilitate le registrazioni con i flag espliciti.
Il rollback sospende la registrazione e conserva manutenzione, liquidazioni,
nuove viste effettive e storico. Non ripristina un database vecchio, non
riattiva l'endpoint legacy e non deve riprendere automaticamente stake della
precedente policy Research.

Per sospendere nuovi stake impostare
`RESEARCH_NIGHTLY_RECOMMENDATION_ENABLED=false`, conservando il workflow
completo e l'ultima versione backend compatibile con la 023. In
`scripts/ci/nightly-sync.sh` il `POST /api/research/settle` è eseguito prima
dei rami controllati dai flag: liquida le research bet già aperte mediante
il loro snapshot effettivo. Il solo CLI diagnostico o un retry saltato
dal controllo giornaliero non sono una garanzia di liquidazione. Non
sospendere l'intera manutenzione per fermare soltanto nuove registrazioni.

Restano da osservare i risultati ufficiali e la liquidazione delle nuove
puntate, oltre al successivo run schedulato. Il run reale e la verifica
della contabilità non dimostrano redditività o superiorità del modello C.

## Controlli locali completati

- Backend Linux Node 20, senza rete o credenziali: 1.015 test superati,
  zero errori, un test opzionale di training Python CatBoost escluso.
- Frontend: 215 test superati in 30 suite, esecuzione seriale; typecheck/lint backend e
  build Docker backend/frontend superati.
- Avvio Compose isolato: frontend e healthcheck HTTP 200; database locale,
  chiavi provider assenti e nuova registrazione disabilitata.
- Review indipendente completata sulla quarta copia immutabile compilata;
  file matematici e baseline Research A80 invariati. Scansione secret superata.
- CI backend e frontend superata sia per `eb5d838e` sia per `3c503fa9`.
