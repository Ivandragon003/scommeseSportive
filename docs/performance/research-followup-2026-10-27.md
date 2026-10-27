# Follow-up FootPredictor A/C — 27 ottobre 2026

**Stato: correzioni e diagnosi locali; nessun modello C promosso, nessun deploy
remoto e nessuna nuova autorizzazione a puntate automatiche.** Il lavoro resta
senza commit, push, scritture sul DB remoto o modifiche ai workflow pubblicati,
come richiesto dall'utente. Non è disponibile una VM. Le giocate sono virtuali.

Il [primo report A/C](research-ac-2026-10-27.md) e il relativo
[JSON](research-ac-2026-10-27.json) sono immutabili. Questo follow-up aggiunge
diagnosi, nuovi protocolli versionati e limiti: non riscrive quel test finale
come se fosse una nuova verifica indipendente.

## A. Problemi individuati

| Classificazione | Riscontro | Conseguenza |
|---|---|---|
| Difetto reale, probabilità | V1 correggeva marginali separati; la partizione 1X2 poteva perdere somma 1 e le marginali non descrivevano una distribuzione comune | Score e EV potevano usare probabilità diverse; serve una pipeline congiunta coerente |
| Difetto reale, confronto | Le popolazioni di calibrazione A/C contenevano numeri e famiglie di eventi diversi, pur usando gli stessi match | La calibrazione non costituiva un controllo perfettamente equivalente del solo contributo ML |
| Difetto reale, identità della validazione | La versione raw A può restare uguale mentre cambiano modalità, temperatura, codice o calibratore del post-processing | Una vecchia approvazione di mercato non deve autorizzare una diversa configurazione probabilistica |
| Difetto reale, contabilità | Il simulatore economico richiedeva allineamento degli arrotondamenti con il ledger in centesimi | Stake ed esposizione devono usare le stesse regole di floor/round del portafoglio persistente |
| Limite reale, quote | Lo storico conserva prezzi osservati ma non sempre l'ultimo aggiornamento bookmaker o una quota eseguibile attribuibile a un operatore | Nessuna freschezza T−15 può essere inventata e nessun ROI è ammesso senza il campione necessario |
| Stato remoto verificato | Workflow GitHub precedente attivo con `AUTO_BET_ENABLED=true` e percorso legacy | Il blocco locale delle puntate notturne non è una disattivazione remota |
| Rischio scientifico | Le 745 partite finali sono già state lette | Non possono diventare un nuovo holdout dopo ulteriori ottimizzazioni |
| Difetto di sviluppo corretto | Una prima maschera di feature ridotte usava tre finestre di selezione e veniva applicata anche ai fold precedenti | Quei risultati intermedi sono invalidati; il report corrente usa maschere basate soltanto sul prefisso disponibile a ciascun fold |
| Difetto di verifica corretto | `node --test` scopriva anche copie di test generate negli artifact ignorati e un modulo fixture | Il runner ora seleziona soltanto i file sorgente `*.test.js` della cartella `test/`; la conta pubblicata non include duplicati o fixture |
| Limite gratuito | La stima di carico completo può superare 500 crediti odds/mese | Non è pronta un'attivazione gratuita completa con margine dimostrato |
| Ipotesi da distinguere | Correlazioni fra feature, poca variabilità e variazioni fra stagioni possono incidere sul ML | Sono oggetto di ablation/controlli, non cause dimostrate dal solo audit |

L'audit ha controllato 7.323 righe e quaranta feature tramite ricostruzione
indipendente dai match disponibili prima di ogni previsione: nessuna discrepanza
oltre la tolleranza adottata, nessun duplicato o violazione temporale rilevati
nei controlli eseguiti. Non è una prova sulla cronologia originale delle correzioni
dei provider. Gli xG dello storico concluso esportato risultano presenti nelle
cinque leghe; la copertura quasi costante non autorizza a chiamare osservati
i fallback per squadre prive di precedenti.

Il confronto tra matrice ausiliaria A e marginali raw 1X2 nel dataset non ha
mostrato una discrepanza materiale: massimo circa `7,8 × 10⁻¹⁶`. Il difetto
dimostrato riguarda il post-processing V1, non una divergenza della baseline
1X2 raw in questa configurazione.

## B. Modifiche implementate

