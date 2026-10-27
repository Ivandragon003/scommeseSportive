# Confronto storico A/C — 27 ottobre 2026

**Esito: inconcludente. C resta un candidato e non deve essere promosso.**
Il run reale mostra una piccola riduzione media di log loss e Brier, ma il
test finale non dimostra un miglioramento robusto e la sua calibrazione ECE
peggiora. Non sono stati caricati prezzi bookmaker nel run: non esiste una
misura economica A/C verificata, né una prova prospettica a T−15.

## Fonti e riproducibilità

Il run usa l'archivio reale delle cinque leghe esportato con una connessione
SELECT-only; nessun training parte dalle sole giocate precedenti. L'export
comprende 8.834 incontri, dei quali 7.476 con risultato. Al cutoff
`2026-10-27T07:30:00.000Z` la pipeline ammette 7.323 osservazioni: 153 partite
con storico insufficiente e 1.358 incomplete sono escluse. Non sono state
inventate statistiche, quote o etichette.

| Lega | Osservazioni ammissibili nel dataset | Osservazioni test fuori campione |
|---|---:|---:|
| Serie A | 1.570 | 466 |
| Premier League | 1.570 | 470 |
| La Liga | 1.589 | 485 |
| Bundesliga | 1.254 | 369 |
| Ligue 1 | 1.340 | 378 |
| Totale | 7.323 | 2.168 |

Artefatti completi locali, esclusi da Git per dimensione:

- `backend/artifacts/research/dataset.json`: feature cronologiche, cutoff e manifest.
- `backend/artifacts/research/run-20261027/report.json`: confronto grezzo del trainer.
- `backend/artifacts/research/run-20261027/pipeline-report.json`: confronto dopo la
  pipeline isotonica condivisa, riferimento principale di questo report.
- `backend/artifacts/research/run-20261027/artifact.json`: candidato finale e alberi.

Il [riepilogo numerico versionabile](research-ac-2026-10-27.json) conserva
metriche, fold, versioni e SHA-256 dei tre artefatti del run. L'hash del dataset è
`e6aa69e65ce1fcd7dd0a4fc974e703c78e36300ed98fe943bcfe48e7831d0fe4`.
La baseline è `A-80cb25df5552621e`; il candidato finale è
`C-13e4fc04b804facc`. Sono identità del run, non un certificato per codice o
configurazioni cambiati successivamente.

CatBoost 1.2.8 è stato realmente addestrato su CPU: 120 iterazioni, profondità 5,
learning rate 0,05, seed 20261027, due thread. Per ogni fold sono stati confrontati
correzione delle intensità, correzione delle probabilità ed ensemble calibrato.
Nel fold finale è stato scelto `calibrated_ensemble`, peso 0,75 e temperatura
0,8, dalla sola finestra di selezione. Questi valori non sono ottimi universali.
Non esiste un portafoglio CatBoost standalone.

## Protocollo temporale

La prima previsione ammissibile del dataset è il 27 agosto 2022, l'ultima il
26 ottobre 2026. Il fit A viene ristimato cronologicamente. Per ogni target si
usano soltanto risultati disponibili prima della previsione, con ritardo minimo
kickoff + due ore e almeno trenta incontri precedenti per competizione.
Il target non fornisce xG realizzati, risultato o statistiche postpartita.

Ogni fold distingue training, selezione del candidato/pesi/temperatura,
calibrazione e test successivo. Le finestre test sono disgiunte. Le numerosità
non rappresentano quattro campioni casuali; i dati seguono il calendario.

| Fold | Training | Selezione | Calibrazione | Test | Configurazione C scelta |
|---|---:|---:|---:|---:|---|
| 0 | 4.075 | 688 | 387 | 739 | Correzione intensità |
| 1 | 4.766 | 756 | 366 | 684 | Correzione intensità |
| 2, holdout finale | 5.527 | 706 | 335 | 745 | Ensemble calibrato |

Gli istanti di previsione delle finestre test vanno dal 24 maggio al
13 dicembre 2025, dal 14 dicembre 2025 al 4 aprile 2026 e dal 4 aprile al
26 ottobre 2026. Nel fold finale il primo target è
`2026-04-04T18:45:00.000Z`, l'ultimo `2026-10-26T19:45:00.000Z`.
La selezione dei pesi non usa questi risultati. Ulteriori scelte dopo aver
letto questo report richiedono un nuovo test indipendente: ripetere lo stesso
holdout per ottimizzare invaliderebbe la sua funzione.

