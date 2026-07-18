# Validazione modelli Falli e Corner (dati reali football-data) — Luglio 2026

Data: 2026-07-18
Contesto: dopo l'integrazione di football-data.co.uk (falli/corner ~100%), i modelli `computeFoulsDistribution` / `computeCornersDistribution` — che prima giravano su default inventati — sono finalmente misurabili su dati reali.

## Metodo

Walk-forward su medie squadra rolling (anti-lookahead), 5 campionati, 6.683 match con falli e corner. Possesso neutro (0.5) e arbitro neutro (assenti fuori Premier), come in produzione. Selezioni Over sulle linee tipiche. **Misura sul modello grezzo (senza calibrazione per-famiglia)** — la calibrazione di produzione correggerebbe parte della dispersione.

## Risultati

| | aspettativa predetto vs reale | bias | ECE globale (raw) |
|---|---|---|---|
| **Falli** | 23.94 vs 23.75 | **+0.8%** | 0.033 |
| **Corner** | 9.64 vs 9.65 | **−0.1%** | 0.021 |

**Livello eccellente**: bias sotto l'1% su entrambi → i dati football-data e la struttura dei modelli sono sani. Nessun bias di livello (a differenza dei cartellini pre-bugfix, che erano +26%).

**Calibration-in-the-large per linea (z):** pattern coerente — z positivo sulle linee basse (falli 19.5: +9.4; corner 7.5: +7.5), negativo sulle alte (falli 25.5: −2.8; corner 12.5: −5.5). Indica una **dispersione grezza un po' troppo larga** (r da stringere): la distribuzione ha code più pesanti del reale. Più marcato sui falli che sui corner.

## Lettura

- I modelli sono **usabili**: il livello è corretto, serve solo tarare la dispersione o lasciare che la calibrazione per-famiglia la assorba (come per i cartellini).
- Questa misura è **grezza**; prima di attivare i mercati nel filtro value va rifatta **attraverso la pipeline completa con calibrazione** (come `cards-competitiveness-bugfix-2026-07.md`), che verosimilmente porta l'ECE sotto 0.01.

## Decisione

**Dati validati, mercati non ancora attivati.** Prossimo passo per attivarli: (1) validazione full-pipeline con calibrazione per-famiglia; (2) eventuale taratura di `r` (dispersione) per falli; (3) attivazione nel filtro value solo con esito positivo. Nessun bug da correggere — solo un raffinamento.