| Componente | Modifica e riuso |
|---|---|
| `CoherentProbabilityPipeline.ts` | Nuovo protocollo `joint-goal-coherent-v2`; riusa calibrazione isotonica e blending esistenti, normalizza 1X2 e riproietta la matrice dei gol |
| `ProbabilityConfiguration.ts`, runtime, store e Market Validation | Descrittore/hash della configurazione effettiva collegato all'evidenza di mercato e congelato nella decisione; configurazioni diverse o prive di hash non ereditano approvazioni |
| `backend/ml/diagnose.py`, `diagnostics/` e test Python | Audit indipendente del dataset, controlli senza ML, ablazioni, importanza e confronto delle tre integrazioni con split cronologici |
| `ResearchEvaluation.ts` e `GoalSettlement.ts` | Score ed EV derivati dalla stessa distribuzione finale; settlement con push/mezzi esiti e simulazione in centesimi coerente con il ledger |
| `HistoricalResearchOdds.ts`, CLI quote | Adattatore di soli snapshot reali e audit in lettura; timestamp osservato separato da aggiornamento bookmaker assente |
| `ResearchHoldoutPolicy.ts` | Protegge per ID i 745 match originali; nuovo test promozionale soltanto nel periodo futuro congelato |
| `ResearchLifecycle.ts` | Nuova identità V2 e calibratori compatibili; modalità/temperatura esplicite anche nei report; controlli operativi sulla configurazione effettiva dopo la pipeline completa, con partite/snapshot distinti; nessuna promozione di V1 o test riutilizzati |
| `ResearchExperimentStore.ts`, migrazione 017 | Corsia immutabile separata per diagnosi e sviluppo, senza compatibilità runtime o diritto di promozione |
| `research-experiments.js` | Import/export obbligatoriamente su file SQLite locale dei metadati di sviluppo e del replay su quote osservate; nessun candidato runtime creato |
| `backend/scripts/run-tests.js` e CI | Scoperta esplicita dei test sorgente; la CI esegue `test:ci` dopo la build già completata, evitando una seconda compilazione |
| `ResearchRuntime.ts`, T−15 e monitoraggio | Retry effettivi entro finestra, errori provider/configurazione separati, controlli di coerenza/calibrazione dopo il post-processing |
| `OddsApiService.ts` e DTO di stato | Crediti residui/consumati e costo ultimo recupero mostrati soltanto da header osservati con timestamp; assenza di misura mantenuta come `null` |
| Frontend, scheda Esperimenti | Configurazioni, intervalli, feature e confronti di sviluppo consultabili separatamente dai modelli operativi |

Restano invariati stack, database condiviso, dati storici, portafogli legacy e
codice dei mercati specialistici. Non sono aggiunti un modello B operativo,
microservizi o provider a pagamento. Il protocollo V1 è conservato per
consultazione e riproduzione storica, ma non è riassociato automaticamente a V2.
Una nuova pipeline cambia la configurazione decisionale anche di A: i nuovi
risultati devono riportarne il protocollo, senza attribuirli retroattivamente
alla versione del primo report.

La CLI V2 è stata verificata anche sul candidato reale con copia in una
directory locale distinta:

```powershell
node scripts/research-lifecycle.js finalize-coherent --artifact PARENT/artifact.json --report PARENT/report.json --out CHILD --mode isotonic_1x2
```

`PARENT` e `CHILD` rappresentano directory distinte; l'output non deve esistere
e la directory originale protetta viene rifiutata. Il figlio tecnico
`C-906371b0b3a1e2c8` conserva il legame con `C-13e4fc04b804facc`, senza
ricevere la validazione del genitore. Questo verifica la trasformazione e il
caricamento dei metadati, non la qualità predittiva del nuovo candidato.
Il gate rigetta gli ID protetti prima di ricalcolare qualunque loro score;
non si limita ad aggiungere un flag di esclusione dopo averli valutati.

## C. Diagnosi del modello C

Dettaglio riproducibile: [diagnosi ML](ml-diagnosis-2026-10-27.md) e relativo
[riepilogo numerico](ml-diagnosis-2026-10-27.json). I risultati intermedi
sono sostituiti solo dentro il nuovo esperimento di sviluppo; i report
originali non vengono alterati.

Le analisi di sviluppo escludono tutti i 745 ID finali da training, selezione,
calibrazione e controlli. Esaminano tre configurazioni ML: correzione intensità,
correzione probabilità e ensemble calibrato. Il contributo ML è confrontato
con controlli senza ML, compreso A sottoposto alla sola temperatura, per
separare un possibile effetto della calibrazione da quello di CatBoost.

