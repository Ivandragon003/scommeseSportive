# FootPredictor su Hostless: web e nightly GitHub

Procedura aggiornata al 29 ottobre 2026 per **Nightly Pre-Match Virtual Betting**.
La [guida canonica](nightly-pre-match-2026-10-29.md) sostituisce il requisito
precedente di worker T−15 persistente. Si mantengono Hostless, Turso, GitHub
Actions e i servizi web esistenti. Il blocco dei deployment del vecchio worker
non è più un requisito da risolvere per le nuove puntate virtuali.

## Stato effettivo e confini

**Cutover effettivo; nightly attiva e primo run SUCCESS.** Il proprietario ha
eseguito Resume e il nuovo ambiente è stato salvato e distribuito. Backend
`63d7cb96` LIVE, deployment `6ae39db2025871fe6d073d62`, sul Turso personale;
frontend Site `afda73be` resta distribuito. Health HTTP 200, route legacy POST HTTP 410,
login/sessione e dashboard 30 giorni sono verificati dal browser. A e C
mantengono 1.000 euro ciascuno, zero puntate e zero capitale impegnato.

Il workflow nightly è attivo, flag `true`. Il run `40944747548`, creato alle
19:57:46 UTC, è SUCCESS; job concluso alle 20:04:35 UTC. Zero analizzati,
nuove puntate, skip ed errori nel riepilogo A/C; `missedMatches=2` indica due
partite già iniziate, correttamente escluse secondo l’audit RO 20:10:52 UTC. Il ciclo reale completo resta
pendente. Training settimanale e Odds Smoke manuale sono riattivati;
Registry writes resta `false`.

L'adozione autorizzata della copia del dump 15:17 UTC / 16:17 Roma è il cutover
eseguito: nessun recupero dei delta sorgente successivi non verificabili.
L'originale resta non eliminato, perché occorre la gestione del proprietario;
la CLI disponibile opera soltanto sul personale. La causa del blocco della
sorgente non è stata attribuita con certezza a quota o fatturazione.

Le impostazioni dell'app sono accessibili, auto-deploy OFF, repository
`Ivandragon003/scommeseSportive`, branch `main`, Docker con contesto e working
directory `backend`. La route automatica legacy resta HTTP 410 e non è usata dal
job A/C; nessun `AUTO_BET_*` è riattivato. Le risorse restano 0,1 vCPU/256 MiB.

Il vecchio cron `footpredictor-watchdog` è `PAUSED`, verificato nel pannello.
La richiesta di pausa dello standalone è stata accettata dall'API, ma lo stato
`Sleeping`/`scaledDown=false` non dimostra la pausa completata. Non dichiarare
il servizio arrestato da questo solo riscontro. Non creare altri worker;
nessun servizio, database o storico è stato eliminato.
I [precedenti riscontri Hostless](production-status-2026-10-29.md) e la
[scheda del vecchio blocco](hostless-blocker-2026-10-29.md) restano snapshot
storici, non la nuova procedura operativa.

## Servizi da mantenere

| Componente | Ruolo nel nuovo flusso |
| --- | --- |
| Frontend Hostless Site esistente | React, dashboard e accesso privato |
| Backend Hostless esistente | Express/Node, sessioni, API e consultazione delle previsioni |
| Runner GitHub Actions | Import, calibrazione, job finito A/C e liquidazioni |
| Turso personale | Unico database canonico per tutti i processi dopo il cutover |
| Worker T−15 e relativo watchdog | Non richiesti; dismissione controllata senza cancellare storico |

Non occorre un PC o telefono acceso per il flusso previsto. Questo descrive
l'architettura, non un ciclo remoto nuovo già osservato. Un healthcheck 200
non certifica import, quote, decisioni, liquidazioni o corretta contabilità.

Configurazione web già identificata nel progetto esistente: backend Docker,
contesto e directory `backend/`, Dockerfile `Dockerfile`, un'istanza 0,1 vCPU e
256 MiB; frontend `frontend/`, `npm ci`, `npm run build`, output `build`.
Questi sono riscontri dell'app, non una promessa di capacità gratuita residua.
Auto-deploy disabilitato per rilascio controllato. Non aumentare CPU/RAM,
aggiungere carte o cambiare piano per introdurre la nuova nightly.

## Ambiente e collegamenti

Conservare secret funzionanti nei pannelli autorizzati; non copiarli in Git,
frontend, log o chat. Le variabili React sono pubbliche nella build.

