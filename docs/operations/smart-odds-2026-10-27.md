# Quote automatiche e budget condiviso

Documento iniziale del 27 ottobre 2026, aggiornato il 29 ottobre per
**Nightly Pre-Match Virtual Betting**. La
[guida canonica](nightly-pre-match-2026-10-29.md) sostituisce il requisito
T−15/worker sempre acceso. I numeri delle simulazioni e i test del 27 ottobre
restano storici nelle sezioni A, D e G: non sono riscritti per dimostrare il
funzionamento o la sostenibilità del nuovo job notturno.

Il percorso è pubblicato e attivato: backend `63d7cb96` LIVE sul personale,
cutover effettivo, flag nightly `true` e workflow attivo. Primo run manuale
`40944747548` SUCCESS, job finito alle 20:04:35 UTC senza nuove puntate.
Il ciclo completo con evento reale resta pendente.
C resta Challenger, A riferimento; due portafogli esistenti e nessuna modalità
Shadow Betting aggiuntiva. Probabilità, artifact e benchmark non vengono
ottimizzati da questa modifica di orchestrazione.

## Proiezione della nuova nightly

[`forecastRemainingNightlyOddsDemand`](../../backend/src/services/odds-provider/OddsDemandSimulation.ts)
raggruppa le partite per lega e finestra 03:00 Europe/Rome → prossima 03:00,
gestisce DST e mese contabile UTC ed esclude le leghe senza incontri nella
finestra. Una richiesta essenziale per lega/finestra è condivisa da A/C;
`h2h`, `totals`, `spreads` e una regione comportano tre crediti stimati.
Il calendario recuperato per la proiezione non dimostra disponibilità dei prezzi.

Esempio teorico massimo di base, non consuntivo: cinque leghe ogni notte per
31 giorni sono 155 richieste e **465 crediti**. Un margine del 10% arrotondato
in alto aggiunge 16 richieste/48 crediti: **513**, oltre 500. Il gestore non
può soddisfare tutta questa domanda e deve registrare esclusioni. Notti senza
partite possono ridurla; quote mancanti, refresh, retry e altri client possono
peggiorare il risultato. Non è garantita copertura integrale Top5.

La dashboard distingue lo scenario ordinario da 450 crediti, con riserva 50,
da quello essenziale entro 500 che può usarla. La previsione residua usa il
budget prudenziale effettivamente disponibile; non sostituisce gli header del
provider o un piano contrattuale. I 447/654 crediti della sezione D si riferiscono
al calendario e ai gruppi del vecchio T−15, non alla strategia nightly.

La nuova proiezione ha superato 21 test mirati locali, senza chiamate provider;
non è una misura del consumo remoto dopo l'attivazione. La riduzione reale
mensile richiede osservazioni del job pubblicato.

## A. Origine del consumo nell’audit del 27 ottobre

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

## B. Meccanismi persistenti conservati

Il monolite e libSQL/Turso restano gli stessi.
[SmartOddsRequestStore](../../backend/src/services/odds-provider/SmartOddsRequestStore.ts),
[trasporto](../../backend/src/services/OddsApiService.ts) e migrazione additiva
[018](../../backend/migrations/018_smart_odds.sql) gestiscono:

- cache per provider, scope account, endpoint e parametri normalizzati, senza
  chiavi nei nomi/log e senza modificare il timestamp originario del prezzo;
- prenotazione atomica del costo, lease e deduplicazione fra processi,
  con transazione chiusa prima dell'HTTP;
- riconciliazione dagli header; in caso di costo non misurabile resta una
  passività prudenziale, senza presumere una chiamata gratuita;
- limite 500 e riserva informativa 50; le decisioni nightly essenziali possono
  usare la riserva entro il limite complessivo, senza aumentarlo;
- mese UTC come convenzione di pianificazione, non reset contrattuale
  certificato; il reset richiede verifica, non ricarica presunta;
- UI cache-only (`ODDS_INFORMATIONAL_NETWORK_ENABLED=false`) e raccolta
  informativa generale `RUN_ODDS_SYNC=false`, distinte dal feed essenziale
  del job A/C quando esplicitamente abilitato;
- calendario tramite eventi gratuiti, senza fallback a prezzi/scores a consumo;
- snapshot reali comuni per A/C e quote entro 300 secondi alla decisione
  notturna, considerando sia acquisizione sia aggiornamento del bookmaker.

Una cache informativa di trenta minuti non rende un prezzo valido per le
registrazioni. Non occorre un aggiornamento al kickoff o a T−15. Non si
abbassano freschezza e qualità per produrre una puntata; quota mancante o
fuori budget significa astensione. Nessuna rotazione di account o chiavi.

