# Verifica e pulizia del client portafogli — 1 novembre 2026

## Ambito

Integrate le modifiche utili precedentemente locali a `walletApi.ts` e il nuovo
`walletApi.test.ts`. Il client legge i portafogli A/C e le giocate già registrate:
non registra puntate, non liquida esiti e non aggiorna i modelli.
Nessuna modifica al backend, al metodo A operativo, a C o ai dati.

## Scelte e pulizia

- Conservata la validazione delle risposte prima del rendering: contenitori,
  conteggi, importi in centesimi, quote, identità dei portafogli e metadati usati
  direttamente dalla UI. I campi opzionali null o mancanti restano indisponibili;
  non vengono sostituiti con fondi o risultati inventati.
- Rifiutati saldi non numerici, conteggi incoerenti, quote non finite e oggetti
  al posto di nomi leggibili. Saldi mancanti, metadati null, ledger vuoti e
  profitti negativi delle liquidazioni parziali restano accettati.
- Rimosso il fallback locale mai distribuito verso `/research/comparison`:
  il client usa esclusivamente `/wallets`, presente nel backend attuale.
  Un 404 o errore di rete resta visibile, senza una seconda chiamata silenziosa.
  La route research resta disponibile per i suoi consumatori.
- Rimossa la riscrittura locale dell'etichetta del periodo: il backend la
  fornisce già tramite `AppWalletService`; le etichette vengono conservate.
- Rimossi nove import predefiniti React inutilizzati. Il compilatore con
  `noUnusedLocals` e `noUnusedParameters` e la ricerca dei riferimenti confermano
  che non servono con `jsx: react-jsx`. Gli hook e i tipi ancora usati restano.

Non sono state individuate altre rimozioni certe di componenti o dipendenze:
assenza di chiamanti interni non dimostra che una route pubblica sia inutilizzata.
I report e gli APK precedenti restano artefatti storici dei rispettivi commit.

## Verifiche

La revisione indipendente ha verificato compatibilità con il contratto backend
e i consumatori frontend. I test controllano conservazione di quote, stake,
saldi, periodi e identità; errori e annullamento non avviano altre richieste.
Gate locale completato: **401/401 test frontend su 38 suite**, build di produzione,
lint e TypeScript con `--noUnusedLocals --noUnusedParameters` riusciti.
La risposta autenticata delle 17:06:48 UTC, conservata localmente dal precedente
controllo in produzione, viene accettata e restituita senza modificare le sue
24 giocate: verifica offline, senza nuove chiamate al servizio o scritture.
Il diff del backend è vuoto. Nessuna dipendenza aggiunta o rimossa.

## Distribuzione

Questo intervento pubblica sorgenti, test e documentazione su GitHub.
Non comprende deploy, nuove esecuzioni Nightly o un nuovo APK. Il sito e
l'APK 1.1.8 già distribuiti restano riferiti al commit `5fd5d7b2`.
La successiva [release Android 1.1.9](../android/releases/1.1.9-2026-11-01.md)
include questa pulizia; il suo report distingue i controlli del pacchetto e
la prova di aggiornamento dai controlli del presente intervento.
