# Calibrazione squadre promosse: fase shadow

## Stato

Il correttivo non modifica ancora prediction, confidence, EV o stake. La nightly
salva soltanto evidenza fattuale delle squadre note durante le stagioni nelle
seconde divisioni, con fonte `football-data.co.uk` e finestra mobile di cinque
stagioni.

Non vengono ricostruiti xG, formazioni o statistiche giocatore mancanti.

## Candidati da confrontare

1. `transferable_elo_offset`: rating trasferibile tra divisioni con offset
   stimato solo sulle promozioni precedenti al match valutato.
2. `bayesian_shrinkage`: miscela tra campione di seconda divisione e partite
   reali accumulate nella Top 5; il peso della Top 5 cresce col campione.
3. `cross_division_anchors`: mappatura delle scale tramite squadre osservate in
   entrambe le divisioni, usando solo dati disponibili as-of.

## Gate di attivazione

- split temporale stretto, senza usare dati successivi al kickoff;
- confronto per ciascuna lega e complessivo contro il modello corrente;
- nessun peggioramento materiale di log loss, Brier score o calibrazione;
- miglioramento stabile su almeno quattro delle cinque leghe;
- campione documentato e risultati riproducibili.

Fino al superamento del gate, `modelAdjustmentEnabled` resta `false`.

## Completezza della nightly

La sincronizzazione e fail-closed per ogni coppia campionato-stagione della
finestra corrente: un errore, un CSV assente/vuoto o anche una sola riga non
abbinata ai match Understat produce HTTP 502 e fa fallire la CI. I riepiloghi
espongono conteggi, ultima data della fonte, ultima data abbinata ed errore
puntuale. Lo script tenta comunque tutti i gate dati indipendenti, aggrega gli
errori e poi blocca scommesse automatiche e learning se gli input sono
incompleti.

Per le seconde divisioni, le stagioni storiche complete vengono riscaricate
solo per riconoscere squadre divenute note nel frattempo. Le scritture vengono
saltate quando conteggi e identita sono gia completi; altrimenti sono eseguite
in batch libSQL da 100 statement. Il marker stagionale viene aggiornato per
ultimo, cosi un blocco parzialmente fallito viene ripreso dalla nightly
successiva invece di apparire completo.