L'importanza CatBoost, la permutazione e SHAP sono diagnostiche di previsione,
non misure causali. Feature correlate possono dividersi o scambiarsi l'importanza;
una feature importante non è automaticamente utile fuori campione. Le maschere
di feature, finestre storiche, pesi temporali e iperparametri sono esperimenti
di sviluppo conservati con identità, non nuove configurazioni già promosse.

L'esperimento sugli ultimi 730 giorni limita le etichette di training, mentre
le medie nelle feature restano quelle dello storico congelato. Non è una prova
dell'effetto di ridurre a due anni tutta la pipeline statistica A.

I dati mostrano ridondanze verificabili: `elo_difference` è esattamente la
differenza dei due Elo; gli indicatori di lega sono binari e sommano a uno.
La copertura xG varia essenzialmente nei casi senza storico (14 casa, 21
trasferta), non in una popolazione di match precedenti con xG parziali.
Non si deduce da questi fatti che eliminare tali feature migliori il modello.

I risultati numerici dei controlli e degli esperimenti sono riportati nella
sezione seguente insieme al loro limite di sviluppo. Non è giustificata
l'attribuzione esclusiva del precedente peggioramento ECE a una sola feature,
al rumore o all'algoritmo CatBoost: sono necessari i confronti controllati.

Sono stati completati **144 esperimenti su 2.261 match di sviluppo**, distribuiti
su 49 settimane e ottenuti da 6.578 righe ammesse fuori dal test protetto.
I tre fold hanno rispettivamente 739, 806 e 716 match di controllo. Il peso
ML include zero, assente nella vecchia griglia: un'integrazione può quindi
scegliere di non usare CatBoost in una finestra.

| Controllo/configurazione, prima della calibrazione aggiuntiva | Log loss | Brier | ECE classe principale |
|---|---:|---:|---:|
| A identità | 0,984369 | 0,585145 | 0,031645 |
| A con sola temperatura, zero ML | 0,980031 | 0,582837 | 0,023954 |
| C, correzione intensità | 0,977820 | 0,581488 | 0,012430 |
| C, correzione probabilità | 0,981431 | 0,583761 | 0,019129 |
| C, ensemble | 0,980152 | 0,582615 | 0,010218 |

Una parte del miglioramento rispetto ad A grezzo esiste anche senza ML.
Con lo stesso controllo di temperatura, l'incremento C−A ha IC settimanale
log loss `[−0,004895; +0,000213]` e Brier `[−0,003077; +0,000100]`: entrambi
comprendono zero. Non è robustamente isolato un valore aggiunto ML oltre
la calibrazione in questi dati di sviluppo.

Le ablazioni della correzione intensità con isotonica coerente danno log loss
C fra 0,980000 e 0,980405 per i gruppi base/base+xG/base+forma/base+Elo/base+venue,
contro 0,978755 della configurazione completa. Non emerge una singola aggiunta
con beneficio uniforme. Le feature ridotte vengono ora scelte per fold,
soltanto dalle selezioni disponibili: 13, 7 e 10 feature, con risultato aggregato
log loss 0,978515/Brier 0,581907. Anche questo è sviluppo dopo confronti multipli,
non una nuova prova indipendente.

Importanze elevate ricorrenti riguardano intensità A, gol/tiro avversario,
campione ed xG; riposo, Elo e forma hanno contributi variabili. Per esempio
`lambda_away_A` e `lambda_home_A` hanno PredictionValuesChange medio circa
5,51 e 5,06. Non esiste una lista dimostrata di feature universalmente inutili:
xG/Elo hanno intervalli di permutazione favorevoli in una stagione e non
conclusivi nella successiva. La spiegazione causale del peggioramento ECE
originale rimane non identificata.

## D. Nuovo confronto A/C e relazione con il precedente

Il benchmark originale resta 2.168 previsioni fuori campione, con ultimo
holdout di 745 match. Dopo calibrazione V1: A log loss 0,992842/Brier 0,590639;
C 0,987600/0,587813. Nel test finale A ECE 0,025810 e C 0,033685; gli intervalli
settimanali di log loss e Brier comprendevano zero. La conclusione originale
resta inconcludente e non viene sostituita da una selezione successiva.

