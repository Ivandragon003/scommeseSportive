"""Build a concise, inspectable repository report from completed development runs."""
from __future__ import annotations

import argparse
from collections import defaultdict
import hashlib
import json
from pathlib import Path


LABELS = {"intensity_correction": "Correzione intensità", "probability_correction": "Correzione probabilità",
          "calibrated_ensemble": "Ensemble statistico/ML", "identity": "Nessuna calibrazione aggiuntiva",
          "legacy_family_isotonic_normalized": "Isotonica famiglia legacy + normalizzazione",
          "isotonic_1x2_coherent": "Isotonica 1X2 coerente", "temperature_joint_coherent": "Temperatura congiunta coerente",
          "basic": "Base", "basic_plus_xg": "Base + xG/xGA", "basic_plus_recent": "Base + forma recente",
          "basic_plus_elo": "Base + Elo", "basic_plus_venue": "Base + casa/trasferta", "full": "Completa",
          "reduced_stable_selection_groups": "Gruppi con utilità selection ripetuta",
          "reduced_stable_selection_features": "Feature con intervallo permutation favorevole ripetuto",
          "reduced_history_730_days": "Training label: ultimi 730 giorni",
          "reduced_temporal_half_life_365_days": "Pesi training: emivita 365 giorni"}


def small_metric(value):
    return {key: value[key] for key in ("n", "logLoss", "brier", "ece", "topLabelEce", "classwisePooledEce") if key in value}


