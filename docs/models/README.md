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

A operativo è `PredictionService`, con identità `APP-A-…`. C usa una baseline statistica cronologica costruita con i componenti correnti di A, ma non riproduce l’intero stato e percorso di `PredictionService`. Le sue metriche non misurano tutto A operativo. Ogni motore può consigliare una giocata squadra per partita oppure astenersi; non c'è un terzo modello che scelga fra A e C.

La release C corrente `C-271c9573ba485956` usa la proiezione delle foglie basata sui supporti del training e riusa motore value e picker canonico con le proprie probabilità; la sua presenza nel repository non dimostra registrazione, deployment o uso remoto. Il selettore `payout-aware-v1` resta un percorso distinto per ricerca e policy archiviate; la release corrente usa `canonical-binary-v1`. Il deployment C viene risolto dal registro di adozione e congelato per l'esecuzione. La scelta operativa esplicita non certifica superiorità predittiva; il pacchetto contiene un solo C e gli errori tecnici possono sospenderlo, senza riattivare modelli precedenti.

Calcolo, presentazione del consiglio, registrazione virtuale e valutazione sono responsabilità distinte. Le modifiche documentali e le procedure di ricerca C non autorizzano modifiche al motore A. Pacchetti già registrati, identità dei modelli e risultati storici conservano il proprio significato; un nuovo calcolo non li trasforma in previsioni precedenti al risultato.

La Nightly usa `funded-dynamic-stake-v1`: ciascun modello fornisce la propria percentuale dinamica, applicata al patrimonio iniziale del gruppo del portafoglio A/C esistente e separato. Il saldo disponibile finanzia importi completi, senza tetto cumulativo del 5% o limite di una giocata per partita. La mappa LOW 1% / MEDIUM 3% / HIGH 5% appartiene alla policy precedente. Le azioni manuali confermate usano l'importo scelto dall'utente, con controlli server sul saldo e sui duplicati. Nessuno dei due percorsi invia denaro o puntate ai bookmaker. Dettagli nella [guida operativa](../operations/README.md).