Il nuovo confronto serve a diagnosticare e correggere il protocollo. Le
osservazioni di sviluppo già disponibili non sono un nuovo test finale
indipendente. Un risultato migliore dopo normalizzazione, temperatura o scelta
di feature è descritto come evidenza di sviluppo; non dimostra superiorità
promozionale o redditività. I breakdown per lega e mercato devono usare le
medesime popolazioni e definizioni metriche; una differenza fra protocolli o
campioni non è attribuibile al solo ML.

Riferimento diagnostico, correzione intensità con quaranta feature e isotonica
1X2 coerente, sullo stesso campione di sviluppo:

| Modello | n | Log loss | Brier | ECE classe principale |
|---|---:|---:|---:|---:|
| A | 2.261 | 0,982241 | 0,583828 | 0,020579 |
| C | 2.261 | 0,978755 | 0,582026 | 0,008628 |

Differenze C−A: log loss −0,003485, IC settimanale
`[−0,006889; −0,000270]`; Brier −0,001802, IC settimanale
`[−0,003587; −0,000063]`. Sono intervalli esplorativi dopo molte configurazioni,
su periodi già osservabili; non certificano una promozione. Il controllo senza
ML della sezione C limita l'attribuzione del miglioramento a CatBoost.

Gli IC al 95% sono **nominali per il singolo confronto**, ottenuti dal bootstrap
settimanale: non sono corretti per le 144 configurazioni né per la selezione
effettuata su questo insieme di sviluppo. Non controllano l'errore complessivo
dei molti confronti e non diventano intervalli validi per un vincitore scelto
successivamente. Una differenza nominalmente favorevole resta esplorativa;
la promozione richiede una regola fissata prima e un nuovo campione futuro
indipendente, con le assunzioni temporali del metodo esplicite.

| Lega, sviluppo | n | Log loss A | Log loss C | Brier A | Brier C |
|---|---:|---:|---:|---:|---:|
| Bundesliga | 407 | 0,997533 | 0,992416 | 0,591823 | 0,589469 |
| La Liga | 484 | 0,962459 | 0,956196 | 0,569104 | 0,565505 |
| Ligue 1 | 398 | 0,974985 | 0,976989 | 0,579576 | 0,580424 |
| Premier League | 486 | 1,001586 | 0,998180 | 0,598588 | 0,597281 |
| Serie A | 486 | 0,975732 | 0,971804 | 0,580520 | 0,578304 |

| Mercato, sviluppo | n valutabile | Log loss A | Log loss C | Brier A | Brier C |
|---|---:|---:|---:|---:|---:|
| Doppia chance 1X | 2.261 | 0,563526 | 0,560043 | 0,190601 | 0,189287 |
| DNB casa | 1.704 | 0,571502 | 0,566485 | 0,194369 | 0,192496 |
| Over 2,5 goal | 2.261 | 0,684233 | 0,681570 | 0,245691 | 0,244347 |
| Casa over 1,5 goal | 2.261 | 0,639836 | 0,640275 | 0,224532 | 0,224508 |
| BTTS | 2.261 | 0,692894 | 0,694009 | 0,249725 | 0,250295 |
| Handicap europeo casa −1, tre esiti | 2.261 | 0,897325 | 0,894415 | 0,525532 | 0,524422 |
| Handicap asiatico casa +0,25 | 2.261 | 0,575278 | 0,571201 | 0,195898 | 0,194312 |

I valori binari e multiclasse non sono confrontabili fra righe. I rimborsi
DNB sono esclusi dal suo scoring condizionale e i mezzi esiti usano peso
appropriato; il dettaglio è nel JSON diagnostico. ECE e intervalli indipendenti
di validazione per ciascun mercato non sono dimostrati da questa tabella.
In Ligue 1 e BTTS il valore medio C peggiora: il guadagno non è uniforme.

| Evidenza promozionale nuova, protocollo V2 | A | C |
|---|---|---|
| Match futuri indipendenti valutabili | 0 | 0 |
| Log loss, Brier, ECE | Non misurati | Non misurati |
| Intervalli appaiati e breakdown indipendenti per lega/mercato | Non disponibili | Non disponibili |
| Conclusione ufficiale aggiornata | Riferimento da validare | Nessuna superiorità dimostrata |

I risultati di sviluppo sotto riportati non riempiono questa tabella con una
nuova dichiarazione di successo. Le due popolazioni hanno scopi diversi.