def run(args):
    source = Path(args.input)
    report = json.loads(source.read_bytes())
    experiments = report["experiments"]
    audit = report["audit"]
    stability_path = source.parent / "fit-stability.json"
    stability = json.loads(stability_path.read_bytes()) if stability_path.exists() else None
    if stability and stability["sourceDiagnosticsHash"] != hashlib.sha256(source.read_bytes()).hexdigest():
        raise ValueError("fit_stability_report_mismatch")
    full = [entry for entry in experiments if entry["featureGroup"] == "full"]
    def find(group, kind="intensity_correction", method="isotonic_1x2_coherent", **parameters):
        matches = [entry for entry in experiments if entry["featureGroup"] == group and entry["kind"] == kind
                   and entry["calibration"] == method and all(entry["hyperparameters"].get(key) == value for key, value in parameters.items())]
        if not matches:
            raise ValueError(f"diagnostic_experiment_missing: {group}/{kind}/{method}")
        return matches[0]
    base = {"iterations": 120, "depth": 5, "learningRate": .05, "l2LeafReg": 3}
    reference = find("full", **base)
    importance = defaultdict(list)
    for fold in report["featureImportance"]["predictionValuesChange"]:
        for item in fold["values"]:
            importance[item["feature"]].append(item["importance"])
    ranked = sorted(({"feature": key, "meanPredictionValuesChange": sum(values) / len(values),
                      "foldValues": values} for key, values in importance.items()), key=lambda item: -item["meanPredictionValuesChange"])
    compact = {"schemaVersion": "research-ml-diagnosis-summary-v1", "createdAt": report["createdAt"],
        "source": {"path": str(source), "sha256": hashlib.sha256(source.read_bytes()).hexdigest(),
                   "datasetHash": report["datasetHash"], "runnerHash": report["runnerHash"], "auditHelperHash": report.get("auditHelperHash")},
        "audit": audit,
        "protection": {key: value for key, value in report["protection"].items() if key != "protectedFinalMatchIds"},
        "developmentProtocol": {**report["developmentProtocol"], "folds": [{key: value for key, value in fold.items() if key != "checkMatchIds"}
                                                                          for fold in report["developmentProtocol"]["folds"]]},
        "featureImportance": {"predictionValuesChange": ranked, "permutation": report["featureImportance"]["permutation"],
                              "individualPermutation": report["featureImportance"].get("individualPermutation", []),
                              "shap": report["featureImportance"]["shap"]},
        "negativeControls": report["negativeControls"],
        "experiments": [{**{key: entry.get(key) for key in ("id", "family", "status", "diagnosticOnly", "runtimeCompatible", "featureGroup",
            "featureMask", "featureMasksByFold", "kind", "calibration", "hyperparameters", "historyDays", "timeHalfLifeDays", "paired", "modelArtifactPaths", "productionPromotion", "checkMatchIdsHash")},
            "metricsA": small_metric(entry["metricsA"]), "metricsC": small_metric(entry["metricsC"]),
            "byLeague": {league: {"A": small_metric(entry["metricsA"]["byLeague"][league]), "C": small_metric(entry["metricsC"]["byLeague"][league])}
                         for league in entry["metricsA"]["byLeague"]},
            "bySeason": {season: {"A": small_metric(entry["metricsA"]["bySeason"][season]), "C": small_metric(entry["metricsC"]["bySeason"][season])}
                         for season in entry["metricsA"]["bySeason"]}}
            for entry in experiments],
        "referenceByMarket": reference["byMarket"], "fitStability": stability,
        "recommendation": report["recommendation"], "limitations": report["limitations"]}
    destination = Path(args.output_json); destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(compact, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    n = reference["metricsA"]["n"]
    lines = ["# Diagnosi ML e sviluppo controllato A/C — 27 ottobre 2026", "",
        "**Esito: mantenere A come riferimento. Nessuna promozione C.** I risultati nuovi sono sviluppo cronologico, non un nuovo test indipendente.", "",
        "Il report storico originale e i suoi artefatti non sono stati modificati. Le 745 partite finali già consultate sono escluse da ogni fit, selezione, calibrazione, permutazione e nuovo controllo sperimentale. Una verifica indipendente richiede partite future successive alla registrazione degli esperimenti.", "",
        "## Dataset e verifica dello storico", "",
        f"L'esportazione contiene {audit['counts']['raw']:,} incontri, {audit['counts']['rawCompleted']:,} conclusi e {audit['counts']['eligible']:,} osservazioni ML ammissibili con 40 feature numeriche. Nessun duplicato di match, fixture o previsione è stato rilevato. Le 40 feature sono state ricalcolate indipendentemente da risultati/xG disponibili prima del target: nessuna discrepanza oltre 1e-8 o violazione temporale nel materiale esportato.", "",
        "| Campionato | Osservazioni ammissibili |", "|---|---:|"]
    lines.extend(f"| {league} | {count} |" for league, count in audit["counts"]["byLeague"].items())
    lines += ["", "| Stagione | Osservazioni ammissibili |", "|---|---:|"]
    lines.extend(f"| {season} | {count} |" for season, count in audit["counts"]["bySeason"].items())
    lines += ["", "I dati coprono agosto 2022–ottobre 2026; la stagione 2026/27 è parziale. xG/xGA sono presenti in tutte le 7.476 partite concluse esportate. Non ci sono feature numeriche mancanti o costanti. Le due coperture xG sono quasi costanti perché indicano soprattutto 14 casi casa e 21 trasferta senza storico: i valori sostitutivi sono prior espliciti, non statistiche osservate.", "",
        "Nessuna correlazione a coppie raggiunge |r|≥0,98. Esistono comunque ridondanze esatte: `elo_difference = home_elo − away_elo` e la somma dei cinque indicatori di lega vale 1. Queste dipendenze non dimostrano da sole che una feature sia inutile per alberi. Nessuna squadra appare in due leghe nella stessa stagione; l'identità fisica dei club e gli alias richiedono evidenza ulteriore non contenuta nell'export numerico.", "",
        "| Fold originale | Training | Selezione | Calibrazione | Test |", "|---|---:|---:|---:|---:|"]
    for fold in audit["originalFolds"]:
        c = fold["counts"]; lines.append(f"| {fold['fold']} | {c['train']} | {c['selection']} | {c['calibration']} | {c['test']} |")
    lines += ["", "Identità, separazione dei gruppi e purge temporale dei tre fold corrispondono ai record. I 2.168 match di test sono distinti; le metriche grezze sono state riprodotte entro 2,3e-16 e quelle aggregate dopo calibrazione entro 2,4e-15. Su questi dati le marginali 1X2 della matrice proxy A coincidono con A flat fino all'errore numerico: la proxy non spiega il piccolo guadagno osservato.", "",
        "## Problemi effettivi e ipotesi", "",
        "1. La vecchia calibrazione correggeva marginali separati senza ricostruire una distribuzione coerente; il benchmark normalizzava il vettore 1X2 prima dello scoring, mentre il Decision Engine poteva usare i valori non normalizzati. È un difetto matematico verificato, distinto dal guadagno ML.",
        "2. Le stesse 387/366/335 partite producono rispettivamente 7.558/7.162/6.536 etichette A e 15.298/14.482/13.236 C perché C include anche i totali squadra. Questi non sono altrettanti match indipendenti. La famiglia 1X2 mescola anche doppia chance e DNB. Il nuovo controllo usa soltanto tre classi 1X2 normalizzate e poi riproietta la matrice.",
        "3. Il vecchio trainer non permetteva peso ML zero. Inoltre tutti i fold selezionavano temperatura congiunta 0,8: parte del guadagno poteva venire dalla trasformazione di A. Questo è verificato con un controllo privo di ML, non assunto.",
        "4. L'ECE grezza originaria media tutte le classi; l'ECE finale usa confidenza della classe principale. Sono definizioni differenti, ora riportate entrambe per ogni nuovo esperimento. Non si attribuisce un cambiamento fra queste due misure alla calibrazione.",
        "5. La calibrazione dispone di poche centinaia di partite per finestra. È plausibile che una curva non parametrica vari fra periodi, ma non è dimostrata come unica causa dell'ECE finale peggiore. L'implementazione corrente usa bucket e shrinkage: non è identica alla regressione isotonica standard.", "",
        "La documentazione ufficiale [scikit-learn](https://scikit-learn.org/stable/modules/calibration.html) descrive il rischio di overfitting isotonico con campioni piccoli e la necessità di calibrazione separata. La rilevanza nel caso FootPredictor va comunque misurata, non dedotta dalla sola regola generale.", "",
        "## Protocollo dei nuovi esperimenti", "",
        f"Sviluppo ammesso: 6.578 righe prima del cutoff protetto. Tre fold con training crescente, selezione, calibrazione e controlli disgiunti generano **{n} confronti appaiati di sviluppo**, distribuiti su {reference['paired']['weekClusters']} settimane. I periodi erano già osservabili: i loro intervalli non autorizzano una promozione. Tutti i nuovi esperimenti escludono le 745 partite finali.", "",
        "| Fold sviluppo | Training | Selezione | Calibrazione | Controllo sviluppo |", "|---|---:|---:|---:|---:|"]
    lines.extend(f"| {fold['fold']} | {fold['trainN']} | {fold['selectionN']} | {fold['calibrationN']} | {fold['checkN']} |" for fold in report["developmentProtocol"]["folds"])
    lines += ["", f"Sono eseguiti {len(experiments)} confronti C: ablazioni, tre integrazioni, quattro protocolli di calibrazione e una ricerca limitata. CatBoost 1.2.8 usa seed fisso e due thread. Il peso include zero; peso e temperatura sono scelti sulla selezione. PAV e temperatura di calibrazione usano la finestra successiva separata. SHAP/permutation per scegliere feature usano soltanto la selezione, non le etichette dei controlli.", "",
        "Configurazione base: 120 alberi, profondità 5, learning rate 0,05, L2=3. Le sole alternative sono 60/profondità3/L2=10 e 180/profondità4/learning rate0,03/L2=10, ultimi 730 giorni di label e pesi con emivita 365 giorni. Il limite di 730 giorni riguarda le label di training: non modifica le medie storiche già codificate nelle feature congelate. Non è una prova sull'intera profondità della pipeline statistica A.", "",
        "## Tre configurazioni e controllo senza ML", "",
        "- Correzione intensità: regressori Poisson sui gol, con log-intensità A come baseline; ricostruzione congiunta coerente.",
        "- Correzione probabilità: multiclass sui risultati, con log-probabilità A come baseline; riponderazione delle tre regioni del punteggio.",
        "- Ensemble: regressori Poisson interni e combinazione con la matrice A. Non esiste un modello B operativo.", "",
        "| Configurazione, senza calibrazione aggiuntiva | Log loss | Brier | ECE principale |", "|---|---:|---:|---:|"]
    for control in report["negativeControls"]:
        m = control["metricsC"]; lines.append(f"| {'A identità' if control['id']=='A_identity' else 'Solo temperatura A, nessun ML'} | {m['logLoss']:.6f} | {m['brier']:.6f} | {m['ece']:.6f} |")
    for kind in ("intensity_correction", "probability_correction", "calibrated_ensemble"):
        m = find("full", kind=kind, method="identity", **base)["metricsC"]
        lines.append(f"| C — {LABELS[kind]} | {m['logLoss']:.6f} | {m['brier']:.6f} | {m['ece']:.6f} |")
    lines += ["", "Il controllo solo-temperatura migliora A senza aggiungere alcuna feature ML. Quindi il guadagno C rispetto ad A grezzo non può essere attribuito interamente a CatBoost. La correzione delle intensità è la variante più regolare nei tre controlli di sviluppo; la correzione probabilistica sceglie anche peso zero in un fold e mostra maggior variabilità.", ""]
    if stability:
        lines += ["### Adattamento nell'ultimo fold di sviluppo", "",
            "La tabella usa 1X2 prima della calibrazione successiva. Le metriche di training sono in-sample e non sono prove di generalizzazione.", "",
            "| Configurazione | Log loss training | Log loss selezione | Log loss calibrazione | Log loss controllo |", "|---|---:|---:|---:|---:|"]
        for configuration in stability["configurations"]:
            values = configuration["probabilityScores"]
            lines.append(f"| {LABELS[configuration['kind']]} | " + " | ".join(f"{values[phase]['C']['logLoss']:.6f}" for phase in ("train", "selection", "calibration", "check")) + " |")
        lines += ["", "La correzione probabilistica ottiene un training migliore ma un divario successivo più ampio. È compatibile con maggiore adattamento al training e/o cambiamenti del periodo; non isola una causa unica. Il JSON conserva anche le loss native Poisson e MultiClass per ogni iterazione: questi obiettivi diversi non vanno confrontati numericamente fra loro.", ""]
    lines += [
        "## Ablazioni a parità di integrazione e calibrazione", "",
        "La tabella usa la correzione intensità con isotonica 1X2 coerente. Le impostazioni vengono riottimizzate soltanto nella selezione di ogni fold; i risultati sono diagnostici.", "",
        "| Feature | Numero ultimo fold | Log loss C | Brier C | ECE C |", "|---|---:|---:|---:|---:|"]
    for group in ("basic", "basic_plus_xg", "basic_plus_recent", "basic_plus_elo", "basic_plus_venue", "full", "reduced_stable_selection_features"):
        entry = find(group, **base); m = entry["metricsC"]
        lines.append(f"| {LABELS[group]} | {len(entry['featureMask'])} | {m['logLoss']:.6f} | {m['brier']:.6f} | {m['ece']:.6f} |")
    lines += ["", "Una versione preliminare della riduzione sceglieva una maschera globale dalle tre finestre di selezione e la riapplicava anche ai controlli precedenti. Questo era un lookahead nello sviluppo, pur senza usare le 745 partite protette: quei risultati sono stati invalidati e sostituiti. Ora ogni fold determina la propria maschera soltanto dalle finestre di selezione correnti o precedenti. Intensità A e indicatori di lega restano; una feature aggiuntiva richiede un intervallo permutation settimanale favorevole in almeno min(2, finestre già disponibili). È un criterio di sviluppo, non una selezione causale o già validata in futuro.", "",
        "Numero di feature nel controllo ridotto per fold: " + ", ".join(f"{fold}: {len(names)}" for fold, names in report["developmentProtocol"].get("reducedFeatureNamesByFold", {}).items()) + ".",
        "Feature conservate nell'ultimo fold del controllo ridotto: " + ", ".join(f"`{name}`" for name in report["developmentProtocol"].get("reducedFeatureNames", [])) + ".", "",
        "## Importanza e sensibilità", "",
        "| Feature | PredictionValuesChange medio nei tre fold |", "|---|---:|"]
    lines.extend(f"| `{item['feature']}` | {item['meanPredictionValuesChange']:.3f} |" for item in ranked[:10])
    lines += ["", "Le intensità A compaiono fra i segnali più usati: C riutilizza una sintesi statistica già forte. xG, forma, Elo e venue mostrano utilità variabile; la sola frequenza di importanza non dimostra informazione aggiuntiva stabile. I dettagli delle permutazioni per feature/gruppo, degli intervalli e di SHAP sono nel JSON. Le feature di copertura xG quasi costanti non dimostrano un miglioramento nel campione osservato, ma restano indicatori utili per i prior/cold start.", "",
        "[CatBoost](https://catboost.ai/docs/en/concepts/fstr) definisce PredictionValuesChange come variazione delle previsioni associata alla feature. La [documentazione SHAP di CatBoost](https://catboost.ai/docs/en/concepts/python-reference_catboostclassifier_get_feature_importance) descrive contributi ai valori del modello: né l'una né l'altra misura prova causalità. Le permutazioni mantengono il campionato, ma possono rompere correlazioni fra feature; gli intervalli restano esplorativi dopo più confronti.", "",
    ]
    if stability:
        lines += ["### Stabilità fra stagioni nella selezione", "",
            "Per lo stesso modello dell'ultimo fold, SHAP è misurato su al massimo 100 osservazioni di selezione per stagione. Il confronto non usa etichette dei controlli o del test finale. Le permutazioni per stagione mantengono il campionato.", "",
            "| Stagione | Modello interno | N SHAP | Tre contributi assoluti maggiori |", "|---|---|---:|---|"]
        for item in stability["shapBySelectionSeason"]:
            if item["kind"] != "intensity_correction":
                continue
            top = sorted(item["meanAbsolute"], key=lambda value: -value["value"])[:3]
            lines.append(f"| {item['season']} | {item['model']} | {item['n']} | " + ", ".join(f"`{value['feature']}`" for value in top) + " |")
        lines += ["", "Nella selezione 2024/25 la permutazione xG ed Elo può peggiorare la log loss, mentre nella porzione 2025/26 gli intervalli includono zero; forma recente e venue non mostrano utilità uniforme. Campioni, avversari e distribuzioni cambiano: non è una prova di relazione causale né di inutilità permanente. Le corrispondenti stime e numerosità sono conservate nel JSON.", ""]
    lines += [
        "## Calibrazione e beneficio incrementale", "",
        "| Protocollo, C intensità completo | Log loss A | Log loss C | Brier A | Brier C | ECE A | ECE C |", "|---|---:|---:|---:|---:|---:|---:|"]
    for method in ("identity", "legacy_family_isotonic_normalized", "isotonic_1x2_coherent", "temperature_joint_coherent"):
        e = find("full", method=method, **base); a, c = e["metricsA"], e["metricsC"]
        lines.append(f"| {LABELS[method]} | {a['logLoss']:.6f} | {c['logLoss']:.6f} | {a['brier']:.6f} | {c['brier']:.6f} | {a['ece']:.6f} | {c['ece']:.6f} |")
    comparison = find("full", method="temperature_joint_coherent", **base)
    lines += ["", "Rispetto ad A che riceve anch'esso la temperatura selezionata, l'intervallo settimanale 95% della differenza C−A è "
        + str(comparison["paired"]["weekLogLossCI"]) + " per log loss e " + str(comparison["paired"]["weekBrierCI"]) + " per Brier. Entrambi comprendono zero: il beneficio informativo ML oltre il controllo di calibrazione non è robustamente separato su questo sviluppo.", "",
        "La calibrazione coerente 1X2 migliora l'ECE di C su questi controlli, ma non migliora uniformemente log loss e Brier rispetto alla curva famiglia legacy. Questo dimostra un trade-off nel campione, non la soluzione definitiva dell'ECE finale originale. Il test finale originale non è stato riutilizzato per decidere il calibratore.", "",
        "## Campionati, stagioni e mercati", "",
        "Riferimento diagnostico: C correzione intensità, feature complete, isotonica 1X2 coerente.", "",
        "| Campionato | N | Log loss A | Log loss C | Brier A | Brier C |", "|---|---:|---:|---:|---:|---:|"]
    for league, a in reference["metricsA"]["byLeague"].items():
        c = reference["metricsC"]["byLeague"][league]
        lines.append(f"| {league} | {a['n']} | {a['logLoss']:.6f} | {c['logLoss']:.6f} | {a['brier']:.6f} | {c['brier']:.6f} |")
    lines += ["", "| Stagione di sviluppo | N | Log loss A | Log loss C | Brier A | Brier C |", "|---|---:|---:|---:|---:|---:|"]
    for season, a in reference["metricsA"]["bySeason"].items():
        c = reference["metricsC"]["bySeason"][season]
        lines.append(f"| {season} | {a['n']} | {a['logLoss']:.6f} | {c['logLoss']:.6f} | {a['brier']:.6f} | {c['brier']:.6f} |")
    lines += ["", "| Mercato | N valutabile | Log loss A | Log loss C | Brier A | Brier C |", "|---|---:|---:|---:|---:|---:|"]
    for market in ("double_chance_1x", "dnb_home", "totals_over_2.5", "team_home_over_1.5", "btts", "european_handicap_home_-1", "asian_handicap_home_0.25"):
        a, c = reference["byMarket"]["A"][market], reference["byMarket"]["C"][market]
        lines.append(f"| `{market}` | {a['n']} | {a['logLoss']:.6f} | {c['logLoss']:.6f} | {a['brier']:.6f} | {c['brier']:.6f} |")
    lines += ["", "Le metriche 1X2 ed handicap europeo sono multiclass; doppia chance, totali e BTTS sono binarie. DNB esclude i rimborsi; gli handicap asiatici usano probabilità condizionali e pesi di stake effettivo per mezzi esiti. Non si confrontano direttamente valori di metriche con target diversi. Nessuna di queste misure attiva il mercato o dimostra un ROI.", "",
        "## Ottimizzazioni controllate", "",
        "| Configurazione intensità, isotonica 1X2 | Alberi/profondità | Log loss C | Brier C |", "|---|---:|---:|---:|"]
    candidates = [entry for entry in experiments if entry["kind"] == "intensity_correction" and entry["calibration"] == "isotonic_1x2_coherent"
                  and entry["featureGroup"] in ("reduced_stable_selection_groups", "reduced_history_730_days", "reduced_temporal_half_life_365_days")]
    for entry in candidates:
        m, p = entry["metricsC"], entry["hyperparameters"]
        lines.append(f"| {LABELS[entry['featureGroup']]} | {p['iterations']}/{p['depth']} | {m['logLoss']:.6f} | {m['brier']:.6f} |")
    lines += ["", "Il miglior valore medio fra molte configurazioni non costituisce una prova indipendente. La maggiore regolarizzazione, il limite di storia e i pesi temporali non autorizzano un cambio operativo. Non sono aggiunte reti neurali, feature categoriche incompatibili con l'inferenza numerica o nuovi provider.", "",
        "## Riproducibilità, uso e limiti", "",
        "```powershell", "cd backend", "npm run build", "python -m unittest discover -s ml/tests -v", "python ml/diagnose.py --dataset artifacts/research/dataset.json --matches artifacts/research/matches.json --original artifacts/research/run-20261027/report.json --output artifacts/research/diagnostics-20261027 --folds 3 --iterations 120", "python ml/diagnostics/fit_stability.py --diagnostics artifacts/research/diagnostics-20261027/diagnostics.json --dataset artifacts/research/dataset.json --original artifacts/research/run-20261027/report.json --output artifacts/research/diagnostics-20261027/fit-stability.json", "python ml/diagnostics/summarize.py --input artifacts/research/diagnostics-20261027/diagnostics.json --output-json ../docs/performance/ml-diagnosis-2026-10-27.json --output-md ../docs/performance/ml-diagnosis-2026-10-27.md", "```", "",
        "Gli artefatti nuovi contengono maschere di feature, anche diverse per fold, e sono `diagnosticOnly=true`, `runtimeCompatible=false`. La loro registrazione è separata dai modelli operativi; non devono essere scelti automaticamente come latest C senza un adattatore di inferenza e una validazione nuova. I report conservano hash dei dati, del runner, dei modelli e della lista finale protetta. Il test Python `test_later_selection_cannot_choose_an_earlier_reduced_mask` modifica prove future e verifica che le maschere precedenti rimangano identiche.", "",
        "Rimangono limiti: disponibilità storica ricostruita a kickoff+2h, possibili revisioni retroattive delle fonti, statistica di calibrazione con poche partite, più esperimenti sullo sviluppo e nessun nuovo periodo indipendente. Il confronto economico e le prove prospettiche richiedono quote reali ammissibili e sono separati da questo report.", "",
        "**Decisione: A resta il riferimento; C intensità merita una verifica prospettica controllata, ma nessuna configurazione viene promossa.** La correzione della coerenza probabilistica è necessaria a prescindere dalla superiorità del ML.", "",
        "[Riepilogo JSON](ml-diagnosis-2026-10-27.json) · [Benchmark storico originale immutato](research-ac-2026-10-27.md)", ""]
    Path(args.output_md).write_text("\n".join(lines), encoding="utf-8")
    print(json.dumps({"summary": str(destination), "experiments": len(experiments), "developmentN": n}))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--input", required=True); parser.add_argument("--output-json", required=True); parser.add_argument("--output-md", required=True)
    run(parser.parse_args())
