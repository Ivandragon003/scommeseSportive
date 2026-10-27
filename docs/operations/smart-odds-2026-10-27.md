# Quote automatiche e budget condiviso — 27 ottobre 2026

Intervento locale, senza commit, push, deploy, acquisti o modifiche remote.
Non cambia probabilità, modelli, mercati validati o artefatti del confronto A/C.
Tutte le puntate restano virtuali. Questo report distingue comportamento del
codice, simulazione offline e verifiche ancora necessarie sull'infrastruttura.

## A. Origine del consumo e problemi individuati

La cifra precedente **855** proveniva da 135 gruppi lega/kickoff × tre crediti
T−15, più cinque leghe × tre mercati × trenta notti: 405 + 450. Era un esempio
di capacità, non una misura dell'account, un numero di richieste HTTP o un
consuntivo completo. Escludeva retry, accessi UI, aggiornamenti kickoff e mercati
evento aggiuntivi. Ottobre ha 31 giorni; non va trasformata in un addebito reale.

Il call graph conteneva richieste potenzialmente ripetute fra UI, raccolte
notturne e analisi: cache solo in memoria e contatori per istanza non bastavano
per processi distinti, riavvii o runner GitHub. Anche recuperare h2h e scores
soltanto per ottenere il kickoff può consumare crediti evitabili. Un chiamante
non coordinato o una chiave usata da un client esterno può ancora influire sul
residuo dello stesso account: il backend non controlla quel traffico esterno.

Non è stata interrogata la chiave per misurare il consumo durante questo audit.
Prima di header reali `used`, `remaining` e timestamp osservato restano `null`;
500 è il piano pubblicizzato e il limite locale predefinito, non il residuo
certificato. È un problema distinto dalla disponibilità effettiva delle quote.

## B. Modifiche implementate

Il monolite e libSQL/Turso restano gli stessi. Il nuovo
[SmartOddsRequestStore](../../backend/src/services/odds-provider/SmartOddsRequestStore.ts),
esposto da `DatabaseService.oddsRequests`, coordina tutti i metodi HTTP di
[OddsApiService](../../backend/src/services/OddsApiService.ts). Senza il gestore
persistente il trasporto rifiuta la chiamata prima della rete. La migrazione
[018_smart_odds.sql](../../backend/migrations/018_smart_odds.sql) è additiva.

- Cache persistente per provider, account logico, endpoint e parametri
  normalizzati; nessuna chiave segreta nell'identificativo o nei log. La
  risposta mantiene `capturedAt` e timestamp originario del mercato.
- Lease e prenotazione atomica dei crediti deduplicano richieste equivalenti
  concorrenti. La transazione DB termina prima dell'HTTP. Un risultato tardivo
  non sovrascrive la cache dopo la perdita della lease.
- Il costo preventivo usa mercati e regioni, oppure blocchi di dieci bookmaker.
  Gli header riconciliano il costo effettivo. Timeout/crash senza prova del
  costo conservano un addebito prudenziale, distinto dalle misure certe:
  non si presume che il provider non abbia elaborato una richiesta interrotta.
- Budget di pianificazione 500 crediti/mese, riserva 50 protetta per le letture
  informative. T−15 può usare la riserva; non viene aumentato il limite mensile.
  Header fuori ordine non ricaricano il budget. Il mese UTC è locale, non il
  fuso confermato del provider; il nuovo mese richiede una verifica gratuita
  del reset prima di ammettere richieste a consumo. La verifica considera anche
  quota piena osservata con usato zero; richieste a cavallo del mese conservano
  una passività prudenziale separata, senza sparire al cambio di calendario.
- Nightly: `RUN_ODDS_SYNC=false` nel workflow e come default dello script;
  sincronizzazione dati, risultati e liquidazione restano. Non registra nuove
  puntate e non avvia il processo T−15 temporaneo del runner.
- UI e analisi informative: `ODDS_INFORMATIONAL_NETWORK_ENABLED=false` per
  default, quindi letture da cache; cache informativa fino a trenta minuti.
  I mercati evento extra richiedono anche `ODDS_EXTRA_EVENT_NETWORK_ENABLED=true`.
  Una semplice apertura della dashboard non autorizza richieste a consumo.