## E. Validazione economica e qualità delle quote

Dettagli e conteggi: [audit quote](research-odds-audit-2026-10-27.md) e
[riepilogo numerico](research-odds-audit-2026-10-27.json).

L'audit remoto dei prezzi è in sola lettura. Il matching usa l'identità
persistita e il confronto esatto di squadre/data tramite i normalizzatori
già presenti; i casi non provati sono esclusi anziché forzati. Le correzioni
del collegamento restano nell'export locale, senza aggiornare il DB condiviso.

Sono presenti mappe football-data per 7.476 match, ma il dato archiviato non
conserva sufficientemente colonne originarie, bookmaker effettivo e istante di
osservazione per trattarle come prezzi economici eseguibili del nuovo protocollo.
Non si ricostruiscono questi metadati dalla quota numerica. Gli snapshot di
prezzi reali recuperati restano distinti dai completamenti sintetici.

Nel benchmark originale sono abbinabili 519 match con snapshot prepartita
osservati: 42 nel fold precedente e 477 nei 745 finali. Nel fold iniziale non
ce ne sono. La calibrazione quote è assente per i primi due fold e conta 41
match nel finale; questi appartengono già alla calibrazione probabilistica,
quindi non sono una coorte indipendente per i residui prudenziali. Il numero
non soddisfa neppure il minimo cinquanta per bucket previsto dal selettore.

Dei 477 match finali con prezzi precedenti al forecast, 473 hanno un prezzo
osservato anche dopo la disponibilità della configurazione C. Questi sono
conteggi di copertura, non puntate economiche valide. Novantacinque snapshot
con alias non sufficientemente provati restano in quarantena conservativa:
non è una prova che tutti i loro ID siano sbagliati.

Il timestamp `capturedAt` è l'osservazione reale; `updatedAt` resta assente
quando manca nel dato originale. La rappresentazione di audit espone
`providerUpdatedAt: null` e `timestampEvidence: observed_snapshot`. Non si
assegna l'istante della raccolta al campo di aggiornamento del bookmaker.
Per confrontare una previsione con un prezzo precedente a T−15 occorre
ricostruirla all'istante effettivo dello snapshot; le feature T−15 non possono
essere abbinate retroattivamente a quel prezzo.

**ROI e CLV restano non disponibili**, senza un backtest economico dichiarato
valido. Il recupero di prezzi non colma la mancanza di una coorte prudenziale
indipendente e non certifica freschezza T−15. Nessuna quota è stata inventata,
nessun nuovo abbonamento acquistato e nessuna puntata creata.

È stato comunque eseguito il ricalcolo alle osservazioni effettive dei **42
match quotati ammessi allo sviluppo**, senza i 745 finali. Con il protocollo
V2 isotonico, A ottiene log loss 0,928867/Brier 0,548941/ECE 0,124083; C
0,942743/0,557067/0,175597. IC appaiati C−A: log loss
`[−0,007262; +0,038741]`, Brier `[−0,005684; +0,022915]`. Soltanto due
settimane e campione piccolo: risultato inconcludente, senza selezionare un
vincitore su questi 42 match.

Il controllo V2 identità, prestabilito e senza isotonica, dà A log loss
0,933442/Brier 0,551624 ed C 0,941840/0,556733; anche questo non produce una
conclusione robusta. I genitori CatBoost restano fissati e i nuovi calibratori
hanno identità distinte. Le metriche sono probabilistiche sul campione con
prezzi: i residui prudenziali indipendenti sono zero, le puntate rimangono zero
e ROI/drawdown/CLV sono indisponibili, non rendimenti pari a zero.

## F. Automazioni: stato locale e remoto

Il codice locale ritira permanentemente `/automation/place-valid-bets` con
HTTP 410 e rimuove il vecchio piazzamento da workflow/script nightly. Il
processo runner forza `RESEARCH_T15_SCHEDULER_ENABLED=false`; manutenzione,
import e liquidazione rimangono separati dalle decisioni.

Il workflow remoto precedente risulta invece ancora attivo con
`AUTO_BET_ENABLED=true`, `AUTO_BET_DRY_RUN=false` e il percorso legacy.
**Non è soddisfatta la disattivazione remota delle puntate notturne.** Nessuna
modifica remota è stata eseguita per rispettare il vincolo dell'utente.
La configurazione non prova quante giocate siano effettivamente state create.

