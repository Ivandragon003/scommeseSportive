"""Render the repository report and its static scientific figure from saved results."""
import argparse
import json
from pathlib import Path

LABELS = {"c_recipe": "C, ricetta invariata riaddestrata", "c_wma": "C + medie pesate", "c_timesfm": "C + TimesFM 2.5"}
METRICS = ("logLoss", "brier", "ece", "accuracy")


def number(value):
    return f"{value:.6f}"


def interval(values):
    return f"[{values[0]:+.6f}; {values[1]:+.6f}]"


def main():
    parser = argparse.ArgumentParser()
    for key in ("summary", "report", "figure"):
        parser.add_argument("--" + key, required=True)
    args = parser.parse_args()
    s = json.loads(Path(args.summary).read_bytes())
    meta, gate = s["featuresMetadata"], s["gate"]
    overall = s["overall"]
    if gate["verdict"] == "better":
        conclusion = "**Verdetto: TimesFM migliore nello sviluppo storico.** Predisporre solo un candidato per una successiva validazione indipendente; nessuna adozione operativa."
    elif gate["verdict"] == "equivalent":
        conclusion = "**Verdetto: TimesFM equivalente entro i margini fissati. NO-GO per l'integrazione.** Il maggior costo non è giustificato da un miglioramento dimostrato."
    elif gate["verdict"] == "worse_against_both":
        conclusion = "**Verdetto: TimesFM peggiore rispetto a entrambe le alternative. NO-GO.** Nessuna integrazione e nessuna candidatura operativa."
    else:
        conclusion = "**Verdetto: nessun vantaggio statisticamente dimostrato, esito inconclusivo. NO-GO.** Nessuna integrazione e nessuna candidatura operativa. Non sarebbe corretto convertire l'assenza di significatività in una prova di equivalenza: i dati non consentono una classificazione inferenziale certa tra migliore, equivalente e peggiore."
    lines = ["# TimesFM 2.5 per il modello ibrido C — esperimento del 3 novembre 2026", "", conclusion, "",
        f"Nel punto stimato TimesFM ha Log Loss {overall['c_timesfm']['logLoss']:.6f}, contro {overall['c_recipe']['logLoss']:.6f} della ricetta C invariata e {overall['c_wma']['logLoss']:.6f} delle medie pesate. Il lieve miglioramento su C e il peggioramento rispetto alle medie non sono robusti. ECE è inferiore, ma da sola non soddisfa il criterio congiunto di beneficio.", "",
        "**A operativo e C operativo restano invariati.** Il confronto è stato realmente eseguito in locale, su CPU, senza API a pagamento, accessi al database, deploy, registrazioni, puntate o aggiornamenti dei pacchetti produttivi.", "",
        "## Cosa viene confrontato", "",
        "C906 autentico è stato creato nel 2026, dopo le stagioni analizzate: il confronto storico rigoroso con quell'artefatto congelato ha **N=0**. Non si retrodata il modello e non si riusa la sua calibrazione futura. Il controllo riproduce invece esattamente la ricetta C906, riaddestrata cronologicamente in ciascun semestre. È un controllo diagnostico, distinto da C operativo e dalla precedente replica depth 3.", "",
        "| Braccio | Feature | Ricetta restante |", "|---|---|---|",
        "| C, ricetta invariata | 40 legacy già esistenti | C906, rifit per semestre |",
        "| C + medie pesate | Stesse 40 + xG/xGA previsti per casa e trasferta | Identica al controllo |",
        "| C + TimesFM | Stesse 40 + gli stessi quattro valori previsti da TimesFM | Identica al controllo |", "",
        "Due regressori CatBoost Poisson, versione 1.2.8, 120 alberi, profondità 5, learning rate 0,05, seed 20261027, due thread. Miscela 25% baseline research A80 e 75% ML, temperatura 0,8. La calibrazione coerente isotonica 1X2 viene ristimata esclusivamente sulla finestra di calibrazione del fold. Nessuna ricerca di iperparametri: la finestra di selezione rimane separata e inutilizzata. A80 research non è A operativo.", "",
        "## Dati e separazione temporale", "",
        "Si riusano i [dati e il piano già pubblicati](c-three-season-backtest-2026-10-31.md): 6.573 righe pulite, storia iniziale 2022/23 e **4.892 stessi target** 2023/24–2025/26. Sono già stati consultati: questa resta evidenza retrospettiva di sviluppo, non un nuovo test indipendente. I 745 ID protetti restano esclusi da tutti i target e dalla storia delle nuove feature. I 22 ID in quarantena restano esclusi da target e storia; la baseline canonica era già stata ricostruita dopo la loro esclusione.", "",
        "| Fold | Training | Selezione | Calibrazione | Test |", "|---|---:|---:|---:|---:|",
        "| 2023/24 luglio–dicembre | 1003 | 410 | 258 | 849 |",
        "| 2023/24 gennaio–giugno | 1793 | 354 | 373 | 898 |",
        "| 2024/25 luglio–dicembre | 2859 | 381 | 178 | 816 |",
        "| 2024/25 gennaio–giugno | 3543 | 327 | 364 | 933 |",
        "| 2025/26 luglio–dicembre | 4615 | 368 | 184 | 801 |",
        "| 2025/26 gennaio–giugno | 5293 | 317 | 358 | 595 |", "",
        "Finestre e ID sono quelli del piano congelato: training espandente, due mesi di selezione, due di calibrazione, poi test semestrale. Le etichette precedenti devono essere disponibili prima dell'inizio della fase seguente. I test dei sei fold sono disgiunti; un risultato può entrare nei fold successivi dopo la sua disponibilità. Il forecast è l'ultimo confine nominale 03:07 Europe/Rome prima del kickoff, con ora legale.", "",
        "Per ciascuna squadra e competizione, le nuove serie contengono soltanto xG e xGA Understat effettivamente presenti e disponibili strettamente prima del forecast. Si applica `max(kickoff + 2 ore, availableAt noto)`. Non si riempiono xG mancanti con i gol. La scala temporale è l'indice delle gare osservabili, attraversa le stagioni e non inventa giorni o partite: pause e copertura incompleta possono ridurne l'informazione.", "",
        "Contesto massimo 64 gare, minimo cinque, orizzonte una gara; le medie esponenziali hanno emivita di cinque gare sugli identici contesti. Per serie più corte, entrambi i bracci usano lo stesso valore legacy già disponibile. Tale fallback e le 40 feature mantengono la semantica della baseline A80, che può includere vecchie partite protette come passato disponibile: le esclusioni aggiuntive non sono una riscrittura di A80. Limiti comuni [0; 8] sulle quattro feature. Nessun aggiustamento scelto dai risultati.", "",
        "## Risultati sulle identiche 4.892 partite", "",
        "| Modello | Log Loss ↓ | Brier ↓ | ECE ↓ | Accuracy ↑ |", "|---|---:|---:|---:|---:|"]
    for arm, label in LABELS.items():
        m = overall[arm]
        lines.append(f"| {label} | {m['logLoss']:.6f} | {m['brier']:.6f} | {m['ece']:.6f} | {100*m['accuracy']:.3f}% |")
    lines += ["", "Log Loss usa il logaritmo naturale; Brier è la somma multiclasse, senza dividere per tre. ECE è top-label in dieci intervalli di ampiezza 0,1; accuracy è la frequenza dell'esito 1X2 più probabile. Sono le probabilità dopo calibrazione. Mancano quote Nightly autentiche ammissibili: nessun market blending con prezzi inventati, ROI o profitto stimato.", "",
              "### Incertezza e vantaggio utile", "",
              "Differenze appaiate **TimesFM meno confronto**; per Log Loss, Brier ed ECE un valore negativo favorisce TimesFM. Bootstrap a blocchi di settimana calendario, 10.000 ricampionamenti, seed 20261103. I quattro confronti primari (due metriche × due alternative) usano IC simultanei 98,75% con Bonferroni, errore familiare nominale 5%. Il criterio fissato localmente prima dell'inferenza richiede tutti gli estremi superiori sotto −0,001, anche con blocchi mobili di quattro settimane, ECE puntuale non peggiore e miglioramento congiunto LL/Brier nelle stesse almeno quattro leghe contro entrambi. La soglia 0,001 è un margine sperimentale assoluto, non una soglia di redditività.", "",
              "| Confronto | Metrica | Delta | IC95% settimanale | IC98,75% settimanale | IC98,75% 4 settimane |", "|---|---|---:|---|---|---|"]
    for ref in ("c_recipe", "c_wma"):
        for metric in METRICS:
            primary = s["primaryBootstrap"]["comparisons"][ref][metric]
            sensitive = s["sensitivityBootstrap"]["comparisons"][ref][metric]
            lines.append(f"| vs {LABELS[ref]} | {metric} | {s['pointDeltasTimesfmMinusComparator'][ref][metric]:+.6f} | {interval(primary['0.95'])} | {interval(primary['0.9875'])} | {interval(sensitive['0.9875'])} |")
    lines += ["", "La correzione familiare riguarda LL/Brier; gli intervalli ECE/accuracy sono descrittivi. Gli IC assoluti al 95% per ogni braccio e metrica e gli intervalli per campionato sono nel [riepilogo numerico](evidence/timesfm-c-2026-11-03/summary.json). Il bootstrap ricalcola ECE a ogni replica e mantiene appaiate le stesse partite. Gli intervalli sono condizionati ai modelli stimati: non includono variazione dovuta a nuovo addestramento o pretraining, né eliminano il riuso esplorativo dello storico. Le leghe sono analisi descrittive, senza una nuova dichiarazione di significatività per sottogruppi.", "",
              "![Differenze e intervalli simultanei](evidence/timesfm-c-2026-11-03/comparison.png)", "",
              f"Criterio di miglioramento settimanale: **{'superato' if gate['primaryImprovement'] else 'non superato'}**; sensibilità a quattro settimane: **{'superata' if gate['sensitivityImprovement'] else 'non superata'}**; ECE non peggiore: **{'sì' if gate['eceNotWorse'] else 'no'}**; leghe con miglioramento congiunto contro entrambe: **{gate['jointImprovingLeagueCount']}/5**. Equivalenza statistica entro ±0,001, verificata con IC90% per entrambe le metriche e alternative: **{'dimostrata' if gate['formalEquivalence'] else 'non dimostrata'}**.", "",
              "### Per campionato", "", "| Campionato | N | Modello | Log Loss | Brier | ECE | Accuracy |", "|---|---:|---|---:|---:|---:|---:|"]
    for league, arms in s["groups"]["competition"].items():
        for arm, label in LABELS.items():
            m = arms[arm]
            lines.append(f"| {league} | {m['n']} | {label} | {m['logLoss']:.6f} | {m['brier']:.6f} | {m['ece']:.6f} | {100*m['accuracy']:.3f}% |")
    lines += ["", "### Per stagione", "", "| Stagione | N | Modello | Log Loss | Brier | ECE | Accuracy |", "|---|---:|---|---:|---:|---:|---:|"]
    for season, arms in s["groups"]["season"].items():
        for arm, label in LABELS.items():
            m = arms[arm]
            lines.append(f"| {season} | {m['n']} | {label} | {m['logLoss']:.6f} | {m['brier']:.6f} | {m['ece']:.6f} | {100*m['accuracy']:.3f}% |")
    lines += ["", "## Costo computazionale misurato", "",
              f"Windows CPU, {meta['logicalCpus']} processori logici; Torch {meta['versions']['torch']}, TimesFM package {meta['versions']['timesfm']}, NumPy {meta['versions']['numpy']}. Inferenza float32, quattro thread, batch 32, normalizzazione, flip invariance, vincolo di positività, senza compilazione Torch, fine-tuning o testa continua dei quantili. Il checkpoint 200M è [Google TimesFM 2.5](https://huggingface.co/google/timesfm-2.5-200m-pytorch/tree/1d952420fba87f3c6dee4f240de0f1a0fbc790e3), revisione `1d952420fba87f3c6dee4f240de0f1a0fbc790e3`.", "",
              f"Sono state inferite **{meta['uniqueSeries']:,} sequenze distinte** per le 6.573 righe di fit/calibrazione/test; {meta['fallbackSides']} coppie squadra-target usano fallback (su 13.146). Costruzione contesti e medie: **{meta['contextBuildSeconds']:.2f} s**; caricamento con primo download: **{meta['modelLoadIncludingDownloadSeconds']:.2f} s**; inferenza TimesFM: **{meta['inferenceSeconds']:.2f} s**. Latenza mediana/p95 del batch: **{meta['batchLatencyMedianSeconds']:.3f}/{meta['batchLatencyP95Seconds']:.3f} s**; picco RSS processo: **{meta['processPeakRssBytes']/2**30:.2f} GiB**. È il costo dell'estrazione storica in batch, non la latenza misurata della Nightly o dell'app. Il tempo di costruzione è condiviso e non è un benchmark isolato delle sole medie.", "",
              "| Braccio, sei fold | Fit | Previsione matrici | Calibrazione e avvio Node |", "|---|---:|---:|---:|"]
    for arm, label in LABELS.items():
        t = [r for r in s["timings"] if r["arm"] == arm]
        totals = [sum(r[k] for r in t) for k in ("fitSeconds", "predictSeconds", "calibrationSecondsIncludingNodeStartup")]
        lines.append(f"| {label} | {totals[0]:.2f} s | {totals[1]:.2f} s | {totals[2]:.2f} s |")
    lines += ["", "Misure di una singola esecuzione locale, senza intervalli per i tempi e senza stima energetica. Il costo TimesFM si aggiunge al resto della pipeline; la lettura delle feature già salvate non lo annulla. Versioni complete nel lock di ricerca, senza modificare i package di produzione.", "",
              "## Licenza, limiti e conferma futura", "",
              "La [model card Google](https://huggingface.co/google/timesfm-2.5-200m-pytorch/blob/1d952420fba87f3c6dee4f240de0f1a0fbc790e3/README.md) e il [pacchetto 2.0.2](https://pypi.org/project/timesfm/2.0.2/) indicano Apache-2.0. Installazione locale Windows/Python 3.12/CPU verificata: nessun account cloud necessario. Non si estende questa verifica ad altri sistemi o alla diversa licenza di TimesFM 3.", "",
              "Il pretraining dichiarato comprende GiftEvalPretrain, Wikimedia fino a novembre 2023, Trends fino a fine 2022 e dati sintetici/augmentati. Non c'è una certificazione per singola serie che escluda sovrapposizioni con lo storico: **contaminazione del pretraining non esclusa**. Il checkpoint è successivo a parte dei test storici. Gli input locali rispettano l'as-of, ma questo non rende il modello disponibile nel passato né la prova indipendente.", "",
              "La disponibilità storica `kickoff + 2 ore` resta un proxy: non prova l'istante di pubblicazione degli xG, le revisioni del provider o l'esattezza indipendente di tutti i kickoff. I conflitti noti sono esclusi; conflitti sconosciuti non sono certificati assenti. Sono limiti condivisi col benchmark precedente.", "",
              "Un eventuale vantaggio storico non autorizzerebbe adozione. Servirebbero un candidato congelato prima degli esiti e nuova evidenza prospettica, secondo le regole esistenti (primi 500 FUTURE_TEST, almeno quattro leghe, quattro mesi e quattro periodi, giudizio unico). Questo esperimento non consuma quel campione e non modifica le sue regole. Un NO-GO storico non dimostra che ogni possibile uso di TimesFM sia inutile: riguarda questa rappresentazione e questa ricetta, senza ricerca successiva sul medesimo test.", "",
              "## Verifiche e riproducibilità", "",
              f"La ricetta C invariata coincide con il benchmark precedente su tutti i 4.892 target: differenza massima **{s['publishedRecipeMaxAbsoluteError']:.3g}** (tolleranza 1e-12). Il primo batch TimesFM ripetuto è identico, differenza massima {meta['repeatBatchMaximumError']}; non si afferma di aver ripetuto tutte le inferenze. Un audit separato controlla tutti i contesti, la derivazione WMA, il collegamento con gli output TimesFM salvati e ricalcola le metriche con l'implementazione standard-library preesistente. Il replay delle metriche ripete integralmente bootstrap e verdetto.", "",
              "I controlli permanenti verificano futuro, confine esatto di disponibilità, target, esclusioni prima dei valori, dati mancanti, fallback simmetrico, WMA manuale, coorti, metriche, bootstrap appaiato e intersezione delle leghe. I sette controlli di regressione A passano, inclusi i sei golden del vero PredictionService e il manifest sorgenti. Il manifest dell'esperimento verifica inoltre che 289 file operativi, package, workflow e trainer preesistente non sono cambiati. Non sono stati necessari avvio Docker o verifiche web: nessun percorso applicativo è stato modificato.", "",
              "[Comandi completi e ambiente](../../backend/ml/experiments/timesfm_xg/README.md). Il [protocollo](../../backend/ml/experiments/timesfm_xg/protocol.json) è stato fissato localmente prima delle nuove inferenze; non è una preregistrazione pubblica antecedente allo studio. [Riepilogo numerico](evidence/timesfm-c-2026-11-03/summary.json), [previsioni individuali](evidence/timesfm-c-2026-11-03/predictions.jsonl.gz), [feature e contesti](evidence/timesfm-c-2026-11-03/README.md), hash e risultati delle verifiche sono pubblicati insieme al report. Le dipendenze e gli strumenti restano nel percorso sperimentale; nessun codice preesistente è diventato inutilizzato da questo esperimento.", ""]
    Path(args.report).write_text("\n".join(lines), encoding="utf-8")

    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    fig, axes = plt.subplots(1, 2, figsize=(10.4, 3.5), layout="constrained")
    for ax, metric, title in zip(axes, ("logLoss", "brier"), ("Log Loss", "Brier")):
        for y, ref in enumerate(("c_recipe", "c_wma")):
            estimate = s["pointDeltasTimesfmMinusComparator"][ref][metric]
            low, high = s["primaryBootstrap"]["comparisons"][ref][metric]["0.9875"]
            ax.plot([low, high], [y, y], color="#175a86", linewidth=2)
            ax.plot(estimate, y, "o", color="#175a86")
            ax.text((low+high)/2, y+.16, f"{estimate:+.6f} [{low:+.6f}, {high:+.6f}]", ha="center", fontsize=8)
        ax.axvline(0, color="#222", linewidth=1)
        ax.axvline(-.001, color="#8b3b28", linestyle="--", linewidth=1, label="Soglia utile −0,001")
        ax.set_yticks([0, 1], ["vs C ricetta", "vs medie pesate"])
        ax.set_ylim(-.5, 1.5)
        ax.set_title(title)
        ax.set_xlabel("Delta TimesFM − confronto (meno è meglio)")
        ax.grid(axis="x", alpha=.2)
    axes[1].legend(loc="upper right", fontsize=8)
    fig.suptitle("4.892 partite storiche · IC simultanei 98,75% · bootstrap settimanale", fontsize=11)
    fig.savefig(args.figure, dpi=160)
    plt.close(fig)


if __name__ == "__main__":
    main()
