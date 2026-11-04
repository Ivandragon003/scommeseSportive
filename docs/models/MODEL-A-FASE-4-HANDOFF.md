# Modello A — passaggio di consegne Fase 4

La Fase 1 ha corretto gli xG mancanti; la Fase 2 ha concluso l'analisi storica nei limiti dei dati; la Fase 3 ha escluso l'adozione della variante xG/xGA per sede. La Fase 4 è aperta: né l'integrazione tecnica né la validazione statistica sono concluse. Il [protocollo](MODEL-A-VALIDAZIONE-PROSPETTICA.md) descrive architettura, prove e limiti; non attivare il recorder in produzione.

## Implementazione esistente

`PredictionService.predict` osserva probabilità contestuali ed ensemble; `EnhancedMarketAnalysis` espone una copia della calibrazione già calcolata e `ValueBettingEngine` osserva il valore passato all'EV. Il grezzo prima del contesto e il blending autonomo non sono disponibili. Il valore decisionale esatto viene registrato solo per una selezione Over/Under univocamente identificabile; altrimenti è null. I valori sono 0–1. `prospectiveOrigin` distingue `direct_a`, `shared_ac` e `internal`; l'origine tecnica non garantisce che la route mostri la stessa decisione dopo la proiezione research.

`backend/src/research/ModelAProspectiveRecorder.ts` gestisce coda, retry, recovery e diagnostica; `ModelAProspectiveSpool.ts` scrive file con fsync; `ModelAProspectiveShutdown.ts` collega il drain a SIGTERM/SIGINT nel web. `scripts/research-nightly.js` tenta il drain ordinario. `ModelAProspectiveResults.ts` riconcilia risultati Understat verificabili, mentre `DatabaseService.ts` inserisce righe append-only nello schema proposto `backend/experiments/model-a-prospective/schema.sql`. Il flag `MODEL_A_PROSPECTIVE_ENABLED` è spento per default; serve anche `MODEL_A_PROSPECTIVE_SPOOL_DIR` su volume privato persistente. `MODEL_A_PROSPECTIVE_SHUTDOWN_MS` imposta il limite di arresto. `MODEL_A_PROSPECTIVE_ALLOW_VOLATILE=true` è solo per test.

Lo spool limita le perdite dopo un crash di processo, non garantisce sopravvivenza a guasti del disco o perdita di alimentazione. I rifiuti e gli errori vengono segnalati; se anche il disco è indisponibile l'audit persistente può fallire. Il recorder non deve alterare le previsioni quando lo storage fallisce. La riconciliazione automatica verifica identità, kickoff, punteggio, `isResult` e `observedAt`; non attribuisce a Understat carattere ufficiale. Le correzioni già recepite possono essere registrate separatamente, ma il refresh attuale non garantisce il recupero delle correzioni dal provider.

## Blocchi e ordine di lavoro

1. Ricostruire e verificare la disponibilità temporale degli input: `inputAvailableThrough` e `inputSnapshotHash` sono null; fissare la provenienza senza inventare timestamp.
2. Verificare recovery automatico all'avvio e timer, arresti reali e comportamento con database/volume indisponibili; il test SIGKILL usa recovery esplicito e i segnali sono simulati.
3. Predisporre monitoraggio esterno per rifiuti, audit, backlog, capacità e copertura; provare il guasto disco. Misurare latenza su ambiente rappresentativo: l'ultimo p95 locale è passato da 28,85 a 53,44 ms.
4. Verificare riconciliazione, correzioni e limite di scansione; testare il cambio kickoff. Garantire una previsione nella finestra preregistrata 24 ore–60 minuti e selezionare l'origine prima della raccolta.
5. Classificare la suite non verde: l'impronta golden pre-C precede la correzione xG `0ecda0a2`; non aggiornarla semplicemente per ottenere il verde. Il nightly fallito nella suite ha superato 16 test isolati.
6. Verificare schema additivo, backup e compatibilità A/C; solo il proprietario può autorizzare applicazione schema, distribuzione e flag nell'ambiente di destinazione. I segnali reali, Turso remoto, persistenza del volume e carico di produzione richiedono quell'ambiente.

## Verifiche e operazioni isolate

Da `backend`: `npm run build`, `npm run typecheck`, `npm run lint`; `node --test test/model-a-prospective-*.test.js` può richiedere l'espansione esplicita dei nomi su Windows. Eseguire anche `node --test test/research-recommendation-runtime.test.js test/challenger-runtime-integration.test.js` e `npm test`. Gli ultimi risultati completi e benchmark sono nel protocollo; non interpretare test simulati come prove su Turso remoto.

Per una prova isolata usare un database libSQL locale dedicato e una directory spool temporanea privata. Applicare esplicitamente `schema.sql` solo a quel database di prova, impostare le variabili sopra nel solo processo di prova e controllare `model_a_prospective_forecasts`, `model_a_prospective_results`, file pendenti e `audit.ndjson`. I test `model-a-prospective-spool.test.js` e `model-a-prospective-shutdown.test.js` verificano rispettivamente recupero esplicito dopo SIGKILL e segnali simulati; verificare separatamente avvio e timer reali. Non inserire credenziali nel repository.

## Criteri di completamento

- **Preparazione tecnica:** input e provenienza verificabili, scheduling/campionamento fissati, test di ripristino e shutdown reali, osservabilità persistente, carico accettabile, schema e suite classificati, nessuna regressione A/C.
- **Avvio raccolta:** protocollo preregistrato, autorizzazione del proprietario, backup, schema e volume approvati, flag abilitato solo nell'ambiente autorizzato, controlli di righe, errori e arresto definiti.
- **Validazione statistica:** dopo raccolta indipendente, confronto appaiato con Brier, Log Loss, calibrazione e incertezza, copertura e versioni documentate secondo il protocollo. L'obiettivo di 1.000 partite non garantisce da solo precisione sufficiente.
