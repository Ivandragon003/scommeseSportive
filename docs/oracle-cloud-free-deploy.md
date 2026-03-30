# Deploy su Oracle Cloud Free

Questa guida serve a mettere `scommeseSportive` online su un server sempre acceso, in modo che gli scheduler notturni del backend partano senza dipendere dal PC locale.

## Scelta infrastruttura

### Opzione 1 — Oracle Cloud Always Free
Scelta consigliata.

Pro:
- VM sempre accesa
- risorse gratis realmente utilizzabili
- riuso quasi totale del setup Docker Compose attuale
- scheduler interni del backend riusabili senza refactor
- lock-in basso

Contro:
- registrazione con verifica carta
- capacità free non sempre disponibile in tutte le regioni
- gestione server a tuo carico

Fonti ufficiali:
- [Oracle Cloud Free Tier](https://www.oracle.com/cloud/free/)
- [Oracle Always Free Resources](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)

### Opzione 2 — GitHub Actions schedule
Non consigliata come soluzione principale.

Pro:
- gratis
- nessun server da gestire

Contro:
- non è un server 24/7
- i job schedulati possono essere ritardati
- nei repo pubblici possono essere disabilitati dopo 60 giorni senza attività
- non è una base affidabile per backend + frontend sempre online

Fonti ufficiali:
- [GitHub scheduled workflows](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows)
- [GitHub workflow disable policy](https://docs.github.com/en/actions/using-workflows/disabling-and-enabling-a-workflow)

### Opzione 3 — Render Free
Non consigliata per questo progetto.

Pro:
- setup facile
- deploy rapido

Contro:
- le istanze free non sono adatte alla produzione
- spin down dopo inattività
- limiti mensili
- meno portabile di un VPS standard

Fonte ufficiale:
- [Render free services](https://render.com/free)

## Raccomandazione

Usa `Oracle Cloud Always Free` con una VM Linux e `Docker Compose`.

Motivo:
- il backend ha già gli scheduler notturni
- il DB è remoto (`Turso`)
- il progetto è già containerizzato
- la migrazione operativa è minima

## Assunzioni

- il DB Turso resta il database di produzione
- il frontend resta servito dal container Nginx già presente
- il backend gira come processo sempre acceso dentro Docker
- il server usa timezone `Europe/Rome`

## File di deploy inclusi nel repo

- [docker-compose.prod.yml](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/docker-compose.prod.yml)
- [.env.production.example](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/.env.production.example)
- [scripts/deploy-prod.sh](/c:/Users/ACER/Desktop/DANIELE/scommeseSportive/scripts/deploy-prod.sh)

## Flusso di deploy

### 1. Crea la VM

Su Oracle Cloud:
- crea una VM Ubuntu LTS Always Free
- apri almeno la porta `80`
- la porta `22` serve per SSH

Nota:
- se vuoi esporre direttamente il backend, dovresti aprire anche `3001`
- per il setup consigliato non serve, perché il backend resta interno e il frontend fa proxy verso `/api`

### 2. Installa Docker

Sul server:

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y ca-certificates curl gnupg
sudo install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg
echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
  sudo tee /etc/apt/sources.list.d/docker.list > /dev/null
sudo apt update
sudo apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
sudo usermod -aG docker $USER
```

Esci e rientra via SSH.

### 3. Copia il progetto sul server

Opzione Git:

```bash
git clone <URL-REPO> scommeseSportive
cd scommeseSportive
```

### 4. Crea l'env di produzione

```bash
cp .env.production.example .env.production
nano .env.production
```

Compila almeno:
- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`
- `ODDS_API_KEY`

Controlla che i job siano attivi:
- `UNDERSTAT_SCHEDULER_ENABLED=true`
- `UNDERSTAT_SCHEDULER_TIME=01:00`
- `ODDS_SNAPSHOT_SCHEDULER_TIME=02:15`
- `LEARNING_REVIEW_SCHEDULER_TIME=03:00`

### 5. Avvia i container

```bash
chmod +x scripts/deploy-prod.sh
./scripts/deploy-prod.sh
```

Oppure manualmente:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml up -d --build
```

### 6. Verifica

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml ps
docker compose --env-file .env.production -f docker-compose.prod.yml logs -f backend
curl http://localhost/api/health
```

Se la VM espone la porta `80`, da browser apri:

```text
http://IP_DEL_SERVER
```

## Comportamento scheduler

Con questa configurazione:
- `01:00` sync Understat
- `02:15` snapshot quote
- `03:00` learning review

I job partono da soli solo se la VM e Docker sono accesi. Su Oracle questo è il comportamento normale, quindi non dipendi più dal tuo PC.

## Limiti operativi

### Eurobet
La parte più fragile resta lo scraping Eurobet:
- in ambiente server può essere meno stabile del PC locale
- dipende da anti-bot e fingerprint browser

Quindi:
- Understat notturno su server: sì
- quote Eurobet su server: sì, ma è il punto da monitorare più attentamente

### Capacità Oracle Free
La creazione di VM free può dipendere dalla disponibilità regionale. Se una shape non è disponibile, prova un’altra regione supportata o una shape free alternativa.

## Hardening minimo consigliato

- usa chiavi SSH, non password
- apri solo porte `22` e `80`
- non esporre `3001` se non serve
- aggiorna il server periodicamente
- tieni i segreti solo in `.env.production`
- non committare `.env.production`

## Comandi utili

Aggiornare dopo una modifica:

```bash
git pull
./scripts/deploy-prod.sh
```

Vedere i log backend:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml logs -f backend
```

Riavviare:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml restart
```

Fermare tutto:

```bash
docker compose --env-file .env.production -f docker-compose.prod.yml down
```