| Configurazione | Valore / verifica |
| --- | --- |
| `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN` | Stesso DB per web, nightly, calibrazione, training e manutenzione |
| `NIGHTLY_ORCHESTRATOR` | `github_actions`; gli scheduler interni web non duplicano il job |
| `RESEARCH_NIGHTLY_ENABLED` | Default codice `false`; configurazione remota corrente `true` |
| `RESEARCH_T15_SCHEDULER_ENABLED` | `false`, mai concorrente con la nightly |
| `ODDS_API_KEY` | Solo backend/runner, provider reale autorizzato |
| `ODDS_API_MONTHLY_CREDITS`, `ODDS_API_RESERVE_CREDITS` | 500 e 50, pianificazione interna distinta dal residuo provider |
| `ODDS_INFORMATIONAL_NETWORK_ENABLED`, `RUN_ODDS_SYNC` | `false`, letture informative su cache |
| `RESEARCH_NIGHTLY_QUOTE_MAX_AGE_SECONDS` | 300 alla decisione notturna, non al kickoff |
| `RESEARCH_NIGHTLY_MIN_EV`, `RESEARCH_NIGHTLY_MIN_PRUDENTIAL_EV` | 0,04 e 0,01, soglie sperimentali configurabili |
| Sessioni, origini CORS e HTTPS | Conservare protezioni e verificare browser/Android sul backend corretto |

Il workflow legge la variabile repository `RESEARCH_NIGHTLY_ENABLED`, con
default `false`; la variabile remota è ora attiva. Il flag
Hostless serve alla dichiarazione di stato della dashboard: il web non avvia
la nightly nemmeno quando dichiara la configurazione abilitata.

Il job A/C usa il feed essenziale anche con raccolta informativa generale
spenta. Lo Smart Odds Manager condivide snapshot e costo fra i modelli;
quote scadute, mancanti o oltre budget causano astensione. Le stime di domanda
nightly non garantiscono copertura delle cinque leghe. La
[gestione quote](smart-odds-2026-10-27.md) distingue consumo e proiezioni.

## Database personale e backup

Il punto di ripristino autorizzato è il dump sorgente delle 15:17 UTC /
16:17 Europe/Rome, privato, 459.806.723 byte, con integrità `ok` e FK0 già
verificati. La copia personale iniziale è importata e confrontata integralmente;
il backup target delle 17:59:54 UTC e la parità iniziale verificano 52 tabelle,
125 oggetti di schema e 314.089 righe. Queste prove riguardano gli snapshot,
non la sorgente live e non recuperano gli aggiornamenti successivi.

Il target è `footpredictor-selloneciompi.aws-eu-west-1.turso.io`, SQLite EU,
account personale gestibile dalla CLI. Ultimo piano osservato: Starter/free,
overage disabilitati. Contatori ufficiali delle 19:33:57 UTC: storage
526 MB/5 GB, letture 0,1M/500M, scritture meno di 0,1M/10M ed embedded sync
1,6 GB/3 GB (52%). Storage e sync sono contatori distinti, non capacità da
sommare. Nessun piano o servizio a pagamento è stato attivato; le fatture Hostless non sono accessibili e non
si certifica un consuntivo di costo.

La richiesta di backup finale sulla sorgente è bloccata: non si attribuisce
il motivo a quota o billing senza prova. L'utente ha accettato esplicitamente
il limite di recupero della copia esistente; questa adozione sostituisce il
piano ordinario che richiedeva una sincronizzazione finale sorgente.
L'originale non deve ricevere nuovi collegamenti. La sua eventuale dismissione
richiede prima verifica del target e accesso di gestione del proprietario:
la CLI disponibile opera solo sull'account personale.

020/021 sono applicate sul target. Export finale 18:58 UTC e parità 19:00 UTC
PASS: 57 tabelle e 133 oggetti di schema, con storico 52 tabelle preservato.
Le credenziali DB limitate sono predisposte; secret GitHub RW/RO personali
aggiornati alle 19:03 UTC. La configurazione produzione locale è aggiornata e
quella precedente archiviata privatamente. Il backend `63d7cb96` è distribuito
con l'ambiente personale: web e job puntano al medesimo canonico.
La [procedura Turso](turso-personal-migration-2026-10-29.md) e il report
canonico conservano hash e dettagli di verifica.

## Rilascio e collaudo