`GET /api/research/odds-status` legge contabilità e proiezioni senza sondare i
provider. `plannedForecast` usa il contratto `NIGHTLY` e
`competitionNightlyGroups`: la UI mostra gruppi lega/finestra e gli scenari
ordinario/essenziale. Zero gruppi del calendario è uno zero stimato, non una
misura del consumo o del residuo provider; campi mancanti restano sconosciuti.
Configurato, osservato, costo certo/incerto e disponibilità reale
restano distinti. La proiezione nightly non assegna una disponibilità fittizia
alle partite ancora senza quota. Il vecchio nome di chiave `ODDS_API_T15_KEY`,
se conservato per compatibilità, non crea un account o crediti aggiuntivi.

## C. Provider: riscontri documentali del 27 ottobre

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
servono quote reali del mercato e idoneità tecnica; la validazione statistica
resta separata per le nuove simulazioni virtuali. Non derivare
una quota bookmaker mancante da altre quote o dal modello.

La scelta fra bookmaker reali resta nel coordinatore esistente, con nome e
provenienza corretti. Nessun secondo provider gratuito già utilizzabile è stato
dimostrato e configurato: il fallback automatico verificato ha capacità zero.

## D. Simulazione T−15 storica del 27 ottobre, immutata

I numeri seguenti appartengono al vecchio protocollo T−15. Non sono la
proiezione della nuova nightly e non diventano un consumo misurato dell’account.

La [simulazione ripetibile](../performance/odds-demand-2026-10-27.md), con
[dati JSON](../performance/odds-demand-2026-10-27.json), usa calendario locale,
una regione e tre mercati. Include una richiesta retry per il 10% dei gruppi
arrotondato in alto; è un margine dichiarato, non una frequenza di guasto misurata.
I mesi sono quelli della decisione T−15 in UTC, non necessariamente del kickoff.

| Scenario sul calendario ottobre 2026 | Crediti richiesti | HTTP richiesti | Interpretazione |
|---|---:|---:|---|
| Vecchia raccolta notturna, 31 giorni, retry inclusi | 912 | 304 | Scenario controfattuale; senza UI o extra |
| Default del 27/10, quote nightly OFF e T−15 | 447 | 149 | 189 fixture/135 gruppi, copertura condizionata al calendario e ai prezzi |
| Default del 27/10 nel mese storico più oneroso, ottobre 2022 | 654 | — | 261 fixture/198 gruppi: supera il limite anche dopo l'ottimizzazione |

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

## E. Dalla quota alla decisione notturna

Il job finito GitHub, non il worker Hostless, carica A/C e conserva un unico
snapshot per il confronto. Prezzo reale, bookmaker, mercato/linea, timestamp
originari e distanza dal kickoff sono tracciati. Il prezzo ha tipo `prematch`;
i vecchi record `t15` restano tali e non vengono rietichettati. Il commit
ricontrolla che la partita non sia iniziata e che capitale e vincoli univoci
consentano la registrazione. Retry e riavvii non duplicano giocate o stake.

`EXPERIMENTAL` può essere ammesso alla simulazione con idoneità tecnica:
probabilità coerenti, dati essenziali, prezzo autentico e liquidazione testata.
Non è una promozione statistica e non sblocca corner/falli senza condizioni
minime. Ogni modello può astenersi; non si forza una giocata per partita.

I due portafogli `shadow_A`/`shadow_C` sono riutilizzati, senza reset o terzo
portafoglio. Stake 1%, esposizione aperta 5%, una puntata per partita/modello.
La dashboard confronta profitto, ROI, esiti e drawdown per periodo senza
confonderli con log loss, Brier e calibrazione del benchmark.

L'[assemblatore prospettico](nightly-model-runtime-2026-10-29.md) conserva
osservazioni reali anche in astensione, prima dell'esito e senza ledger. Il
registro iniziale non ha campioni idonei: minimo 50 per mercato/fascia e
Hoeffding restano invariati; il registro attuale inizialmente non ammette BET.
Risultati e payout sono append-only al clock effettivo; l'80/20 nominale per
hash esclude `FUTURE_TEST` dai residui prudenziali. Non crea calibratori,
refit o promozioni. Anche raccogliere osservazioni senza puntate consuma,
quando necessario, quote vere entro lo stesso budget.

## F. Stato locale, remoto e rilascio

La nuova nightly è pubblicata e attiva, sul database personale. Backend
`63d7cb96` LIVE dopo Resume e deploy del nuovo ambiente; frontend `afda73be`.
Health HTTP 200, route legacy POST HTTP 410, login/sessione e dashboard 30 giorni sono verificati:
A/C 1.000 euro ciascuno, zero puntate e impegnato. Primo run `40944747548`
creato alle 19:57:46 UTC, SUCCESS; job concluso alle 20:04:35 UTC. Il riepilogo
A/C registra zero puntate; l’audit RO 20:10:52 UTC conferma che `missedMatches=2`
conta due partite già iniziate ed escluse, senza decisioni retroattive. Training settimanale e Odds Smoke
manuale riattivati; Registry writes `false`. Nessun auto-betting legacy riattivato.