T−15 mantiene target kickoff − 15 minuti, tolleranza +60 secondi, polling
15 secondi e quote reali con acquisizione/aggiornamento entro cinque minuti.
Job, lease, snapshot e unicità `(portfolio, match)` sono persistenti; il commit
ricontrolla finestra, provenienza, capitale ed esposizione. Un retry fuori
finestra non recupera una puntata; le partite simultanee sono ordinate prima
dell'allocazione. La liquidazione usa quota e linea congelate.

Il vincolo di mercato riguarda anche la configurazione probabilistica effettiva:
protocollo, hash del codice, modalità, temperatura e hash del calibratore o
dei pesi di blending usati. La ristima cronologica A prevista dal protocollo
resta un input ammesso; cambiare il post-processing è invece una configurazione
distinta, anche quando la versione raw A non cambia. Runtime e transazione
richiedono lo stesso hash approvato dal mercato; in assenza o discordanza
registrano `ABSTAIN` con `probability_configuration_not_validated`. Una coorte
con hash diversi non può promuovere un mercato. Non vengono aggiunte
retroattivamente approvazioni alle evidenze prive del descrittore.
Anche report del lifecycle e prove operative conservano modalità e temperatura:
un valore omesso non deve attivare implicitamente l'isotonica. Le prove del
Challenger sono collegate all'hash effettivo dell'artefatto verificato.

PC e smartphone spenti sono compatibili con un processo remoto persistente,
ma quel processo non è distribuito. Le notifiche restano in-app e non avvisano
fuori dall'app o della completa interruzione dell'host. Serve un watchdog esterno
autorizzato e verificato. Il [piano T−15](../operations/t15-readiness-2026-10-27.md)
descrive istruzioni future, anomalie e limiti senza dichiararli risolti.

## G. Deployment e prontezza alla pubblicazione

Nessun commit, push, deploy, nuovo account o piano a pagamento. L'utente non
dispone di una VM e ha scelto di mantenere il lavoro locale. La soluzione
compatibile futura resta una VM Linux gratuita sempre accesa con lo stesso
Compose/Node e Turso, inferenza JSON e training separato. Disponibilità gratuita,
accesso SSH, secrets, HTTPS, clock e backup remoto devono essere verificati.

Oracle Always Free è un candidato tecnico, con quote e possibile reclaim,
senza SLA T−15 dimostrato. GitHub Scheduled Workflows non garantisce puntualità;
trasferire il monolite su Workers Free non risolve i limiti CPU/memoria.
La stima sul calendario ottobre è 405 crediti T−15 più fino a 450 nightly,
totale 855 prima di retry/UI, contro 500 Starter: non è fatturazione osservata
e non dimostra sostenibilità gratuita del carico completo.

La correzione preferita per il vecchio piazzamento è pubblicare, dopo una
futura autorizzazione, workflow e script di manutenzione aggiornati, più il
backend che ritira la route. La sospensione temporanea dell'intero workflow
bloccherebbe anche la manutenzione e non annullerebbe run già iniziati. Nessuna
delle due azioni è stata eseguita. Le istruzioni precise e la sequenza di
attivazione sono nel [piano operativo](../operations/t15-readiness-2026-10-27.md).

Prima di dichiarare pronte le puntate shadow occorrono: vecchio piazzamento
remoto disabilitato, backup/restore remoto collaudato, quote e crediti adeguati,
nuovi modelli/calibratori compatibili, mercati ammessi, watchdog e prove
remote previsione → registrazione → liquidazione entro finestra. Il sistema
locale, anche con test verdi, non soddisfa da solo questi gate.

Il training settimanale non crea da solo test promozionali indipendenti.
Il suo ultimo fold storico scorre nel tempo, mentre il lifecycle rifiuta il
riuso di match valutati per candidati diversi: finestre settimanali sovrapposte
rimangono quindi bloccate. Prima dell'autopromozione remota occorre anche
pianificare coorti future disgiunte e fissare il candidato/confronto prima di
leggerne gli esiti. Non viene allentato il controllo per far passare i run.

## H. Test e documentazione

Le verifiche del follow-up comprendono pipeline coerente, equivalenza score/EV,
settlement e centesimi, protezione dell'holdout, identità degli esperimenti,
quote senza timestamp inventati, retry/lease/finestra, operatività dopo
calibrazione e UI Esperimenti.