Il modello A ricostruito usa il nucleo statistico cronologico esistente,
comprendente Dixon–Coles, Poisson-xG e contesto storico ammissibile.
La matrice ausiliaria A non sostituisce le marginali A per famiglia. La
calibrazione condivisa riusa l'implementazione isotonica dell'applicazione;
le probabilità raw e calibrate restano separate. Questo protocollo non equivale
a ogni possibile stato del servizio live con contesto mutabile.

## Risultati aggregati su 2.168 previsioni

Per log loss, Brier ed ECE valori inferiori indicano errore minore. Il Brier
multiclasse è la somma dei tre errori quadratici 1X2, senza divisione per tre.

| Stadio | Modello | Log loss | Brier | ECE |
|---|---|---:|---:|---:|
| Grezzo | A | 0,993754 | 0,591452 | 0,024613 |
| Grezzo | C | 0,987487 | 0,587878 | 0,014856 |
| Dopo calibrazione condivisa | A | 0,992842 | 0,590639 | 0,021174 |
| Dopo calibrazione condivisa | C | 0,987600 | 0,587813 | 0,018295 |

L'ECE grezzo del trainer raccoglie le tre probabilità di classe; l'ECE del
report pipeline usa la probabilità della classe più probabile e la sua
correttezza, con dieci intervalli. Questi due ECE non sono direttamente
confrontabili fra stadi; A e C sono confrontati con la stessa definizione
all'interno di ciascuno stadio.

Qui “grezzo” significa prima della calibrazione isotonica condivisa: il
candidato C include già peso e temperatura selezionati nella propria finestra.

Le differenze seguenti sono **C − A** dopo calibrazione: un valore negativo
favorisce C. Intervalli al 95%, 500 ricampionamenti, seed 20261027:

| Metrica | Differenza media | IC per match | IC per blocchi settimanali |
|---|---:|---|---|
| Log loss | −0,005242 | [−0,009519; −0,000543] | [−0,010620; −0,000278] |
| Brier | −0,002826 | [−0,005127; −0,000123] | [−0,005887; +0,000100] |

Il campione comprende 2.168 cluster match e 48 blocchi settimanali nel report
pipeline. L'intervallo settimanale Brier comprende zero: l'aggregato calibrato
è **inconcludente** secondo la regola adottata. L'etichetta
`C_probabilistically_better` del report grezzo non è la conclusione operativa:
non include l'intera verifica dopo calibrazione e dell'ultimo holdout.

| Lega, dopo calibrazione | n | Log loss A | Log loss C | Brier A | Brier C |
|---|---:|---:|---:|---:|---:|
| Serie A | 466 | 0,987089 | 0,983290 | 0,586509 | 0,583673 |
| Premier League | 470 | 1,026539 | 1,021201 | 0,615294 | 0,613942 |
| La Liga | 485 | 0,979761 | 0,971850 | 0,580930 | 0,574971 |
| Bundesliga | 369 | 0,973620 | 0,968674 | 0,575041 | 0,573309 |
| Ligue 1 | 378 | 0,993586 | 0,989820 | 0,592760 | 0,591065 |

Le medie per lega sono descrittive; questa tabella non dimostra significatività
separata in cinque leghe e non abilita singoli mercati.

## Holdout finale: 745 match, cinque leghe

Il test finale ha 18 blocchi settimanali nel report pipeline ed è il campione
da usare per decidere un'eventuale promozione del candidato finale.

| Stadio | Modello | Log loss | Brier | ECE |
|---|---|---:|---:|---:|
| Grezzo | A | 1,004327 | 0,599218 | 0,025507 |
| Grezzo | C | 0,999346 | 0,596110 | 0,027761 |
| Dopo calibrazione condivisa | A | 1,003212 | 0,598463 | 0,025810 |
| Dopo calibrazione condivisa | C | 0,998452 | 0,595254 | 0,033685 |

| Metrica calibrata | C − A | IC 95% per match | IC 95% settimanale |
|---|---:|---|---|
| Log loss | −0,004760 | [−0,014527; +0,004793] | [−0,015694; +0,008156] |
| Brier | −0,003209 | [−0,008798; +0,002646] | [−0,009537; +0,004594] |

Entrambi gli intervalli settimanali comprendono zero. L'ECE di C peggiora da
0,025810 a 0,033685. **Non sono superati i requisiti di robustezza e calibrazione
per promuovere C.** Mancano inoltre le prove operative remote richieste dal
lifecycle. Nessuna promozione viene giustificata dal miglior valore medio.

## Quote, risultati economici e mercati

