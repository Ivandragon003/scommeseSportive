# Nightly: quote e recupero tecnico — 31 ottobre 2026

**Stato: correzione verificata localmente; recupero non ancora avviato.** Le 18 partite
individuate sono fonti da rivalutare, non nuove puntate già registrate.
Tutte le operazioni descritte riguardano portafogli virtuali.

## Diagnosi verificata

Le email di errore riguardano la [Nightly primaria `41184228627`](https://github.com/Ivandragon003/scommeseSportive/actions/runs/41184228627),
il [tentativo `41189187732`](https://github.com/Ivandragon003/scommeseSportive/actions/runs/41189187732)
e il [run successivo `41192970968`](https://github.com/Ivandragon003/scommeseSportive/actions/runs/41192970968).
Anche le segnalazioni dei watchdog corrispondono a problemi effettivi.

Le letture in produzione hanno trovato 22 partite e 44 decisioni finali
nella giornata: quattro puntate finanziate, 36 astensioni tecniche sulle
18 partite e quattro altre astensioni già registrate. In tutte le 18 coppie
A/C il motivo è `odds_credit_budget_exhausted`. I relativi vecchi job di
esecuzione risultano `COMPLETED`: ripetere la normale Nightly li considera
già elaborati e non recupera quelle quote.

L'ultimo run riporta due partite analizzate, zero nuove puntate e 20 partite
già registrate. Questo contatore del singolo run non annulla le quattro
puntate presenti nell'archivio della giornata.

Policy sorgente:
`9a7a37f15c51ed819b74dba7faae90bf51d77c02c9ad1614023ba12d40ebbe33`.

Le quattro puntate già finanziate sono state registrate alle 09:40 UTC
(10:40 a Roma). Tutte hanno kickoff alle 14:30 UTC, cioè 15:30 a Roma.

| Modello | Partita | Mercato | Quota | Stake virtuale |
| --- | --- | --- | ---: | ---: |
| A | Augsburg–Freiburg | Over 3,5 gol | 2,25 | 22,03 euro |
| A | Leverkusen–Stuttgart | Over 3,5 gol | 1,85 | 20,42 euro |
| C | Werder–Hoffenheim | Under 2,5 gol | 3,00 | 10,14 euro |
| C | Leverkusen–Stuttgart | Under 2,5 gol | 3,51 | 10,14 euro |

La chiamata opzionale `/predictions/settle-completed` ha restituito HTTP 400
con `fetch failed`: è un avviso del percorso di archivio. Le liquidazioni
wallet e research hanno risposto HTTP 200. Quell'avviso non dimostra una
perdita di fondi o l'assenza delle quattro puntate.

## Crediti e configurazione

I probe di `/sports` non hanno consumato crediti; gli header hanno rilevato:

| Account | Rilevazione UTC del 31 ottobre | Usati | Residui | Costo probe |
| --- | --- | ---: | ---: | ---: |
| Precedente | 11:09:31 | 498 | 2 | 0 |
| Personale già attivo, fornito dall'utente | 11:19:31 | 0 | 500 | 0 |

L'utente ha verificato il secondo account nella dashboard ufficiale. La
chiave è stata configurata nel file locale `.env` e nel secret GitHub
`ODDS_API_KEY`, senza pubblicarla. Lo scope
`ODDS_API_ACCOUNT_SCOPE`, con etichetta `daniele-oddsapi-20261031`, identifica il relativo
budget; il supporto nel codice esiste già, mentre il passaggio della
variabile nel workflow fa parte della correzione da verificare.

Il precedente budget e le osservazioni storiche restano integri. Il nuovo
scope separa contatori di account reali: non azzera artificialmente la quota
del precedente account.

La [FAQ ufficiale](https://the-odds-api.com/manage/faqs.html) indica il reset
mensile il primo giorno del mese; la dashboard specifica 00:00 UTC. Cambiare
chiave nello stesso account non ricarica i crediti. Non sono stati aggiunti
provider a pagamento né una procedura che crea automaticamente nuovi
account gratuiti quando il budget termina.

## Correzione e limiti del recupero

La correzione in verifica lascia in `ERROR`, con causa e conteggio degli
errori, i nuovi job in cui entrambi i motori si astengono soltanto per un
blocco tecnico delle quote, prima di congelare input e decisioni di
esecuzione definitivi. Le astensioni sportive restano decisioni valide.

Per i vecchi job già conclusi, il piano aggiunge una policy di recupero
collegata alla sorgente e conserva input, decisioni, puntate e movimenti
precedenti. Il piano iniziale riguarda soltanto le 18 coppie tecniche ed
esclude le altre quattro partite, preservando ogni puntata e scelta sportiva
esistente. Il comando `recover-recommendation-technical.js plan` effettua
letture SELECT limitate, verifica le identità e salva un nuovo JSON con
impronta, senza registrare policy o puntate nel database.

La protezione contro recuperi ripetuti controlla tutti i figli della stessa
fonte, anche quando cambia il gruppo di partite. Un recupero concluso,
saltato, con input salvato o con lease ancora attiva impedisce un nuovo
tentativo sulla medesima fonte. Un errore senza input, o una lease scaduta
senza input, può essere riprovato. Collector, helper e controllo atomico nel registro hanno superato insieme i test mirati; la revisione finale ha verificato anche il conflitto fra pianificazione e commit.

Il recupero deve ricalcolare i consigli dei due motori con quote vere e
fresche, prima del kickoff e con i limiti di capitale ed esposizione attivi.
A mantiene il proprio stake; C conserva l'1% e l'esposizione massima resta
il 5% per portafoglio. Nessuna previsione viene retrodatata e nessuna partita
già iniziata può essere recuperata. Anche una rivalutazione riuscita può
produrre un'astensione per scelta sportiva, quote indisponibili o capitale.

A conserva il proprio motore e i mercati supportati; C906 rimane il modello
C attivo, senza adozione di candidati. Non vengono inviate giocate reali ai
bookmaker. Riferimento: [esecuzione dei consigli A/C](recommendation-execution-2026-10-30.md).

## Evidenze e completamento pendente

È stata conservata una copia privata mirata di 22 job, 22 input, 44 decisioni,
10 puntate complessive, sei liquidazioni, 18 movimenti, due policy e 258
giocate legacy. È una copia delle righe interessate, non un backup completo
del database.

Dopo tutte le correzioni sono riusciti **143 test Node mirati**, build, typecheck e lint backend. I **63 sorgenti A e condivisi, insieme ai cinque file di fixture e regressione**, restano invariati; passano le sette regressioni A. Il recupero è disattivato per default e il piano reale in sola lettura conferma 18 fonti ammissibili, 36 decisioni sorgenti e quattro esclusioni. La revisione finale non rileva ulteriori blocchi.

| Verifica finale | Stato di questo rapporto |
| --- | --- |
| Test e revisione della correzione completa | 143 test mirati, build, typecheck e lint PASS; CI in attesa di pubblicazione |
| ID e risultato dell'esecuzione reale di recupero virtuale | Non ancora avviata |
| Nuove decisioni, eventuali puntate e astensioni | Da rilevare dopo l'esecuzione |
| Saldi e impronte delle righe protette prima/dopo | Da confrontare dopo l'esecuzione |

Non viene ancora dichiarato un recupero riuscito o un numero di nuove
puntate. Gli esiti operativi devono aggiornare questa sezione mantenendo
distinte le 18 fonti iniziali dalle puntate effettivamente finanziate.
