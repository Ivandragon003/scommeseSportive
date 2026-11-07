# Modelli A e C

Le guide descrivono i percorsi implementati. I default del repository non sono una verifica della configurazione, del registro modelli o delle prestazioni remote.

| Guida | Responsabilità |
|---|---|
| [A operativo](MODEL-A.md) | Dati, probabilità, calibrazione, mercati e consiglio di PredictionService |
| [C](MODEL-C.md) | Baseline research, CatBoost, distribuzione dei gol, selettori e adozione |
| [Architettura](../SYSTEM-DESIGN.md) | App, API, dati, contabilità e separazione dei processi |
| [Formulario](../FORMULARIO-sistema-scommesse.md) | Formule e parametri del sistema |
| [Scelte scartate](../FORMULARIO-scelte-scartate.md) | Decisioni sperimentali e motivi per non ripetere tentativi già valutati |
| [Research](../research-platform.md) | Procedure di training, confronto e raccolta di evidenza |
| [Nightly](../github-actions-nightly-sync.md) | Procedura del job finito e configurazione dell'automazione |

A operativo è `PredictionService`, con identità `APP-A-…`. C usa una baseline research fissata, A80: le metriche di questa baseline non sono quelle dell'intero A operativo. Ogni motore può consigliare una giocata squadra per partita oppure astenersi; non c'è un terzo modello che scelga fra A e C.

Il default C906 riusa motore value e picker canonico con le proprie probabilità. Il selettore candidato `payout-aware-v1` è implementato separatamente: non diventa operativo per la sola presenza del codice. Il deployment C viene risolto dal registro di adozione e congelato per l'esecuzione.

Calcolo, presentazione del consiglio, registrazione virtuale e valutazione sono responsabilità distinte. Le modifiche documentali e le procedure di ricerca C non autorizzano modifiche al motore A. Pacchetti già registrati, identità dei modelli e risultati storici conservano il proprio significato; un nuovo calcolo non li trasforma in previsioni precedenti al risultato.

La Nightly usa `funded-confidence-v1`: per ogni selezione qualificata LOW 1%, MEDIUM 3%, HIGH 5% del saldo disponibile iniziale del gruppo, nei portafogli A/C esistenti e separati. Il saldo finanzia importi completi, senza tetto cumulativo del 5% o limite di una giocata per partita. Le azioni manuali confermate usano l'importo scelto dall'utente, con controlli server sul saldo e sui duplicati. Nessuno dei due percorsi invia denaro o puntate ai bookmaker. Dettagli nella [guida operativa](../operations/README.md).