Questo run è esclusivamente probabilistico. Nessuna quota storica è stata
caricata nel confronto A/C; ciò non significa che l'intero archivio applicativo
sia privo di snapshot o quote football-data. La loro ammissibilità nel nuovo
benchmark economico deve essere verificata e collegata separatamente.

- Confronto con probabilità bookmaker senza margine: **n = 0**, non misurato.
- Market blending: nessuna modifica delle probabilità in assenza di prezzi.
- Puntate economiche A/C: **0 ciascuno**; 2.168 astensioni per modello con
  `quotes_missing`.
- ROI, win rate e CLV: **non misurati** (`null`), senza evidenza economica.
- I 1.000 € finali delle simulazioni senza giocate sono capitale iniziale
  invariato; non dimostrano rendimento o assenza di rischio del modello.
- Tutte le 2.168 differenze decisionali sono `neither`: non è evidenza che A e
  C sceglierebbero sempre le stesse puntate quando esistono quote.

Non sono state trasformate quote di apertura/chiusura in prezzi T−15.
Non è disponibile una coorte indipendente con quote per stimare il margine
prudenziale; non vengono inventati residui favorevoli per sbloccare le puntate.
I mercati della nuova piattaforma restano **EXPERIMENTAL** in assenza di
validazione dedicata. Nessun mercato viene promosso da questo solo risultato
1X2. Il codice legacy di tiri/cartellini resta conservato.

## Verifica tecnica e stato operativo

Il percorso locale Docker isolato risponde ai controlli health e overview
ricerca con HTTP 200. Questa verifica dimostra avvio e collegamenti locali;
non certifica puntualità del cloud, disponibilità quote o un intero ciclo
prospettico con input autentici. I risultati finali dei test applicativi devono
essere letti insieme al verbale di verifica dell'intervento; non si considera
definitiva una conta precedente a ulteriori modifiche.

Nel gate applicativo completato al 27 ottobre: backend **635 test superati,
zero saltati**, typecheck e lint superati; frontend **22 suite e 148 test
superati**, build, typecheck e lint superati. Questi controlli includono
fixture dichiarate e non trasformano i test tecnici in validazione predittiva.
La ricostruzione Docker finale è riuscita: backend healthy, health e overview
HTTP 200, route legacy HTTP 410. Il candidato CatBoost reale esegue inferenza
nel container con pipeline compatibile e massa congiunta normalizzata.
Browser desktop/mobile: nessun errore console e nessun overflow della pagina.
Backup SQLite locale verificato con `integrity_check=ok` e saldi ricostruiti
di 100.000 centesimi per ciascun portafoglio. Queste prove non verificano
un backup del database remoto.

La route notturna legacy viene ritirata nel codice locale e i test ne verificano
il rifiuto. La verifica GitHub in sola lettura ha invece trovato il vecchio
workflow remoto ancora attivo, con `AUTO_BET_ENABLED=true` e chiamata alla
route legacy. **Non è verificata la disattivazione operativa delle puntate
notturne remote.** Il workflow configurato non prova quante giocate abbia
effettivamente creato; per questo servirebbe un audit del run e del DB pertinente.

L'utente ha confermato di non avere una VM e di mantenere il lavoro locale,
senza commit o push. Il nuovo scheduler remoto non è distribuito né attivato;
le modifiche locali non aggiornano il backend o i workflow già pubblicati.
Non sono stati attivati servizi a pagamento. Il criterio decisivo remoto resta
quindi **non soddisfatto**, coerentemente con la scelta di fermarsi al locale.

## Limiti e decisione

Il ritardo storico di due ore è prudenziale e non prova l'istante originario di
pubblicazione/correzione dei dati provider. La griglia congiunta C è troncata e
normalizzata a 0..10 gol per squadra. Le metriche principali sono 1X2: non
dimostrano qualità o correttezza economica di ogni linea degli altri mercati.
Il bootstrap settimanale attenua la dipendenza fra partite ravvicinate, senza
rimuovere tutta l'incertezza temporale o garantire prestazioni future.

La decisione è conservare A e C distinguendo candidato e Champion; **nessuna
superiorità robusta di C è dimostrata dal test finale**. Non attivare puntate o
mercati sulla base di questo report. Le prove mancanti sono un benchmark
economico con quote ammissibili, evidenze indipendenti per ciascun mercato e
un percorso remoto prospettico T−15 verificato, senza riottimizzare sul test
finale già osservato.

Per comandi, configurazione e criteri vedere
[piattaforma A/C](../research-platform.md) e [training ML](../../backend/ml/README.md).
