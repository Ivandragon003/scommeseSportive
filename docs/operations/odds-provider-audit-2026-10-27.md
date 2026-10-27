# Audit dei provider quote — 27 ottobre 2026

## Perimetro e risultato

Sono stati letti codice e documentazione pubblica ufficiale. Nessun account è
stato creato, nessuna chiave è stata trasferita, nessuna richiesta di quote con
consumo di crediti è stata eseguita. Disponibilità pubblicizzata, accesso con
una determinata chiave e copertura effettiva sono verifiche diverse.

Il provider integrato resta **The Odds API, dominio `the-odds-api.com`**,
con host `api.the-odds-api.com/v4`. Il
[runtime configurato](../../backend/src/services/odds-provider/providerRuntimeConfig.ts)
non ha un secondo provider attivo. Cambiare una stringa di configurazione
non implementa un nuovo adattatore.

Non è stata trovata una soluzione già attivabile gratuitamente che dimostri
insieme copertura dei cinque campionati, Eurobet, freschezza entro cinque
minuti e capacità sufficiente per tutte le automazioni. Questo non prova
che nessuna soluzione possa esistere: indica il limite delle evidenze raccolte.

## Identità dei servizi e domini simili

`odss-api` è un nome ambiguo/refuso, non identifica un contratto da integrare.
`the-odds-api.com`, `odds-api.io` e `odds-api.net` non sono intercambiabili.

