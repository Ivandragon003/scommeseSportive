# Baseline di regressione del solo A operativo

Snapshot: `a474e36cee8372d4e214c704effdb92b488f9242`, catturato prima delle
modifiche successive al modello C. Non aggiornare questi valori per fare
passare una modifica di C: una variazione di A richiede una decisione esplicita.

`source-manifest.json` conserva SHA256 del contenuto letto con `git show`
dallo snapshot indicato, normalizzando CRLF in LF. Prima della cattura dei
golden è stata verificata l'identità dei 36 sorgenti correnti con quei blob.
Il manifest protegge modelli, configurazione, utility e servizi importanti
di previsione, selezione e quote A. Non congela il database o i file research
di C, che possono evolvere separatamente.

`authorized-source-deviations.json` registra separatamente le sole modifiche
autorizzate successive: correzione degli xG mancanti in DC, Poisson e contesto
(`0ecda0a26097d6b73027f4b053194ec68b599b6e`), osservatori Fase 4
(`028a041d4788c7afb3383f602fe2fc5f5d7cf14b`) e cattura opzionale degli input
Fase 4 rivista nel task corrente, inclusa l'osservazione aggiuntiva dei
timestamp locali già presenti nelle righe, gli identificativi/hash delle fonti
consumate e il riscontro opzionale di consegna del recorder per il collector
indipendente. Il callback è protetto: un errore dell'osservatore non cambia
il risultato di `predict`. Protocollo, manifest e claim identificano la raccolta,
senza entrare nei calcoli statistici.
La successiva deviazione osservativa conserva ID e data dei parametri già
letti, l'impronta degli argomenti di un fit effettivo e i controlli rispetto
a inputAsOf. Ogni hunk viene annullato esattamente dal test prima degli hash
originali; non sono rigenerati manifest o golden numerici.
Questi timestamp non diventano date di pubblicazione del provider.
La deviazione `missing-market-observations-v1` registra la correzione autorizzata
dei dati mancanti in tiri/SOT e gialli/rossi: campioni per campo, astensione
su esiti assenti e disponibilità delle famiglie anche nel payload strutturato.
Non modifica coefficienti, golden numerici, manifest sorgente originale o
snapshot C. I suoi blocchi esatti vengono annullati prima delle deviazioni
precedenti; prove di mutazione rifiutano anche la loro rimozione o duplicazione.
La deviazione `identity-only-player-eligibility-v1` registra il successivo filtro
degli input giocatore privi di osservazioni: titolarità esplicita per partita,
squadra e as-of, senza cambiare il prior dei casi ammessi o le formule.
La normalizzazione dell'alias Goalkeeper resta nell'adattatore del contesto.
Anche questi blocchi sono reversibili esattamente; manifest e golden restano intatti.
L'identità APP-A cambia e richiede un nuovo protocollo/manifest prima del pilot,
con collector e recorder ancora spenti. Il contratto corrente è in
[`docs/data-observation-contract.md`](../../../../docs/data-observation-contract.md).
Ogni blocco conserva prima/dopo esatti,
contesto e motivo; i blocchi storici provengono dai relativi diff Git.
Il test richiede una sola occorrenza di ogni blocco e annulla queste sole
sostituzioni in memoria prima di verificare gli hash pre-C. Non consente
modifiche ulteriori né il ritorno a una versione precedente delle correzioni.
Prove di mutazione verificano questi rifiuti. Un caso semantico separato
verifica il fallback xG su entrambi i lati, inclusi spazi e zero reale;
`xg-blend-fit.test.js`, `ensemble-xg.test.js` e
`prediction-context-builder.test.js` coprono gli altri confini della correzione.
Questo garantisce le sole deviazioni autorizzate, non l'identità assoluta con
la vecchia baseline di ricerca C. Manifest, golden e identità della ricerca
restano immutabili; la fixture non modifica alcun hash usato dal runtime C.

`expected.json` contiene output catturati dal vero `PredictionService.predict`
prima del cambiamento C. Ogni scenario è stato eseguito due volte e i
risultati sono stati confrontati prima di salvare la baseline. Le fixture
usano soltanto oggetti in memoria: **nessuna partita o quota rappresenta
un'osservazione reale**, e il nome bookmaker contiene `[TEST ONLY]`.
La stringa tecnica `odds_api` serve solo a esercitare il normale contratto
di ammissione del motore, senza contattare il provider.

La fixture carica i default espliciti delle variabili del modello, blocca clock
e seme pseudocasuale; ripristina le variabili d'ambiente, clock e random
d'ambiente modificate alla fine di ogni caso. Fornisce curve storiche congelate,
anche non identità, al confine del caricamento della calibrazione. Restano reali
contesto, DC, partner Poisson-xG, modelli statistici, bootstrap, tuning da review,
applicazione della calibrazione, blending, filtri, ranking, stake e picker.
I numeri sono confrontati dopo arrotondamento a dieci cifre decimali.
Gli hash runtime di codice/stato/versione vengono esclusi dal confronto
comportamentale; gli hash sorgente sono verificati separatamente.

Scenari: listino completo, soli tiri/cartellini, consiglio principale sui
cartellini, storico e calibrazione deboli, assenza del partner Poisson,
assenza di quote. I golden includono catalogo raw, curve fornite, tuning,
probabilità finali, opportunità accettate/speculative, diagnostica filtri,
scelta spiegata e pacchetto canonico con ordine, confidenza e stake.

Per ripetere il controllo, dopo la build ordinaria del backend:

```powershell
node --test test/operational-a-regression.test.js
```

Il test non misura redditività, non ricostruisce il fit storico delle curve
fornite, non copre gli input possibili in modo esaustivo e mantiene le player
props disabilitate. Non dimostra che le quote siano disponibili nel deploy o
che un servizio esterno sia raggiungibile. Il blocco sorgente protegge anche
componenti di quei percorsi non esercitati dai sei casi.
