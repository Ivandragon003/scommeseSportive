# Consigli dell'app e registrazione virtuale A/C — 30 ottobre 2026

## Stato del rilascio

Implementazione verificata localmente; rilascio Hostless e attivazione ancora pendenti.
La variabile GitHub `RESEARCH_NIGHTLY_RECOMMENDATION_ENABLED` è esplicitamente
`false`. Backend e frontend remoti sono ancora quelli del checkpoint precedente.
Nessuna nuova puntata è dichiarata registrata da questa policy.

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

Le prove remote e il completamento del ciclo con risultati ufficiali restano
da attestare. Test locali superati non equivalgono a un sistema distribuito.

## Controlli locali completati

- Backend Linux Node 20, senza rete o credenziali: 1.015 test superati,
  zero errori, un test opzionale di training Python CatBoost escluso.
- Frontend: 213 test superati, esecuzione seriale; typecheck/lint backend e
  build Docker backend/frontend superati.
- Avvio Compose isolato: frontend e healthcheck HTTP 200; database locale,
  chiavi provider assenti e nuova registrazione disabilitata.
- Review indipendente completata sulla quarta copia immutabile compilata;
  file matematici e baseline Research A80 invariati. Scansione secret superata.
