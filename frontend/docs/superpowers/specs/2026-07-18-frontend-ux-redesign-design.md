# Frontend UX Redesign — Design Specification

## Obiettivo

Riprogettare esclusivamente il frontend di FootPredictor per rendere immediata la consultazione di partite, pronostico unico, quota Eurobet e bankroll, mantenendo accessibili gli approfondimenti per utenti esperti. Il backend, i contratti API, i dati e i calcoli restano invariati.

## Vincoli di prodotto

- Understat resta la fonte primaria dei dati calcistici.
- football-data.co.uk resta la fonte supplementare non distruttiva per falli, corner, tiri, cartellini e arbitro.
- Le quote mostrate e azionabili dall'utente sono esclusivamente quote Eurobet; fallback e quote sintetiche restano interni.
- Ogni partita espone una sola giocata finale sui mercati squadra. Le player props restano in una sezione distinta.
- Learning review, tuning adattivo e diagnostica interna non sono contenuti per l'utente finale.
- Nessun file backend, endpoint, payload, modello dati o algoritmo viene modificato.

## Direzione visiva

Il prodotto adotta il linguaggio di una scheda decisionale sportiva professionale: superfici chiare, righe sottili, tipografia leggibile e dati allineati. La singola raccomandazione è il tratto distintivo: un referto con bordo verticale verde campo che separa decisione, motivazione, rischio e puntata.

### Token

- `paper`: `#f4f6f3`
- `surface`: `#ffffff`
- `ink`: `#17231f`
- `muted`: `#596761`
- `field`: `#1f6b4f`
- `amber`: `#8a5b13`
- `danger`: `#a83b32`
- bordi: `#d7ddd9`
- raggi: 4–10px, senza pillole decorative
- ombre: solo per overlay e dialog, non per ogni contenitore

La tipografia usa font di sistema per evitare dipendenze esterne: `Aptos`/`Segoe UI` per testo e `Consolas` per dati compatti. Non vengono usati gradienti, glow, glassmorphism o animazioni decorative.

## Architettura frontend

### Shell e navigazione

La shell separa:

- Analisi: Previsioni, Budget, Glossario.
- Strumenti avanzati: Backtesting, Dati, Dati e Provider.

Il glossario è raggiungibile dalla navigazione, da un comando rapido nell'header e dai termini contestuali. La navigazione mobile mantiene Previsioni, Budget e Glossario come azioni primarie.

### Glossario

Il glossario è un modulo frontend autonomo:

- catalogo tipizzato delle definizioni;
- pagina con ricerca, categorie e indice alfabetico;
- drawer globale con ricerca rapida;
- componente contestuale riutilizzabile per tooltip accessibile e apertura del drawer.

Ogni voce contiene definizione semplice, spiegazione tecnica, formula quando utile, esempio, significato di valori alti e bassi, lettura positiva e negativa, cautela, termini correlati e categoria. Il catalogo copre tutti i termini richiesti nella specifica e quelli realmente presenti nell'interfaccia.

### Previsioni

Il flusso è:

1. selezione partita;
2. referto decisionale con giocata unica o motivazione dell'assenza;
3. quota Eurobet, probabilità stimata, affidabilità e puntata suggerita;
4. motivi e rischi;
5. dettagli progressivi in tab.

EV, edge, Kelly, lambda e diagnostica del ranking non compaiono nel referto primario. Le quote fallback non sono mostrate né azionabili. La modalità replay resta focalizzata su pronostico, risultato ed esito.

### Budget

Il riepilogo distingue esplicitamente:

- bankroll iniziale;
- bankroll disponibile;
- capitale esposto in scommesse pendenti;
- totale puntato storico;
- ritorni;
- profitto netto;
- ROI con interpretazione prudente e dimensione del campione;
- vinte, perse, void e pendenti.

La manutenzione distruttiva è separata dal flusso operativo.

### Backtesting

Configurazione, esecuzione, risultati, interpretazione, archivio e manutenzione diventano blocchi distinti. Tutte le etichette sono italiane; i termini internazionali necessari restano nel glossario. Parametri, limiti del campione, uso di quote sintetiche, overfitting e CLV sono spiegati contestualmente.

### Dati e Provider

Le pagine avanzate sono operative e non promozionali. Mostrano fonte, ruolo, stato, freschezza, ultimo aggiornamento, copertura, errori e conseguenze delle operazioni.

Il frontend rimuove ogni riferimento a SofaScore e usa il contratto esistente `/scraper/football-data` per l'integrazione supplementare. La UI distingue chiaramente Understat primaria, football-data supplementare e provider quote; indica che soltanto le quote Eurobet sono eleggibili lato utente.

## Stati e accessibilità

- caricamento, successo, avviso, errore, dati parziali e stati vuoti hanno testo operativo;
- focus visibile, label associate, pulsanti semantici e dialog con focus gestito;
- i tooltip sono attivabili da tastiera;
- il colore non è l'unico indicatore;
- tabelle e pannelli restano consultabili sotto 900px con overflow controllato;
- `prefers-reduced-motion` disattiva transizioni non essenziali.

## Strategia di test

- test di shell per gerarchia della navigazione, route Glossario e drawer;
- test del catalogo e delle tre modalità di accesso al glossario;
- test delle quote Eurobet-only e assenza di fallback in Previsioni;
- test del referto decisionale e dello stato senza giocata;
- test del riepilogo Budget e dell'interpretazione ROI;
- test delle etichette italiane di Backtesting;
- test dell'integrazione football-data e assenza SofaScore;
- typecheck, lint, suite completa, build, build/test backend come verifica di non regressione;
- Docker build e healthcheck;
- verifica browser desktop e viewport stretta con controllo console.

## Criterio di completamento

Il lavoro è completo solo quando tutti i requisiti del prompt sono coperti da codice e test, i controlli finali sono verdi, il comportamento è verificato nel browser e `git diff -- backend` è vuoto.