| Controllo concluso sul sorgente del follow-up | Risultato |
|---|---|
| Backend, scoperta esplicita da 103 file sorgente | 681/681 test superati, zero saltati |
| Python, audit e diagnosi con training/parità reali | 13/13 test superati, zero saltati |
| Frontend | 24 suite, 160 test superati; typecheck, lint e build superati |
| Backend, verifiche statiche finali | Typecheck e lint superati, compresi gli script verificati |
| Docker locale con V2 e migrazione 017, immagine finale | Backend/frontend healthy; health e overview HTTP 200, POST legacy HTTP 410 |
| Inferenza locale su prossima partita reale, ID 31647 | Massa della matrice e somma 1X2 pari a 1; nessuna registrazione di puntata |
| Backup SQLite locale con VACUUM e ripristino della copia | Integrità superata; tre candidati, 149 metadati e zero puntate conservati, saldi ricostruiti a 100.000 centesimi per ciascun portafoglio |
| Scansione dei sorgenti con Gitleaks | Nessuna credenziale rilevata nello scope controllato |

La precedente conta intermedia di 714 includeva quaranta test provenienti da
quattro copie negli artifact ignorati e un modulo fixture contato come file
test. Dopo la scoperta esplicita e il nuovo test di rigetto anticipato risultano
674 test effettivi; cinque nuovi test sul legame della configurazione
probabilistica e due sul lifecycle portano il gate finale a 681. Nessun test
sorgente viene saltato per ridurre la conta.
Il confronto fra conteggi di fasi diverse non dimostra da solo più copertura.
I 149 metadati comprendono 144 esperimenti ML, due controlli senza ML, due
ricostruzioni su quote osservate e un riepilogo; sono separati dai tre candidati
del registry operativo. Entrambi i portafogli locali hanno 1.000 € disponibili,
zero capitale impegnato, zero puntate e scheduler disabilitato; tutti i mercati
sono `EXPERIMENTAL`. Lo smoke di inferenza non è una
decisione T−15 prospettica o un'attivazione di mercati.
La verifica visiva è conclusa: sei screenshot su desktop a 1.024 px e mobile
a 390 px, nessun overflow e console senza errori o warning. Filtri, dettaglio
e paginazione sono verificati, con sole richieste GET. I test mirati dei
singoli moduli non sono presentati come gate completo. I controlli finali
Docker/API/backup includono l'ultimo vincolo di configurazione. Il restore
remoto non è stato eseguito.

La build React verifica il bundle web riutilizzato da Capacitor; non certifica
una nuova installazione Android o il funzionamento di un dispositivo reale.
Il medesimo limite vale per il test locale Docker rispetto al cloud sempre acceso.

Aggiornati [README](../../README.md), [System Design](../SYSTEM-DESIGN.md),
[piattaforma A/C](../research-platform.md), [nightly](../github-actions-nightly-sync.md)
e piano operativo. Il report originale è preservato: il suo stato storico e
i suoi numeri non vengono corretti retroattivamente. I nuovi artefatti di
diagnosi hanno hash, configurazioni e popolazioni distinti.

## I. Raccomandazione e requisiti ancora aperti

**A resta il riferimento statistico; C resta sperimentale.** Questo non
equivale a dichiarare A già valido o redditizio. Il nuovo protocollo V2
corregge la coerenza matematica, ma richiede un nuovo test futuro prima di
qualsiasi promozione. Le 745 partite originali non sono riutilizzabili per
dimostrare tale miglioramento. I mercati rimangono `EXPERIMENTAL` senza
evidenze dedicate; nessuno è aperto da un ROI positivo o da un mese trascorso.

Continuare con raccolta e confronto tracciabili, controlli negativi della
calibrazione e quote ammissibili, conservando astensione quando l'evidenza
non basta. Non attivare ancora i portafogli shadow remoti: mancano processo
remoto autorizzato, disattivazione legacy pubblicata, test futuro, coorte
prudenziale indipendente, gate dei mercati e verifica operativa completa.
I blocchi sono dichiarati, senza sostituirli con ipotesi favorevoli.

Anche gli intervalli nominalmente favorevoli degli esperimenti di sviluppo
restano insufficienti: manca un controllo dell'effetto dei confronti multipli
e non è disponibile un nuovo test futuro indipendente. Nessuna promozione
automatica viene motivata scegliendo il migliore dei 144 risultati osservati.