- Calendario: `/sports/{sport}/events` a zero crediti, senza fallback a h2h o
  scores a consumo se gli eventi non sono disponibili. La sua cache di trenta
  minuti non eredita il limite di cinque minuti riservato alle quote essenziali.
- T−15: stessa raccolta essenziale `h2h,totals,spreads`, una regione, per A/C
  e partite simultanee della stessa lega. Cache al massimo cinque minuti,
  senza prolungare la freschezza del prezzo del bookmaker.

`ODDS_API_T15_KEY` permette di scegliere esplicitamente una chiave già
autorizzata per T−15; se appartiene alla stessa sottoscrizione deve conservare
lo stesso `ODDS_API_ACCOUNT_SCOPE`. Una chiave separata non prova l'esistenza
di crediti aggiuntivi e non viene creata automaticamente.

`GET /api/research/odds-status` è una lettura dello stato persistito e della
proiezione locale: distingue piano, prenotazioni, costo osservato, costo incerto,
cache e blocchi. Non sonda automaticamente i provider. Il dettaglio per mercato
è per insieme richiesto: un costo congiunto non viene arbitrariamente spartito
fra le singole chiavi. Le informazioni di provider configurato non significano
account o copertura già verificati. La UI mantiene espliciti i dati sconosciuti.

## C. Provider, Eurobet e mercati

Il provider integrato rimane **The Odds API**, dominio `the-odds-api.com` e host
`api.the-odds-api.com/v4`. L'[audit documentale](odds-provider-audit-2026-10-27.md)
riporta fonti ufficiali, costi e termini correnti; non sono stati trasferiti
secrets o creati account. Servizi dai nomi simili non sono intercambiabili.

| Fonte | Evidenza e limite | Decisione |
|---|---|---|
| The Odds API Starter | 500 crediti/mese pubblicizzati; storico paid; eventi gratuiti; quote per mercati/regioni | Conservato, con budget e controlli; copertura reale da payload |
| Eurobet via provider attuale | Assente nel catalogo ufficiale letto; snapshot legacy non provano supporto attuale | Preferenza solo quando un prezzo Eurobet reale è ricevuto; nessuna garanzia gratuita |
| odds-api.io | Nuove chiavi Free sospese a tempo indeterminato; Eurobet IT pubblicizzato, senza accesso/diritti verificati | Nessun adattatore attivato |
| TheRundown Free | Quote prepartita ritardate di cinque minuti; conservazione massima 24 ore e consenso scritto per validare modelli | Non pronto per freschezza e archivio immutabile A/C |
| API-Football Free | 100 richieste/giorno pubblicizzate, aggiornamento quote prepartita ogni tre ore; accesso stagione 2026/27 non verificato | Non dimostra freschezza entro cinque minuti |
| odds-api.net | Starter a pagamento | Escluso come dipendenza gratuita |

Le cinque leghe restano configurabili: Serie A, Premier League, La Liga,
Bundesliga e Ligue 1. Il feed essenziale richiede **1X2, totali gol e handicap**
(`h2h`, `totals`, `spreads`). Non include automaticamente DC/DNB, BTTS, totali
squadra o mercati specialistici. Il codice di questi mercati è preservato, ma
servono quote reali del mercato e validazione prima delle puntate. Non derivare
una quota bookmaker mancante da altre quote o dal modello.

La scelta fra bookmaker reali resta nel coordinatore esistente, con nome e
provenienza corretti. Nessun secondo provider gratuito già utilizzabile è stato
dimostrato e configurato: il fallback automatico verificato ha capacità zero.

## D. Sostenibilità entro 500 crediti

La [simulazione ripetibile](../performance/odds-demand-2026-10-27.md), con
[dati JSON](../performance/odds-demand-2026-10-27.json), usa calendario locale,
una regione e tre mercati. Include una richiesta retry per il 10% dei gruppi
arrotondato in alto; è un margine dichiarato, non una frequenza di guasto misurata.
I mesi sono quelli della decisione T−15 in UTC, non necessariamente del kickoff.

