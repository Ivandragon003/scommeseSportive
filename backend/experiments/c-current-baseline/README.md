# Diagnostica storica dei kernel

Questi strumenti restano disponibili per leggere e verificare esperimenti
retrospettivi. Non registrano modelli e non modificano l'applicazione.

I vecchi sorgenti e pesi sono rimossi dal repository su richiesta. I risultati
già salvati restano consultabili, ma la ricostruzione completa non è disponibile
senza gli input storici originali. Nessuno script li ripristina automaticamente.

Entrambi i runner richiedono `--reference-source` con il percorso esplicito di un
`ForecastCore.js` storico esterno al workspace, completo delle sue dipendenze
originali. Il parametro non può puntare al codice corrente del repository per
sostituire il riferimento storico. Il contenuto deve corrispondere alle impronte
dei dati o del replay; anche il codice compilato e il runner restano verificati.

`kernel-replay.js` richiede inoltre `--matches`, `--dataset` e un nuovo `--out`.
`score-replay.js` richiede `--replays`, `--dataset`, `--comparison`, `--artifacts`
e un nuovo `--out`; gli artefatti storici originali sono necessari e non sono
forniti dal ripristino dati. Non presentare un nuovo training come replica degli
artefatti eliminati.

I test usano piccoli sorgenti sintetici in directory temporanee esterne. Verificano
il caricatore, i blocchi in assenza del riferimento, le impronte, le identità, i
vincoli temporali e i calcoli delle metriche; non certificano una ricostruzione
con i modelli storici rimossi.

```powershell
node --test backend/experiments/c-current-baseline/kernel-replay.test.js backend/experiments/c-current-baseline/score-replay.test.js
```