Si mantengono Hostless, Turso e GitHub Actions: nessuna VM alternativa o nuovo
servizio a pagamento è necessario. Il cron Hostless del vecchio worker è
`PAUSED`; richiesta di pausa standalone accettata, ma stato finale non ancora
confermato. Il vecchio timeout del worker non è un requisito da risolvere.

La verifica quote del 29 ottobre precedente al nuovo mandato ha osservato
cinque richieste reali, 15 crediti, residuo 220 → 205, Eurobet assente nelle
cinque leghe. È una prova locale Linux verso provider/Turso, non l'esecuzione
della nuova nightly su Hostless/GitHub o una garanzia per il mese futuro.
I bookmaker mantengono il proprio nome. Nessun provider alternativo gratuito
viene dichiarato disponibile senza evidenza.

Il target personale è il canonico dopo l'adozione autorizzata della copia
15:17 UTC / 16:17 Roma. Il limite dei delta successivi non verificabili sulla
sorgente bloccata resta accettato, non recuperato. 020/021 applicate, export
finale 18:58 UTC e parità 19:00 UTC PASS,57 tabelle/133 oggetti di schema e
storico 52 tabelle preservato. Secret GitHub RW/RO, ambiente Hostless e
configurazione locale produzione puntano al personale. L'originale non è
eliminato: serve la gestione del proprietario, fuori dalla CLI personale.

Warmup, probe reale C solo in RAM e nuovo smoke contabile RO `40945351072`
sono riusciti; nessuno sostituisce il primo ciclo reale della nuova nightly.
Il monitor `4dff28f4` è pubblicato: controllo DB periodico RO e attese delle
03:00 sono entrambi attivi. Audit finanziario RO 20:07 UTC PASS; quattro
fingerprint invariati, A/C 1.000 euro ciascuno senza impegnato o nuove giocate.
Il watchdog con attese attive `40946558140` è SUCCESS, tutti i passi GitHub e DB RO
completati in 26 secondi. Contabilità, quota, errori e stalli recenti oltre
quattro ore non dipendono dall'aspettativa programmata.
La nightly attiva prepara il riepilogo solo dopo reconcile, con `publishAfter`
09:00 Europe/Rome; il GET filtra senza scrivere o inviare all'esterno. Il job
è SUCCESS, ma la generazione del riepilogo richiede una verifica della riga.
Non c’erano eventi eleggibili nella finestra restante, senza puntate retroattive;
non è ancora il ciclo completo quote/decisione/risultato/liquidazione.
L'[audit Turso/CPU](turso-cpu-audit-2026-10-29.md) distingue risparmi locali da
throttling e consumi effettivamente misurati sul provider.

<a id="g-file-verifiche-e-documentazione"></a>

## G. Verifiche storiche del 27 ottobre, conservate

Questa sezione conserva i file e gli esiti del report originario. Non è il
gate della nuova nightly del 29 ottobre e non certifica lo stato remoto attuale.

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

## H. Risposte operative attuali

| Domanda | Risposta verificabile |
| --- | --- |
| Si rimane entro 500? | Il gestore impone il limite; 465 crediti teorici base o 513 con retry non garantiscono tutta la domanda. Esclusioni tracciate quando necessario. |
| Quali leghe/mercati? | Cinque leghe configurate, feed essenziale h2h/totals/spreads; nessuna promessa di quota presente per ogni partita. |
| Eurobet? | Priorità solo per una quota autentica realmente ricevuta; assente nella prova del 29 ottobre. Nessuna quota rietichettata. |
| Quando deve essere fresca la quota? | Alla decisione notturna: default 300 s su acquisizione e aggiornamento originario, non cinque minuti prima del calcio d'inizio. |
| Serve un worker T−15? | No. GitHub esegue il job finito; browser e smartphone sono client. |
| Le nuove registrazioni sono attive? | Sì, flag `true` e workflow attivo; primo job manuale SUCCESS, zero nuove puntate; ciclo reale con liquidazione ancora pendente. |
| I vecchi risultati cambiano? | No: benchmark, registrazioni e quote storiche conservano il proprio protocollo. |
| C viene promosso perché guadagna? | No, il confronto economico non sostituisce la validazione probabilistica; C resta Challenger. |
| Costi aggiuntivi? | Nessun nuovo piano o servizio a pagamento attivato; proiezioni e capacità gratuite non sono un consuntivo futuro. |

I controlli locali e le stime non provano copertura gratuita totale,
redditività o affidabilità del nuovo ciclo remoto. Consultare la guida
canonica per gli esiti effettivamente completati.
