# Bonifica history Git dopo esposizione credenziali

Questa guida serve a ripulire la history quando un segreto e stato committato.

Non eseguire questi passi in automatico.
La riscrittura history richiede una decisione esplicita, coordinamento del team e quasi sempre un force-push.

## Prima di toccare la history

1. Ruota subito le credenziali esposte.
2. Revoca eventuali token, chiavi API, password applicative o credenziali DB compromesse.
3. Congela merge e push su `main` finche la bonifica non e pronta.
4. Crea un backup mirror del repository:

```bash
git clone --mirror <repo-url> repo-backup.git
```

5. Esegui uno scan del repository prima e dopo la bonifica:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\security\run-secret-scan.ps1 -Mode git
```

## Opzione A: git-filter-repo

Prerequisito:
- installa `git-filter-repo` secondo la documentazione ufficiale

Esempio di rimozione file sensibili dalla history:

```bash
git clone --mirror <repo-url> repo-clean.git
cd repo-clean.git
git filter-repo --invert-paths --path .env --path .env.production
```

Esempio di sostituzione testo sensibile noto con file di replace:

`replace.txt`

```text
secret-reale==>REMOVED_SECRET
```

Comando:

```bash
git filter-repo --replace-text replace.txt
```

## Opzione B: BFG Repo-Cleaner

Usa BFG se devi fare una bonifica rapida di file o pattern noti.

Esempi:

```bash
java -jar bfg.jar --delete-files .env repo-clean.git
java -jar bfg.jar --replace-text replace.txt repo-clean.git
```

Dopo BFG:

```bash
cd repo-clean.git
git reflog expire --expire=now --all
git gc --prune=now --aggressive
```

## Verifica prima del push

1. Riesegui Gitleaks:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\security\run-secret-scan.ps1 -Mode git
```

2. Controlla che i file sensibili non esistano piu nella history:

```bash
git log --all -- .env .env.production
```

3. Conferma che il team sia pronto a riallinearsi su una history riscritta.

## Push della history riscritta

Non eseguire questo step senza approvazione esplicita.

```bash
git push --force --all
git push --force --tags
```

## Impatto operativo

- tutte le PR aperte basate sulla vecchia history andranno riallineate
- i collaboratori dovranno fare re-clone o reset hard a un commit valido
- eventuali fork esterni manterranno comunque la history precedente finche non vengono aggiornati

## Rollback

Se qualcosa va storto:

1. Usa il mirror backup creato all'inizio.
2. Ripristina la history precedente in un repository separato.
3. Non fare rollback su `main` senza prima rivalutare il rischio dei segreti gia esposti.

## Decisione consigliata

La sequenza corretta e:

1. ruota i segreti
2. abilita lo scan automatico
3. verifica il repo
4. poi decidi se riscrivere la history

La riscrittura history riduce l'esposizione futura, ma non sostituisce mai la rotazione immediata delle credenziali.
