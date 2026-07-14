# Bias di livello di λ dopo l'intera pipeline: verifica e diagnosi — Luglio 2026

Data: 2026-07-14
Esito: il bias di livello **esiste** sul modello grezzo, ma la pipeline di produzione lo **neutralizza esattamente dove genera scommesse** (1X2 via calibrazione; totali via market blending dove ci sono le quote). Il residuo è confinato a mercati/partite che non producono value bet. **Nessuna modifica raccomandata.**

## Domanda

Il bias di livello di λ (scoperto nell'analisi HA ibrida: il modello grezzo sottostima i goal) sopravvive dopo fit → calibrazione isotonica per-famiglia → market blending? Se già corretto, non toccare nulla. Se residuo e significativo, individuare la componente che lo genera e proporre la correzione minima.

## Metodo

Walk-forward OOS su 5 campionati / 2 stagioni (3.504 partite). Per ogni mercato sensibile al livello, test di **calibration-in-the-large**:

  z = Σ(y − p) / √(Σ p(1−p))

`z > 0` = il modello **sottostima** (esiti osservati > probabilità previste). `|z| > 1.96` ≈ significativo. Misurato su probabilità **raw**, dopo **calibrazione per-famiglia**, e (dove ci sono quote) dopo **blending**.

## Risultato 1 — il bias grezzo è REALE, forte e SIMMETRICO

Confronto diretto E[goal] previsti vs realizzati (modello raw, no xG al predict):

| | previsti | reali | bias | log-ratio | t |
|---|---|---|---|---|---|
| Casa | 1.310 | 1.522 | +0.212 gol/match | 0.150 | 7.99 |
| Ospite | 1.055 | 1.231 | +0.175 gol/match | 0.153 | 7.31 |

**Il bias è quasi identico per casa e trasferta (~15%): è un bias di livello TOTALE dei goal, non di home advantage.** Questo conferma definitivamente perché l'HA per-squadra non serviva: il segnale non era casa-specifico.

Sui mercati (raw): enorme sui totali (over2.5 z=+9.8, −20%; under2.5 z=−9.8; btts z=+8.1), lieve sull'1X2 (homeWin z=+1.8) — perché alzando entrambi i λ i totali esplodono ma sull'1X2 gli effetti home/away si compensano.

## Risultato 2 — la pipeline lo neutralizza dove conta

| Stadio | 1X2 | Over/Under/BTTS |
|---|---|---|
| **Raw** | lieve (z≈±2) | fortissimo (z≈±8-10) |
| **+ calibrazione per-famiglia** | **azzerato** (z: +0.6/−1.1/+0.5, tutti NS) | dimezzato ma **ancora significativo** (over2.5 z=+6.7, −15%; under2.5 z=−7.4) |
| **+ market blending** (dove ci sono quote) | NS | **azzerato** (over2.5 z=+1.2, under2.5 z=−1.5, over3.5 z=−0.6 — tutti NS) |

- **1X2**: bias già trascurabile sul raw, completamente azzerato dalla calibrazione. Nessun problema.
- **Over/Under/BTTS**: la calibrazione per-famiglia **non basta** (resta −15% sugli over, z≈7). Ma il **blending col mercato lo azzera**: dove esiste la quota, la probabilità viene tirata verso il no-vig del bookmaker (ben calibrato sul livello dei goal) e il bias sparisce.

## Risultato 3 — impatto sul betting: nullo

Le value bet si generano **solo dove esiste la quota bookmaker** (serve per calcolare l'EV). Ma è esattamente lì che il blending è attivo e azzera il bias. Dove il bias residuo sopravvive (mercati totali di partite **senza** quote archiviate) **non si genera alcuna bet**. Quindi il bias residuo **non tocca il value betting**.

## Diagnosi della causa (NON è l'xG)

Controintuitivo: **l'xG sovrastima i goal**, non li sottostima.

| | goal reali | xG medio | log-ratio |
|---|---|---|---|
| Casa | 1.518 | 1.687 | −0.106 |
| Ospite | 1.278 | 1.359 | −0.062 |

Il fit su pseudo-goal (0.6·goal + 0.4·xG) usa un target casa di ~1.586, **più alto** dei goal reali (1.518). Quindi il blend xG **riduce** il bias, non lo causa. La sottostima nasce **dentro il fit/score-matrix**: E[goal] della matrice Dixon-Coles predetta (1.310) è più bassa sia dei goal reali (1.522) sia del pseudo-goal su cui è addestrata (~1.586). Il gap (~−0.28) è interno.

Componente responsabile (più probabile): **l'interazione tra la correzione τ di Dixon-Coles con ρ<0 e i gradienti di attack/defence stimati sul Poisson marginale**. I gradienti di att/def usano l'errore Poisson puro (`x − λ`), ma la score-matrix finale applica la correzione τ(ρ<0) che sposta massa verso i punteggi bassi (0-0, 1-1), abbassando E[goal] rispetto ai λ nominali. Le due cose non si compensano → sottostima sistematica del livello. **Non è un parametro mancante: è un'inconsistenza tra l'obiettivo di stima e la distribuzione usata al predict.**

## Correzione più semplice possibile (proposta, NON implementata)

Poiché il bias è un **fattore di scala quasi costante** (~+15% simmetrico su casa e trasferta), la correzione minima **senza nuovi parametri per-squadra** sarebbe un singolo **fattore di ri-livellamento di λ** stimato out-of-sample (es. `λ ← λ · c` con `c ≈ 1.16` ricalibrato walk-forward), applicato prima della calibrazione. Un solo scalare, non 20 parametri.

**Raccomandazione: non implementarla.** Motivi:
1. Sul **betting** il bias è già neutralizzato (calibrazione sull'1X2, blending sui totali dove si scommette) → beneficio pratico nullo.
2. Toccare il livello di λ a monte impatta **tutte** le probabilità e rischia di degradare l'1X2 (oggi ben calibrato) e i mercati statistici.
3. La causa vera (inconsistenza τ/gradienti) andrebbe semmai risolta alla radice, non mascherata con un fattore di scala — ma è un intervento delicato sul core, ingiustificato dato l'impatto nullo sul prodotto.

Se in futuro si volessero esporre **probabilità raw non-biased** (es. per la UI, sui match senza quote), il fattore di ri-livellamento OOS è la via minima; va validato che non peggiori 1X2 e mercati calibrati.

## Conclusione

Il bias di livello di λ è reale sul modello grezzo (~15%, simmetrico, causa strutturale nel fit — **non** l'xG), ma la pipeline di produzione lo corregge dove genera valore: **1X2 via calibrazione, totali via blending sulle partite con quote**. L'impatto sul value betting è nullo. **Nessuna modifica al codice.**
