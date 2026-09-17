# Audit letture Turso — settembre 2026

## Correzioni verificate offline

- Learning: leggere prima le review esistenti; caricare snapshot solo per match da
  elaborare. Un run senza nuove review non legge alcuno snapshot e non forza il
  ricaricamento del tuning prima della scadenza della cache. Force refresh esplicito
  continua a funzionare.
- Snapshot: una ricerca indicizzata dell'ultimo snapshot per ID richiesto sostituisce
  la finestra ROW_NUMBER su tutto lo storico degli snapshot. Ordinamento temporale
  e spareggio per snapshot_id rimangono invariati.
- Nightly: COUNT dei match completati sostituisce il caricamento di tutte le righe
  della stagione per decidere la finestra di training. Le ultime date per campionato
  vengono lette insieme, anziché con una chiamata per lega.
- Bootstrap: nessun retry immediato per blocco del piano DB, quota esaurita,
  rate limit HTTP 429 o errori HTTP 4xx non transitori. Errori di rete, 408 e 5xx
  temporanei mantengono i retry limitati esistenti.
- CI: tutti i collector periodici, incluse le formazioni, sono esplicitamente
  disabilitati nel backend temporaneo della nightly.
- Migrazione 013: indici additivi per seek snapshot, conteggi completati e range
  prossime partite. Nessun dato o indice precedente rimosso. La creazione degli
  indici comporta lavoro una tantum al prossimo bootstrap.

I test locali EXPLAIN QUERY PLAN verificano l'uso dei tre indici e l'assenza
di ordinamenti temporanei nei tre percorsi interessati. Nessuna richiesta a Turso.
Avvio Node, healthcheck e API di ricalcolo verificati con libSQL in memoria.
Build Docker non eseguibile in questo turno: il daemon Docker Desktop è spento.

## Controlli già soddisfatti

- La nightly conserva e valida la finestra obbligatoria corrente + quattro stagioni.
  Non saltare lo storico solo perché esistono righe: copertura e correzioni devono
  restare verificabili.
- Understat non riscrive match invariati; post-processing e refit vengono saltati
  quando non sono cambiate partite giocate. Le medie squadra usano il batching.
- Gli scheduler nel processo hanno guardie running e timeout concatenati, non
  intervalli che accumulano richieste concorrenti.
- I due cron GitHub per ora legale/solare sono filtrati dal gate del cron attivo;
  la concurrency del workflow evita run simultanei.
- Polling UI: sospeso a scheda nascosta, richieste condivise, timer protetti contro
  duplicazioni; 60 secondi a riposo e 15 durante sync.

## Limiti e verifiche dopo il ripristino

- EXPLAIN locale e numero di chiamate non misurano la fatturazione Turso. Registrare
  letture/scritture dal pannello prima e dopo una nightly e dopo uso UI ordinario.
- Docker locale ha scheduler Understat, quote e learning abilitati. Se GitHub
  Actions punta allo stesso DB ed è attivo, scegliere un solo orchestratore per
  le nightly. Le guardie locali e la concurrency GitHub non sono lock tra processi.
  Nessuna impostazione personale è stata disabilitata senza questa scelta.
- Avvio e healthcheck contro il DB reale sono ancora da verificare; i container
  del progetto restano fermi per non fare tentativi sul piano bloccato.
- L'archivio resta volutamente invariato: cache già presente, unificazione SQL
  rimandata su richiesta del proprietario.