Sono conclusi deploy del nuovo ambiente, controlli health/legacy, login,
sessione e dashboard sul personale. Warmup `40937894463` SUCCESS; probe C
`40936914212` SUCCESS sull'artefatto reale, 100 inferenze solo in RAM, zero scritture
o provider, p95 circa 0,532 ms e RSS 156,98 MiB. Verifica contabile in sola
lettura sul monitor aggiornato `40945351072` SUCCESS. Sono prove specifiche, non il ciclo nightly.

La nightly manuale `40944747548` è SUCCESS, senza eventi eleggibili nella
finestra restante e senza puntate retroattive. L’audit RO conferma che
`missedMatches=2` conta due partite già iniziate, senza job o decisioni di modello. Solo una partita reale seguita fino al risultato
e alla liquidazione può completare il collaudo prospettico; non forzare una BET.

L'audit RO delle 20:07 UTC è PASS: quattro fingerprint finanziari invariati,
portafogli A/C da 1.000 euro, zero capitale impegnato e zero puntate. La
dashboard mostra Nightly riuscita alle 21:04 Roma e prossima esecuzione il 30 ottobre alle 03:00.
Monitor GitHub, DB periodico RO e attese delle 03:00 sono abilitati. Il watchdog
con attese attive `40946558140` è SUCCESS, tutti i passi GitHub e DB RO completati
in 26 secondi; nessun ciclo reale completo viene dedotto da questi controlli.

Il confronto economico usa due portafogli da 1.000 euro iniziali, stake 1%,
esposizione 5%, una puntata per partita/modello. `EXPERIMENTAL` può essere
ammesso con idoneità tecnica, senza promozione statistica. C resta Challenger.
Non sono equivalenti risultati sintetici, backtest con quote storiche e puntate
notturne realmente osservate; la dashboard conserva questa distinzione.

L'[audit runtime](nightly-model-runtime-2026-10-29.md) verifica l'inferenza Linux
e il nuovo assemblatore prospettico. Il registro iniziale non ha campioni
prudenziali idonei: l'avvio ammette soltanto astensioni, senza puntate o nuovi
movimenti del ledger.
La migrazione 021 conserva osservazioni prepartita e payout append-only al
clock reale del risultato, con 80/20 nominale per hash e futuro test escluso.
Minimo 50 per mercato/fascia e Hoeffding restano invariati, senza training,
calibrazioni inventate o promozioni. L'abilitazione remota non garantisce
puntate e non autorizza a ridurre questi gate per mostrarne una.

## Monitoraggio e CPU

La dashboard espone ultima nightly, esito, partite analizzate/saltate, API,
crediti e liquidazioni osservati. Il monitor GitHub legge il DB periodicamente
in sola lettura; anche le attese delle 03:00 sono ora attive, con opt-in
separato dal flag delle puntate. La revisione `4dff28f4` è pubblicata, CI
`40944506327` e smoke RO `40945351072` riusciti. Contabilità, quota, errori e
stalli recenti oltre quattro ore restano indipendenti dall'attesa programmata.
Nessun falso allarme per heartbeat intenzionalmente dismesso. La nightly è
abilitata; quando esegue il reconcile prepara la riga del
riepilogo, con `publishAfter` alle 09:00 Europe/Rome. Il GET filtra senza
scrivere o inviare all’esterno. Il job SUCCESS non sostituisce la verifica
di una riga riepilogo effettivamente generata dopo reconcile.
Nessuna notifica per ogni puntata o nuovo canale esterno attestato.

L'[audit locale Turso/CPU](turso-cpu-audit-2026-10-29.md) misura payload ridotto
e scritture identiche evitate. Non certifica minori righe fatturate, CPU web
risolta o causa dei precedenti avvisi Hostless. Una singola misura prima della pausa ha rilevato overview 2.826 ms e
comparison 315 ms; non prova throttling risolto. Non confondere throttling e
attesa in coda di deploy. Backend 0,1 vCPU/256 MiB invariato.

## Rollback

Disabilitare `RESEARCH_NIGHTLY_ENABLED` per fermare nuove registrazioni,
conservando import e liquidazioni delle giocate esistenti. Non riattivare
`AUTO_BET_*` o ripristinare la chiamata legacy nel vecchio workflow. Conservare
ledger, quote, versioni, artifact e giocate aperte.

Per il codice usare una release precedente compatibile con le migrazioni
additive, mantenendo il nuovo DB canonico. Il rollback coordina tutti i
processi e usa backup verificati del target; non riapre collegamenti alla
sorgente bloccata né inventa una riconciliazione dei delta ignoti accettati.
L’eventuale dismissione dell’originale resta subordinata a verifica del target
e gestione del proprietario; nessuna eliminazione è dichiarata eseguita.
