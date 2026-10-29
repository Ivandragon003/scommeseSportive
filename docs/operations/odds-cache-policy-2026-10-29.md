# Quote cache-only: classificazione dell'astensione, 29 ottobre 2026

## Riscontro remoto

Il 29 ottobre alle 13:40:22 CET il backend LIVE `122fd360` ha risposto HTTP
`200` al POST `/scraper/odds/match` in circa 345 ms, senza quote disponibili.
Con `ODDS_INFORMATIONAL_NETWORK_ENABLED=false` e cache priva del prezzo,
non interrogare il provider è il comportamento atteso.

Il coordinatore e l'osservabilità hanno però emesso due log di errore,
`odds_cache_only` e `fixture_matching_failed`, producendo l'avviso appErrors
alle 13:42. Non dimostrano un timeout o un'indisponibilità di The Odds API.
Sono distinti dai warning CPU e dalla coda di deployment Hostless.

## Correzione locale

[OddsProvider](../../backend/src/services/odds-provider/OddsProvider.ts)
riconosce soltanto il codice strutturato `odds_cache_only`. Il
[coordinatore](../../backend/src/services/odds-provider/OddsProviderCoordinator.ts)
marca questo esito `not_checked` e registra uno skip informativo. Quando tutti
provider effettivamente tentati hanno soltanto questo blocco di policy, le
[route](../../backend/src/api/routes.ts) non assegnano un falso errore di
matching e l'[osservabilità](../../backend/src/services/SystemObservabilityService.ts)
conserva `outcome=skipped` e `skipReason`, senza registrare il provider come guasto.

Non è una richiesta riuscita né una quota valida: l'esito di disponibilità
resta negativo e il client riceve la sua indisponibilità. Non sono cambiati
flag di rete, budget, freschezza, provenienza o gate di ammissione. Nessuna
nuova chiamata provider è necessaria per evitare il falso allarme.

Errori reali, timeout, esiti misti e messaggi non strutturati continuano a
seguire la classificazione d'errore: non basta una stringa simile per
nascondere un guasto.

Nelle statistiche API, `requestsObserved` conserva tutte le richieste osservate;
`attemptsObserved` conta i tentativi e `requestsSkipped` gli skip. I tassi
escludono gli skip e le relative righe hanno stato `skipped`, senza trasformarli
in richieste riuscite.

## Verifiche e confini

Le modifiche riguardano quattro sorgenti e due file test:
[route quote](../../backend/test/odds-match-route.test.js) e
[osservabilità](../../backend/test/system-observability-service.test.js).
Sono passati 66 test mirati, typecheck, build e lint; la revisione finale non ha
individuato blocchi. **Il gate Linux completo è superato; la correzione non è
ancora distribuita**: QA isolata Node 20 con Python standard per i test backup,
777 test, 776 superati, un opzionale CatBoost saltato e zero fallimenti. Il
Dockerfile di produzione non cambia. L'ultimo run Windows ha invece asserzioni
verdi ma un crash nativo del file ResearchStore: resta un limite non risolto,
non un gate passato. Questi fatti non dimostrano che il crash sia causato
dalla patch odds o dalla correzione nativa.
Il web LIVE `122fd360` mantiene la classificazione precedente.

Il percorso bulk continua a restituire `503` quando previsto e il relativo
`http_request` rimane un log di errore intenzionale. La correzione elimina la
classificazione falsa del provider nel percorso match HTTP `200`; non promette
assenza di qualsiasi ERROR per una richiesta bulk fallita.

Per la pubblicazione conservare questa distinzione tra Linux e Windows, distribuire la stessa
revisione del warmup calibrazione e ripetere la richiesta cache-only sul
remoto: quote ancora indisponibili, zero nuovo consumo API, skip tracciato e
nessun nuovo falso errore applicativo. Questi risultati remoti non sono ancora
dichiarati. [Stato operativo](production-status-2026-10-29.md).

L'audit quote reale successivo (cinque richieste, 15 crediti, residuo 205) è
separato dalla prova cache-only: usa Linux locale verso provider/Turso e non
certifica il comportamento del worker Hostless. I digest delle otto tabelle
protette sono invariati e gli scheduler restano disabilitati.