Il provider originale pubblica inoltre un
[avviso specifico](https://the-odds-api.com/impersonation-warning.html)
su `theoddsapi.com`, senza trattini: lo identifica come sito impersonatore e
rivenditore non autorizzato. Non considerare il nome simile una continuità
del servizio e non inviare a quel dominio la chiave già configurata.
Le sue promesse commerciali non costituiscono un fallback autorizzato per
FootPredictor.

## Costi documentati di The Odds API

Secondo la [documentazione V4](https://the-odds-api.com/liveapi/guides/v4/):

| Endpoint | Costo documentato |
|---|---|
| `GET /sports` | 0 crediti |
| `GET /sports/{sport}/events` | 0; solo eventi, senza quote |
| `GET /sports/{sport}/odds` | mercati **richiesti** × regioni |
| `GET /sports/{sport}/events/{id}/odds` | mercati distinti **restituiti** × regioni |
| `GET /sports/{sport}/events/{id}/markets` | 1 credito |
| `GET /sports/{sport}/scores` | 1; 2 quando viene specificato `daysFrom` |

Con `bookmakers`, ogni blocco di dieci operatori sostituisce una regione:
1–10 conta uno, 11–20 conta due. La lista bookmaker prevale su `regions`.
Una risposta quote senza dati non consuma crediti; ciò non rende gratuiti
retry che restituiscono dati. Il costo osservato va letto da
`x-requests-last`, insieme a `x-requests-used` e `x-requests-remaining`.

La distinzione fra mercati richiesti e restituiti evita di sottostimare il
bulk `/odds`. Il suo limite non dipende dal numero di partite nella risposta.
`last_update` a livello mercato descrive l'ultima osservazione del mercato;
quello a livello bookmaker è deprecato. Non sostituirlo con l'ora del fetch.

### Piano gratuito e reset

Il [listino ufficiale](https://the-odds-api.com/) pubblicizza Starter gratuito
con **500 crediti mensili**; lo storico non è incluso. Questo non certifica
il piano o il residuo della chiave dell'utente, non interrogata in questo audit.

La [FAQ ufficiale](https://the-odds-api.com/manage/faqs.html) conferma il reset
il primo giorno di ogni mese. Non specifica in quella risposta l'ora esatta
o il fuso. **Il reset alle 00:00 UTC non è stato confermato nelle pagine
primarie lette**: non attribuirlo al provider come garanzia. Un eventuale
rollover contabile locale in UTC deve restare un'ipotesi conservativa,
riconciliata con i nuovi header ricevuti, non una ricarica presunta.

Gli [endpoint storici](https://the-odds-api.com/historical-odds-data/)
richiedono un piano a pagamento. Non sono stati attivati o interrogati.

I [termini ufficiali](https://the-odds-api.com/terms-and-conditions.html),
aggiornati il 31 agosto 2026, consentono conservazione, dashboard, ricerca e
training statistico/ML; vietano la rivendita come feed di dati grezzi. Il
provider dichiara acquisizione da fonti pubbliche e interfacce autorizzate,
senza garanzia di precisione o puntualità. Queste condizioni supportano
l'uso personale previsto, senza garantire la copertura di ogni mercato.

### Eurobet

Nel [catalogo bookmaker ufficiale](https://the-odds-api.com/sports-odds-data/bookmaker-apis.html)
letto il 27 ottobre non compare Eurobet. La sua presenza negli snapshot
legacy non dimostra copertura attuale. Non inviare una chiave bookmaker
inventata né attribuire a Eurobet una quota di un altro operatore.

La priorità Eurobet resta applicabile quando compare davvero nel payload
con una partizione completa e fresca. La sua assenza richiede un altro
bookmaker reale oppure astensione, conservando il nome effettivo.

## Budget: calcoli di capacità, non consumo misurato

Questi esempi derivano dalla formula pubblicata e non sono misure della chiave:

- Cinque leghe × tre mercati × una regione = **15 crediti** per raccolta bulk
  completa, quando tutte le risposte contengono dati.
- Una raccolta simile ogni notte per 31 giorni = **465 crediti**, lasciandone
  teoricamente 35 su un piano da 500, prima di T−15, UI e retry.
- Cinque leghe × un solo mercato × 31 giorni = **155 crediti**, con scope
  ridotto. Il prezzo di un mercato non richiesto resta indisponibile.
- Due modelli sulla stessa partita devono condividere una raccolta. Due
  inferenze non richiedono due richieste quote.

Controllare i job ogni 15 secondi non richiede interrogare il provider ogni
15 secondi. La raccolta può essere una sola per coorte di kickoff e lega,
con cache breve condivisa. L'eventuale disattivazione delle quote notturne
va distinta dalla manutenzione dei risultati: la prima non giustifica
spegnere sincronizzazione o liquidazione.

Un numero come “855 richieste/crediti” non va attribuito automaticamente a
un solo componente, al mese corrente o al piano gratuito: servono periodo,
endpoint, parametri, `x-requests-last` e contatori del medesimo account.
Il call graph e il registro di consumo devono spiegare la somma osservata.

## Alternative verificate documentalmente

| Servizio | Offerta e limite rilevanti | Stato per FootPredictor |
|---|---|---|
| `odds-api.io` | La [pagina Free](https://odds-api.io/pricing/free) dichiara sospese a tempo indeterminato le nuove chiavi gratuite; le vecchie mantengono 100 richieste/ora e 500/giorno su due bookmaker ricreativi | Non attivabile gratuitamente per un nuovo account nell'audit |
| `odds-api.io`, Eurobet IT | La [pagina dedicata](https://odds-api.io/sportsbooks/eurobet-it) pubblicizza Eurobet IT e ammette che il servizio è indipendente dall'operatore | Copertura pubblicizzata; accesso effettivo e diritti non verificati con una chiave |
| `odds-api.net` | Il [listino](https://odds-api.net/pricing) parte da Starter 50 USD/mese | Non è una soluzione gratuita; nessun piano attivato |
| TheRundown | La [pagina calcio](https://therundown.io/soccer-odds-api) include le cinque leghe principali; il [piano Free](https://therundown.io/free-sports-data-api) offre tre bookmaker USA, 20.000 data point/giorno e 200.000/mese, quote prepartita ritardate di cinque minuti | Accesso gratuito pubblicizzato per nuovi account, ma ritardo e condizioni di conservazione/validazione sotto riportate impediscono di dichiararlo pronto per il benchmark |
| API-Football | Il [listino](https://www.api-football.com/pricing) include quote e 100 richieste/giorno; la [guida ufficiale](https://www.api-football.com/news/post/how-to-get-started-with-api-football-the-complete-beginners-guide) descrive aggiornamenti prepartita ogni tre ore e storico limitato | Incompatibilità documentale con una garanzia di freschezza entro cinque minuti; accesso alla stagione corrente non verificato; integrazione quote non presente |

La pagina Eurobet di `odds-api.io` contiene ancora inviti al free trial e
affermazioni sull'emissione gratuita della chiave. Sono in contrasto con
la pagina specifica Free e il listino aggiornato: non trattarli come
disponibilità verificata. Anche un'eventuale vecchia chiave gratuita richiederebbe
controllo di bookmaker realmente abilitati, timestamp, quota residua e condizioni
d'uso; non è sufficiente copiare il payload di esempio.

TheRundown misura **data point**, non richieste o crediti The Odds API.
Il ritardo pubblicizzato di cinque minuti consuma già l'intero margine di
freschezza di 300 secondi: età originaria del prezzo, trasporto e latenza
applicativa possono superarlo. Questa è un'inferenza dai limiti pubblicati,
non una misura di latenza. Il candidato non soddisfa quindi automaticamente
il gate T−15; non si aumenta silenziosamente la soglia per accettarlo.

### Accesso gratuito e diritti effettivi

I [termini e privacy di TheRundown](https://therundown.io/terms-and-privacy),
aggiornati l'8 settembre 2026, ammettono uso personale/interno per Free e
Starter. Il §3 limita però la conservazione a 24 ore salvo accordo aggiuntivo
e richiede consenso scritto per sviluppare, addestrare o **validare modelli
statistici o ML** con i dati. Anche la [FAQ](https://therundown.io/faq)
richiede permesso scritto per backtest e validazione. Per FootPredictor
questo è un blocco ulteriore alla latenza: una chiave Free da sola non
autorizza l'archivio immutabile e il confronto A/C richiesti. Non è stato
richiesto quel consenso né creato un account.

API-Football pubblicizza tutte le competizioni e gli endpoint nel Free,
ma limita le stagioni disponibili. **Non è stata dimostrata l'abilitazione
2026/27 sulla chiave esistente o su un nuovo account.** La presenza di una
credenziale configurabile non prova disponibilità delle quote né Eurobet.
I [termini API-Football](https://www.api-football.com/terms) dichiarano che
copertura e frequenza di aggiornamento non sono garantite; non concedono
licenze di pubblicazione dei titolari sportivi e vietano rivendita dei dati
e account multipli per aumentare il limite gratuito. Il reset del piano
diretto è giornaliero UTC; quello RapidAPI segue l'orario della sottoscrizione.
Nessuno di questi dettagli supera il limite documentato di aggiornamento
prepartita ogni tre ore.

La verifica è documentale: nessuna chiave è stata usata per sondare stagione,
mercati o latenza, nemmeno per il provider già presente come integrazione
opzionale. Non viene quindi dichiarato operativo un fallback sulla base
del solo catalogo o di una pagina commerciale.

Nessuna di queste pagine prova che Eurobet fornisca gratuitamente a questo
progetto una fonte ufficiale autorizzata. Un catalogo di un aggregatore è
diverso da un'API pubblica dell'operatore.

## Contratto minimo per un eventuale adattatore

Prima dell'attivazione, un nuovo adattatore deve fornire:

1. Identificativo del provider e dell'evento, kickoff UTC e stato dell'incontro.
2. Bookmaker effettivo, mercato, selezione, linea e quota decimale reale.
3. `capturedAt` del fetch e `updatedAt` originario del mercato separati;
   assenza del secondo dato significa freschezza non provata.
4. Quote mancanti, sospese o ritardate come stati espliciti, senza completamenti.
5. Costo richiesto/osservato, residuo, periodo e unità di fatturazione originali.
6. Errori distinguibili per timeout, quota esaurita, autenticazione e mercato
   non supportato; niente retry continuo dopo esaurimento dei crediti.
7. Una raccolta condivisa per A/C, matching non ambiguo, test di parità del
   settlement e test di rifiuto oltre cinque minuti.

Con l'autorizzazione e una chiave separata si potrà verificare un campione
Top5, misurare latenza, copertura e consumo senza registrare giocate. Solo
una prova positiva consente di considerare il fallback operativamente
disponibile. Fino ad allora il sistema deve mostrare l'indisponibilità
e saltare la decisione, non utilizzare prezzi inventati o un piano a pagamento.

## Decisione operativa proposta

Mantenere The Odds API esistente con budget persistente, raccolte condivise e
priorità ai job realmente dovuti. Prima della pubblicazione, misurare una
configurazione che riservi quota a T−15 e riduca le raccolte non necessarie.
I limiti iniziali di 15 secondi, 60 secondi e cinque minuti rimangono invariati.
Nessun fallback gratuito è stato attivato e nessuna copertura Eurobet è stata
dichiarata garantita. Eventuali credenziali, nuovi account e pubblicazione
richiedono autorizzazione esplicita.
