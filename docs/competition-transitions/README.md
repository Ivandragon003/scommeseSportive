# Import dati promozioni e retrocessioni

Questa cartella contiene i template per popolare l'audit delle transizioni di
categoria. I dati sono solo diagnostici: **non modificano ancora il modello** e
non applicano alcun correttivo alle probabilita.

## File da compilare

1. `secondary_competitions.csv` — catalogo dei campionati di origine.
2. `source_season_reference.csv` — una riga per campionato e stagione, con la
   distribuzione della classifica finale.
3. `team_competition_transitions.csv` — una riga per ogni squadra promossa o
   retrocessa.

## Formato stagione

Usare lo stesso formato gia presente nelle tabelle delle partite del progetto.
Prima dell'import verificare il valore effettivo con:

```sql
SELECT DISTINCT season FROM matches ORDER BY season DESC LIMIT 10;
```

I template usano `YYYY/YYYY` come esempio; non convertire automaticamente le
stagioni se il database usa un altro formato.

## Regole sui dati

- `source_ppg` e `goal_difference_per_match` sono preferiti ai valori grezzi
  per confrontare campionati con calendari diversi.
- `coverage_status`: `complete`, `partial`, `unknown`.
- `source_quality`: `confirmed`, `estimated`, `unknown`.
- `transition_mode`: `direct_1`, `direct_2`, `direct_3`, `playoff`,
  `playout`, `direct_relegation`, `unknown`.
- Lasciare vuoti i valori non disponibili e usare lo stato di copertura
  appropriato. Non inventare valori.
- `team_id` deve essere l'ID gia presente nella tabella `teams`, non il nome
  libero della squadra.
- La chiave logica di una transizione e `(team_id, destination_season)`.
- Ogni riga deve riportare `source_provider` e `source_reference` quando il
  dato e confermato, per mantenere la tracciabilita.

## Catalogo iniziale consigliato

Per il trasferimento di livello sono utili soprattutto le seconde divisioni
dei campionati che l'app analizza: Serie B, Championship, 2. Bundesliga,
Ligue 2 e Segunda Division. Il catalogo non implica che i dati siano gia
disponibili: va compilato e verificato prima dell'import.

## Controlli prima dell'import

- nessuna riga duplicata nel catalogo;
- una sola riga per coppia campionato-stagione in `source_season_reference`;
- nessuna transizione duplicata per squadra-stagione di destinazione;
- `source_ppg = source_points / source_matches` quando entrambi i valori sono
  presenti;
- non usare dati di una stagione diversa da quella indicata;
- non attivare il correttivo finche l'audit di omogeneita e il backtest non
  saranno completati e approvati.

## ID delle squadre

Per ottenere gli ID gia presenti nel database:

```sql
SELECT team_id, name FROM teams ORDER BY name;
```

Se una squadra non esiste ancora, non creare un ID arbitrario nel CSV:
segnalarla per il normale processo di ingestione Understat.
