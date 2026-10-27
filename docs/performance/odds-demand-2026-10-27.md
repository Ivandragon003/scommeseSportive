# Domanda quote mensile — simulazione offline del 27 ottobre 2026

**Nessuna chiamata provider è stata effettuata.** I crediti sono stimati, non consumi osservati o un saldo disponibile certificato.

## Fonti, copertura e regole

Fonte: export locale di 8834 partite Understat normalizzate dei cinque campionati, SHA-256 `37e352af6016e9f1d429914124f0ce6317aece3ed4b1339f12978d74075ad6e1`. Non vengono usate soltanto le giocate o le 7.323 righe ML: vengono considerate tutte le fixture ammissibili del calendario esportato.

La documentazione [The Odds API v4](https://the-odds-api.com/liveapi/guides/v4/) distingue richieste HTTP e crediti: quote core = mercati × regioni; la richiesta sui punteggi con `daysFrom` costa 2 crediti. L’elenco `/events` è gratuito e non richiede il feed h2h né scores per conoscere gli eventi. Il [piano gratuito](https://the-odds-api.com/) pubblicizza 500 crediti mensili. Gli header `x-requests-last`, `used` e `remaining` restano la fonte operativa del consumo.

Una chiamata sport/lega con h2h, totals e spreads in EU viene pianificata come 1 HTTP / 3 crediti. La stessa richiesta evento non diventa più economica: perde il raggruppamento fra partite della stessa lega. Risposte vuote o mercati mancanti possono costare meno, ma non forniscono la copertura richiesta. Non si assume il costo pieno come consumo effettivo già misurato.

Gli eventi sono raggruppati per lega e kickoff UTC, con target a T−15. La competenza mensile segue il timestamp della decisione: un kickoff nei primi 15 minuti UTC del mese può consumare il budget del mese precedente. Il fuso esatto del reset provider non è stato confermato: i mesi UTC sono una convenzione esplicita della simulazione.

Budget nominale: 500; riserva ordinaria: 50; margine retry: una richiesta aggiuntiva per ceil(10% dei gruppi T−15), distribuita deterministicamente e riservata prima di ammettere quel gruppo. È un’ipotesi prudenziale di capacità, non una stima delle probabilità di errore. Il retry è ipotizzato nella finestra massima di 60 secondi.

La cache principale viene considerata riutilizzabile per 30 secondi, separatamente per lega. Il prezzo è ipotizzato aggiornato all’acquisizione: non è una misura reale. La sensibilità con cache 300 secondi resta condizionata al timestamp originale del provider e al limite di cinque minuti; non rende fresca una quota vecchia.

## Verifica della precedente stima 855

La formula era: 135 gruppi × 3 crediti = 405, più 5 leghe × 3 mercati × 30 giorni = 450, totale **855 crediti**. È aritmeticamente corretta come esempio di 30 giorni; non era un conteggio di HTTP effettivi né includeva retry, UI, kickoff refresh o mercati evento aggiuntivi.

Il mese 2026-10 ha 31 giorni: la sola quota notturna counterfactual vale 465 crediti e 155 HTTP, assumendo tutti e tre i mercati restituiti.

## Mese 2026-10

Calendario disponibile: **189 fixture**, **135 gruppi lega/kickoff**, 144 partite già concluse e 44 timestamp futuri non verificati. La completezza del calendario non è certificata.

| Scenario | Crediti richiesti, retry inclusi | HTTP richiesti | Crediti ammessi | Fixture coperte / disponibili | Copertura calendario |
|---|---:|---:|---:|---:|---:|
| A: vecchia nightly quote attiva, nessuna quota aggiuntiva UI | 912 | 304 | 450 | 74/189 | 39.2% |
| B: nightly quote spenta, riserva 50 intatta | 447 | 149 | 447 | 189/189 | 100.0% |
| B prioritaria: T−15 può usare anche la riserva | 447 | 149 | 447 | 189/189 | 100.0% |
| Sensibilità: refresh kickoff una volta al giorno per lega | 1377 | 614 | 450 | 44/189 | 23.3% |

A e C condividono lo stesso recupero: non esiste un secondo addebito per modello. In B le letture informative devono essere cache-only e non possono generare richieste extra. Lo scenario A ricostruisce il vecchio flag notturno; non significa che il nuovo codice locale lo lasci attivo.

Il percorso di sincronizzazione kickoff precedente può chiamare h2h (1 credito) e scores con `daysFrom` (2 crediti) per lega. La sua frequenza non è dimostrata come giornaliera: è esclusa dallo scenario base e mostrata separatamente come sensibilità. Non vanno sommati costi ipotetici come se fossero consumi osservati.

Con richieste evento una per fixture, il solo T−15 richiederebbe 567 crediti base e 624 includendo il medesimo margine retry. Per il feed sport raggruppato B la richiesta stimata è 447.

Sensibilità favorevole di cache fino a cinque minuti: 447 crediti, 0 gruppi serviti da cache. È un limite condizionato a prezzi ancora validi, non copertura garantita.

## Stress sui mesi storici disponibili

La tabella usa tutti i mesi esportati anteriori al mese di acquisizione. “Passato” non prova da solo completezza o disponibilità delle quote: sono dati di calendario utilizzati per simulare domanda.

| Mese UTC decisione | Fixture disponibili | Gruppi | B crediti richiesti | Fixture ammesse con riserva intatta | Fixture ammesse T−15 prioritario |
|---|---:|---:|---:|---:|---:|
| 2022-08 | 202 | 130 | 429 | 202 | 202 |
| 2022-09 | 141 | 108 | 357 | 141 | 141 |
| 2022-10 | 261 | 198 | 654 | 181 | 202 |
| 2022-11 | 117 | 80 | 264 | 117 | 117 |
| 2022-12 | 38 | 27 | 90 | 38 | 38 |
| 2023-01 | 190 | 142 | 471 | 183 | 190 |
| 2023-02 | 208 | 156 | 516 | 185 | 202 |
| 2023-03 | 151 | 115 | 381 | 151 | 151 |
| 2023-04 | 260 | 192 | 636 | 187 | 202 |
| 2023-05 | 228 | 141 | 468 | 204 | 228 |
| 2023-06 | 30 | 7 | 24 | 30 | 30 |
| 2023-08 | 124 | 90 | 297 | 124 | 124 |
| 2023-09 | 189 | 134 | 444 | 189 | 189 |
| 2023-10 | 165 | 130 | 429 | 165 | 165 |
| 2023-11 | 144 | 111 | 369 | 144 | 144 |
| 2023-12 | 230 | 161 | 534 | 189 | 211 |
| 2024-01 | 140 | 118 | 390 | 140 | 140 |
| 2024-02 | 199 | 158 | 522 | 175 | 191 |
| 2024-03 | 180 | 140 | 462 | 176 | 180 |
| 2024-04 | 202 | 159 | 525 | 175 | 192 |
| 2024-05 | 178 | 109 | 360 | 178 | 178 |
| 2024-06 | 1 | 1 | 6 | 1 | 1 |
| 2024-08 | 125 | 87 | 288 | 125 | 125 |
| 2024-09 | 174 | 135 | 447 | 174 | 174 |
| 2024-10 | 153 | 114 | 378 | 153 | 153 |
| 2024-11 | 167 | 126 | 417 | 167 | 167 |
| 2024-12 | 199 | 149 | 492 | 182 | 199 |
| 2025-01 | 185 | 143 | 474 | 177 | 185 |
| 2025-02 | 196 | 149 | 492 | 178 | 196 |
| 2025-03 | 165 | 128 | 423 | 165 | 165 |
| 2025-04 | 203 | 146 | 483 | 189 | 203 |
| 2025-05 | 185 | 103 | 342 | 185 | 185 |
| 2025-08 | 126 | 93 | 309 | 126 | 126 |
| 2025-09 | 153 | 118 | 390 | 153 | 153 |
| 2025-10 | 165 | 118 | 390 | 165 | 165 |
| 2025-11 | 188 | 143 | 474 | 180 | 188 |
| 2025-12 | 170 | 129 | 426 | 170 | 170 |
| 2026-01 | 223 | 171 | 567 | 178 | 195 |
| 2026-02 | 193 | 149 | 492 | 175 | 193 |
| 2026-03 | 166 | 133 | 441 | 166 | 166 |
| 2026-04 | 181 | 147 | 486 | 168 | 181 |
| 2026-05 | 187 | 104 | 345 | 187 | 187 |
| 2026-08 | 97 | 74 | 246 | 97 | 97 |
| 2026-09 | 153 | 116 | 384 | 153 | 153 |

Il mese storico più oneroso disponibile è **2022-10**: 261 fixture / 198 gruppi, domanda B 654 crediti. Non è lecito promettere copertura mensile completa dei cinque campionati con 500 crediti se la domanda calcolata supera tale valore. Anche l’uso della riserva non crea nuovi crediti.

## Calendario futuro e fallback

I timestamp futuri non esplicitamente marcati come sconosciuti vengono inclusi soltanto come scenario condizionato. Le date marcate `kickoffKnown=false`, `kickoffPrecision=date/unknown`, senza fuso, annullate o rinviate vengono escluse. L’export attuale non contiene una conferma indipendente degli orari futuri.

Nei mesi futuri molte fixture della stessa lega condividono l’orario predefinito: ciò può ridurre artificialmente il numero dei gruppi. Un futuro mese con pochi gruppi non dimostra bassi consumi reali dopo la definizione degli anticipi/posticipi. Il sistema operativo deve verificare gli eventi prima del target.

**Scenario C: bloccato.** Nessun fallback distinto, gratuito, autorizzato e con copertura dimostrata dei tre mercati è configurato. La sua capacità aggiuntiva provata è zero; non viene inventata una seconda quota gratuita né attribuita ad altri operatori.

I tre mercati richiesti non corrispondono a tutti i mercati teorici del modello. Quote DC/DNB, BTTS o totali squadra non vengono inventate dai prezzi 1X2. Un eventuale ampliamento del feed modifica il budget e richiede disponibilità reale.

## Uso ripetibile e conclusione

```powershell
cd backend
npm run build
node scripts/simulate-odds-demand.js --input artifacts/research/matches.json --asof 2026-10-27T07:30:00.000Z --month 2026-10 --output-json ../docs/performance/odds-demand-2026-10-27.json --output-md ../docs/performance/odds-demand-2026-10-27.md
```

La simulazione rende verificabile il risparmio da separazione della nightly, condivisione A/C e cache. Non certifica SLA, latenza, assenza di errori, quote disponibili o consumo effettivo. Se il budget reale misurato non basta, il comportamento corretto è saltare la decisione e conservarne il motivo. Cambiare la finestra T−15, la freschezza o introdurre costi richiede una decisione esplicita.

[Dati della simulazione](odds-demand-2026-10-27.json)
