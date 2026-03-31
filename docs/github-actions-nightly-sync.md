# GitHub Actions per sync notturna

Questa configurazione serve quando non vuoi tenere acceso il PC e non hai un server sempre attivo.

## Cosa fa

Il workflow:
- avvia il backend in CI
- esegue la sync Understat
- completa i campi mancanti con SofaScore sui match toccati dalla sync
- esegue la learning review
- salva il log come artifact GitHub Actions

File inclusi:
- [.github/workflows/nightly-sync.yml](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/.github/workflows/nightly-sync.yml)
- [scripts/ci/nightly-sync.sh](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/scripts/ci/nightly-sync.sh)

## Segreti da configurare su GitHub

Nel repository GitHub vai in:

`Settings -> Secrets and variables -> Actions`

### Secrets obbligatori

- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`

### Secret opzionale

- `ODDS_API_KEY`

Non serve per la sync notturna dati. Puoi tenerlo nel repository solo se ti serve per altri workflow futuri.

## Sync quote

La sync quote `Eurobet` non viene eseguita nel workflow GitHub Actions.

Motivo:
- lo scraping browser-based di Eurobet non e affidabile sui runner GitHub ospitati
- puo bloccarsi o andare in timeout
- rende instabile il job notturno che invece deve aggiornare soprattutto i dati `Understat`

Quindi il workflow notturno GitHub aggiorna:
- dati Understat
- possesso, falli, corner e arbitro tramite supplementazione SofaScore
- learning review

e salta sempre:
- sync quote Eurobet

## Orario di esecuzione

GitHub Actions schedula i cron in UTC, non in timezone locale.

Per rispettare `01:00 Europe/Rome`, il workflow parte due volte:
- `23:00 UTC`
- `00:00 UTC`

Poi lo script controlla l’ora locale `Europe/Rome` e continua solo quando è davvero l’ora `01`.

Questo evita il problema dell’ora legale/solare senza dover cambiare cron manualmente.

## Limiti

### GitHub Actions non è un server

Questa soluzione serve solo per i job notturni. Non tiene online frontend e backend 24/7.

### I workflow schedulati possono essere ritardati

GitHub non garantisce precisione assoluta al minuto per i job schedulati.

### Repository pubblici inattivi

Nei repository pubblici i workflow schedulati possono essere disabilitati automaticamente dopo 60 giorni senza attività.

Fonti ufficiali:
- [Scheduled workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- [Disable and enable workflows](https://docs.github.com/en/actions/using-workflows/disabling-and-enabling-a-workflow)

## Attivazione

Dopo aver aggiunto i secrets:

1. fai commit e push del workflow
2. vai su `Actions`
3. apri `Nightly Sync`
4. lancia un test manuale con `Run workflow`

Se il test passa, il job schedulato partirà automaticamente ogni notte.
