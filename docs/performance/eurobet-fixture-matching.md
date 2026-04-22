# Eurobet Fixture Matching Performance

Data: 2026-04-22  
Scope: ottimizzazione del matching fixture in [EurobetOddsService.ts](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/backend/src/services/EurobetOddsService.ts).  
Obiettivo: ridurre confronti fuzzy inutili e limitare il costo del matching quando il servizio deve associare molte fixture richieste ai match Eurobet della stessa competizione.

## Problema

Il matching usava già un primo indice `home/away`, ma aveva ancora due limiti operativi:

1. Se i key match non bastavano, il fallback finiva facilmente su un sottoinsieme troppo grande, fino a una scansione quasi globale della competizione.
2. Il fuzzy scoring restava il vero costo dominante, perché `scoreFixtureMatch()` veniva chiamato molte più volte del necessario.

Questo diventava costoso soprattutto quando:

- molte fixture appartengono allo stesso giorno
- più eventi condividono alias o kickoff vicini
- la stessa competizione contiene centinaia o migliaia di match sintetici nel benchmark

## Strategia applicata

### Indici introdotti

Per ogni match Eurobet vengono ora costruiti indici su:

- competizione: via `meetingAlias` normalizzato
- data normalizzata: bucket UTC e `Europe/Rome`
- `home slug`
- `away slug`
- `home identity`
- `away identity`
- coppia ordinata `home-away` su slug
- coppia ordinata `home-away` su alias/identity

Le strutture principali sono `Map<string, number[]>`, quindi lookup e candidate reduction avvengono senza rieseguire full scan.

### Cache usate

Riutilizzate o aggiunte:

- cache normalizzazione stringhe
- cache alias squadra
- cache slug squadra
- cache identity candidate
- cache parsing timestamp
- cache `buildTimeCandidates()`
- cache bucket data per fixture/match

### Nuova strategia di matching

Ordine di risoluzione:

1. `exact-pair`
   - match esatto sulla coppia ordinata `home-away` costruita dagli slug
2. `alias-pair`
   - match sulla coppia ordinata basata sugli alias
3. `slug-intersection`
   - intersezione `home slug` + `away slug`
4. `alias-intersection`
   - intersezione `home identity` + `away identity`
5. `single-team-date`
   - un solo team trovato, ma ristretto alla finestra data/ora
6. `date-window`
   - solo candidati della data plausibile
7. `competition-window`
   - ultimo fallback limitato alla stessa competizione

Solo a quel punto viene eseguito il fuzzy score sul subset ridotto.

### Risoluzione ambiguità

Se più candidati hanno score molto simile:

- viene scelto il migliore
- viene emesso un warning diagnostico
- in smoke mode viene registrato un issue recoverable

Questo evita silenzi quando due eventi sono davvero troppo vicini.

## Complessità prima / dopo

### Prima

Caso pratico peggiore:

- per ogni fixture si confrontavano molti o tutti i match rimasti
- costo dominante: `O(f * m)` fuzzy score

dove:

- `f` = fixture richieste
- `m` = match Eurobet candidati nella competizione

### Dopo

Nuovo costo:

- build indice: `O(m)`
- lookup candidati: `O(k)` su map/set piccoli
- fuzzy score: `O(f * c)`

dove:

- `c << m` nella maggior parte dei casi

In pratica:

- il matching non fa più fuzzy globale se esistono chiavi utili per ridurre i candidati
- il fallback massimo resta limitato alla competizione, non all’intero array indistinto

## Benchmark locali

Comando:

```powershell
cd C:\Users\ACER\Desktop\DANIELE\scommeseSportive\backend
npm run benchmark:performance
```

Script:

- [run-performance-benchmarks.js](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/backend/benchmarks/run-performance-benchmarks.js)

### Benchmark richiesti

| Scenario | Avg legacy | Avg current | p95 current | Delta tempo |
|---|---:|---:|---:|---:|
| 10 fixture | 8.18 ms | 2.49 ms | 17.70 ms | -69.56% |
| 100 fixture | 513.74 ms | 21.32 ms | 35.12 ms | -95.85% |
| 1000 fixture | 53138.97 ms | 1463.32 ms | 1474.11 ms | -97.25% |

### Confronti fuzzy totali medi

| Scenario | Confronti legacy | Confronti current | Riduzione |
|---|---:|---:|---:|
| 10 fixture | 568 | 10 | -98.24% |
| 100 fixture | 56080 | 127 | -99.77% |
| 1000 fixture | 5600800 | 6221 | -99.89% |

Nota: la riduzione dei confronti fuzzy è il vero miglioramento strutturale di questa patch.

## Copertura test

Test aggiunti o rilevanti in [eurobet-odds-service.test.js](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/backend/test/eurobet-odds-service.test.js):

- match esatto con più partite nello stesso giorno
- alias `Inter` / `Internazionale`
- alias `PSG` / `Paris Saint-Germain`
- kickoff con offset temporale
- nessun match trovato
- regressioni su `buildTimeCandidates()` e `buildEventAliasCandidates()`

## Tradeoff e limiti residui

1. Il fuzzy score non è stato indebolito: il threshold resta prudente per evitare falsi positivi.
2. L’ultimo fallback `competition-window` esiste ancora, ma viene raggiunto solo dopo i filtri più stretti.
3. L’indice di competizione è basato su `meetingAlias`, che nel servizio è l’identificatore più stabile lato Eurobet.
4. Se il payload Eurobet cambiasse naming in modo radicale e saltassero anche alias/slug/date, il matching resterebbe possibile ma meno efficiente.

## Esito

Obiettivi centrati:

- meno confronti fuzzy totali
- matching più veloce
- nessun allargamento volontario delle regole di match
- warning diagnostici sui casi ambigui
- benchmark prima/dopo documentati