| Scenario sul calendario ottobre 2026 | Crediti richiesti | HTTP richiesti | Interpretazione |
|---|---:|---:|---|
| Vecchia raccolta notturna, 31 giorni, retry inclusi | 912 | 304 | Scenario controfattuale; senza UI o extra |
| Nuovi default, nightly quote OFF e UI cache-only | 447 | 149 | 189 fixture/135 gruppi, copertura condizionata al calendario e ai prezzi |
| Nuovi default nel mese storico più oneroso, ottobre 2022 | 654 | — | 261 fixture/198 gruppi: supera il limite anche dopo l'ottimizzazione |

Nel primo scenario il gestore non autorizza l'intera domanda. Nel secondo la
domanda stimata lascia 53 crediti su 500, o tre oltre la riserva ordinaria di
50. Non è margine misurato dell'account: altri client, retry ulteriori, dati
obsoleti, quote mancanti e mercati extra possono peggiorare la copertura.
Nel mese da 654 crediti la simulazione ammette 181/261 fixture preservando
50 crediti, oppure 202/261 quando T−15 può usare la riserva. Gennaio 2026
richiede 567 crediti: anche i mesi invernali possono eccedere il gratuito.

Non esiste quindi un numero di campionati con copertura integrale garantita
dal solo limite 500. Sono supportate cinque leghe, ma la capacità dipende da
gruppi di kickoff, mercati, quota dell'account e disponibilità effettiva. Gli
orari futuri non confermati possono raggruppare artificialmente molte fixture;
una proiezione favorevole non è prova del mese futuro. L'endpoint di stato
espone la proiezione come incompleta e separata dal consumo osservato.

Non si restringono in silenzio copertura, mercati o freschezza per rientrare nel
limite, né si attiva un piano a pagamento. Se la domanda eccede la capacità,
il sistema salta e registra il motivo. Una riduzione programmata della copertura
richiederebbe una scelta esplicita, basata su mercati validati e calendario.

## E. Percorso T−15 e stato locale/remoto

Target kickoff − 15 minuti, polling 15 secondi e tolleranza massima +60 secondi
restano invariati. L'età sia dell'acquisizione sia del prezzo originario deve
essere al massimo cinque minuti. Cache informativa vecchia, assenza di quota,
budget insufficiente o reset non confermato non producono una quota sostitutiva.
Il job conserva il motivo della decisione saltata; errori temporanei possono
essere ritentati soltanto nella stessa finestra. Non si recupera con una puntata
retroattiva. Vincoli di unicità e commit atomico restano distinti dalla lease
HTTP: nessun retry può creare due puntate nello stesso portafoglio/partita.

Locale: route legacy HTTP 410, niente nuove puntate notturne, quote notturne
OFF, UI network OFF e scheduler T−15 OFF. Modelli e mercati restano sottoposti
ai gate precedenti; le ottimizzazioni quote non li promuovono.

Remoto: l'audit GitHub in sola lettura ha ancora trovato la nightly attiva,
`AUTO_BET_ENABLED=true`, `AUTO_BET_DRY_RUN=false`, `RUN_ODDS_SYNC=true` e la
chiamata legacy. Nessun cambiamento locale la disattiva. Il
[piano operativo](t15-readiness-2026-10-27.md#patch-minima-futura-della-nightly-due-file)
descrive la patch minima dei due file workflow/script e l'alternativa di stop
temporaneo, entrambe future e da autorizzare. Il successivo backend distribuito
deve ritirare la route: la sola patch nightly non neutralizza altri chiamanti.

Non esiste una VM disponibile e nessun nuovo processo remoto T−15 è distribuito.
Il percorso con PC/smartphone spenti resta un requisito non soddisfatto. Il
telefonino consulta lo stato, non deve sostenere timer o chiamate decisionali.

## F. Deployment gratuito e passi necessari

La scelta rimane un backend Node persistente su VM gratuita, con lo stesso
Turso e inferenza JSON. La [guida al deploy](../oracle-cloud-free-deploy.md)
descrive configurazione, backup, verifica e rollback. Oracle Always Free può
ospitarlo se risorse e account sono disponibili: la
[documentazione](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)
indica fino a 2 OCPU/12 GB A1 complessivi, capacità regionale variabile e possibile
recupero di VM inattive. Non è una VM ottenuta né una garanzia di servizio.

[GitHub schedule](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule)
può ritardare o perdere job: resta per manutenzione e training. I
[limiti Workers Free](https://developers.cloudflare.com/workers/platform/limits/)
di 128 MB e 10 ms CPU non permettono di considerarlo un trasferimento diretto
del monolite. Nessun secondo scheduler o infrastruttura complessa è introdotto.

Prima dell'attivazione servono autorizzazione alla pubblicazione e modifica
remota, disponibilità di una VM gratuita e accesso amministrativo, backup e
restore remoto provati, applicazione delle migrazioni, rete HTTPS e orologio
sincronizzato. Occorre verificare crediti reali, rollover, cache/concorrenza,
puntualità entro la finestra e liquidazione su quel runtime. T−15 resta OFF fino
ai gate. Watchdog e canale notifiche esterno richiedono configurazione e consenso:
la sola notifica in-app non raggiunge un utente con app chiusa né rileva da sola
un host completamente fermo. Nessun account o messaggio è stato creato/inviato.

## G. File, verifiche e documentazione

I punti principali sono gestore persistente, migrazione 018, trasporto quote,
provider coordinator/runtime, route informative e stato, calendario gratuito,
workflow/script nightly, proiezione/simulatore e sezione quote della dashboard.

| File | Responsabilità |
|---|---|
| [SmartOddsRequestStore](../../backend/src/services/odds-provider/SmartOddsRequestStore.ts), [migrazione 018](../../backend/migrations/018_smart_odds.sql) | Prenotazioni, cache, lease, contabilità dei crediti e audit persistenti |
| [OddsApiService](../../backend/src/services/OddsApiService.ts), [OddsApiProvider](../../backend/src/services/odds-provider/OddsApiProvider.ts) | Trasporto unico e permessi per richieste informative/extra |
| [providerRuntimeConfig](../../backend/src/services/odds-provider/providerRuntimeConfig.ts), [kickoff sync](../../backend/src/services/OddsApiKickoffSyncService.ts) | Account logico, ruoli e calendario senza richieste di prezzi |
| [ResearchRuntime](../../backend/src/research/ResearchRuntime.ts), [route](../../backend/src/api/routes.ts) | Raccolta T−15 essenziale, cache-only UI e stato in sola lettura |
| [OddsDemandSimulation](../../backend/src/services/odds-provider/OddsDemandSimulation.ts), [CLI](../../backend/scripts/simulate-odds-demand.js) | Domanda offline e proiezione incompleta del calendario |
| [ResearchOddsPanel](../../frontend/src/features/research/ResearchOddsPanel.tsx) | Crediti osservati/pianificati, costi incerti, cache e motivi di blocco |
| [workflow nightly](../../.github/workflows/nightly-sync.yml), [script](../../scripts/ci/nightly-sync.sh) | Quote notturne OFF, manutenzione preservata |
| [.gitattributes](../../.gitattributes) | Terminatori LF degli script shell anche copiando il progetto da Windows a Linux |

La documentazione aggiornata comprende [README](../../README.md),
[architettura](../SYSTEM-DESIGN.md), [piattaforma](../research-platform.md),
[nightly](../github-actions-nightly-sync.md), deploy e piano operativo collegati.

Sono stati verificati cache senza refresh artificiale del tempo,
deduplicazione fra processi, prenotazioni atomiche, costi sconosciuti dopo crash,
header fuori ordine, reset mensile prudenziale, scope condiviso, blocco prima
della rete, UI senza consumo, calendario senza fallback a consumo, quote T−15
obsolete rifiutate e immutabilità degli artefatti A/C. L'end-to-end usa il
gestore e il servizio reali con il trasporto HTTP intercettato: A/C condividono
una prenotazione da tre crediti e la liquidazione aggiorna i ledger separati.
Quote e risultati di quel test sono fixture tecniche: non provano copertura,
consumo della chiave o qualità predittiva. La simulazione non usa una chiave.

| Verifica finale locale | Risultato |
|---|---|
| Backend Windows, `npm test` | 723/723 superati, zero saltati; 105 file sorgente di test |
| Backend Linux Node 20.20.2 nel container | 723 test: 722 superati, zero falliti, uno saltato perché CatBoost non è installato nel container web |
| Training CatBoost della fixture | Superato nella suite Windows; il container web usa inferenza JSON e non richiede CatBoost/Python di training |
| Test Python | 13/13 superati |
| Frontend | 27 suite, 174 test superati; typecheck, lint e build riusciti |
| Backend e script | Typecheck, lint e controlli script riusciti; script nightly LF e test di separazione eseguiti anche su Linux |
| Docker e API locali | Health, overview e odds-status HTTP 200; migrazione 018 presente |
| Stato senza richieste provider | Lettura odds-status non cambia richieste/eventi: entrambi zero; nessun consumo osservato, fallback `UNAVAILABLE` |
| Backup e restore locali | `VACUUM` coerente, copia ripristinata con integrità OK: tre modelli, 149 metadati, zero puntate, ledger ricostruiti a 100.000 centesimi ciascuno |
| Browser desktop/mobile | Larghezze 1024/390, nessun overflow, zero errori o warning console; una GET locale di stato alla selezione, nessun POST o probe provider |
| Artefatti e segreti | Hash dei report originali e dataset invariati; versioni A/C invariate; scansione Gitleaks di 4,60 MB senza rilevamenti |

Nelle esecuzioni Windows con molti file di test paralleli sono stati osservati
crash nativi a fine processo (`3221225477`), anche dopo tutte le asserzioni
superate. La causa non è stata dimostrata. Il runner ora usa quattro file
paralleli per default su Windows, rispettando un override esplicito: il comando
completo così configurato è terminato correttamente senza saltare test. I test
di richieste concorrenti restano attivi al loro interno. Questo non certifica
stabilità a qualsiasi parallelismo. La suite Linux distingue esplicitamente
il solo training saltato dalla prova di training riuscita su Windows.

Evidenze visive locali: [desktop](../../output/playwright/smart-odds-desktop.png)
e [mobile](../../output/playwright/smart-odds-mobile.png). Il bundle verificato
è `main.95146238`; le schermate mostrano copertura futura sconosciuta e quota
non osservata, senza inventare percentuali o provider disponibili. Il backup
provato è locale: non è una verifica di backup Turso remoto né di puntualità
cloud a T−15. Lo scheduler resta disabilitato e i mercati sperimentali.

## H. Risposte operative

| Domanda | Risposta verificabile |
|---|---|
| Si rimane entro 500? | Il gestore limita le richieste autorizzate; non garantisce tutta la domanda. Ottobre simulato 447, stress storico 654. Residuo dell'account non misurato nell'audit. |
| Quanti campionati Top5? | Cinque configurati. Nessuna promessa di copertura mensile integrale; fixture saltate quando manca budget o quota valida. |
| Quali mercati? | Feed essenziale `h2h`, `totals`, `spreads`; altri preservati ma fuori stima e soggetti a quote/opt-in/validazione. |
| Eurobet gratuitamente? | Non dimostrato. Preferenza soltanto per Eurobet realmente presente nel payload. |
| Bookmaker alternativi? | Quelli reali restituiti dal provider, con il proprio nome. Nessun secondo provider gratuito operativo dimostrato. |
| Quote fresche entro cinque minuti? | Requisito applicato a acquisizione e prezzo provider; assenza della prova significa astensione, non garanzia di disponibilità. |
| Cosa blocca le nuove puntate? | Budget/reset/freschezza e dati, stato mercato/configurazione/modello, orario, unicità e limiti portafoglio; scheduler nuovo resta OFF. |
| È pronto per la pubblicazione operativa? | No attivazione remota verificata. Mancano autorizzazione, VM, correzione nightly remota, crediti/copertura misurati e collaudo T−15 su host. |
| Quali autorizzazioni servono? | Pubblicazione/commit/push e modifiche remote, accesso VM gratuita e servizi già previsti; eventuale canale esterno. Nessun abbonamento paid autorizzato o richiesto per completare le parti locali. |

Il risultato è una riduzione verificabile della domanda e un controllo persistente
del consumo, non una dimostrazione di copertura gratuita totale o di affidabilità
remota. I report A/C precedenti e la conclusione scientifica restano invariati.
