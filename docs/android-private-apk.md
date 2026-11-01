# FootPredictor su Android (APK privato)

L'app Android include una copia della UI React e usa lo stesso backend Hostless della versione web.
Capacitor usa `webDir: 'build'` e non configura `server.url`: l'APK carica gli asset
inclusi nel pacchetto, non il sito frontend remoto. Un deploy web non aggiorna la UI dell'APK.
Non contiene database, budget o password: budget, giocate e archivio restano nel database
Turso condiviso sotto l'utente canonico `user1`.

## Stato al 1 novembre 2026: APK 1.1.7 di prova

La versione Android è `1.1.7` / `versionCode=9`. Il pacchetto di prova include anche
il confronto dei consigli A/C nel dettaglio partita, compilato in un worktree isolato:
non include le modifiche locali non pubblicate a `walletApi.ts` e al relativo test.
Comprende i portafogli separati A/C, stake A dal consiglio, stake C all'1% e consigli
Nightly archiviati. Le due schede distinguono consiglio del motore, quota archiviata,
importo effettivamente registrato, astensione e valutazione non disponibile.
C mostra la propria decisione Nightly già archiviata quando esiste. Senza archivio,
nelle partite future ammissibili calcola un'anteprima con il modello C operativo,
quote reali e stake indicativo 1%. La scheda è marcata non registrata: aprire la
partita non crea puntate, addebiti o forecast prospettici. Se dati o quote non sono
disponibili, lo segnala. A conserva il percorso esistente e il proprio motore.
Il backend resta `https://scommese-sportive-backend.hostless.app/api`;
i motori risiedono sul server e non vengono modificati dal packaging Android.
La navigazione principale è ridotta a Partite, Giocate, Budget, Archivio e Dati e
aggiornamenti. A/C vengono richiesti in sequenza. «Oggi» filtra le giocate registrate
nel giorno italiano; i risultati mancanti restano in attesa. Il pulsante esplicito
«Aggiorna risultati» recupera finali Understat e liquida solo giocate virtuali
esistenti: non apre bet, non ricalcola A/C e non recupera astensioni precedenti.

Mancano ancora `frontend/android/key.properties` e il keystore release originale.
Si riutilizza esclusivamente il keystore debug già esistente, senza creare nuove chiavi.
Il precedente APK locale 1.1.1/code 3 ha lo stesso certificato Android Debug SHA-256
`21f01c0666c42ac6b960a0c840fbbef27c1bd833e4a8ce21a9c0e4fe909b23df`.
La distribuzione è quindi un APK **di prova**, non una release con firma privata.

La compatibilità con l'app effettivamente installata sul telefono non è verificabile
senza controllarne il certificato. Se Android segnala una firma incompatibile, non
disinstallare alla cieca: per un aggiornamento compatibile serve la firma originale.
Budget e giocate rimangono sul server, ma disinstallare cancella la sessione locale.
La Nightly cloud non richiede PC o smartphone accesi.

Download: [FootPredictor 1.1.7 APK di prova](https://github.com/Ivandragon003/scommeseSportive/releases/download/android-v1.1.7-debug-20261101/FootPredictor-1.1.7-debug.apk).
Funzionamento: [anteprima C e priorità Nightly](operations/challenger-preview-2026-10-31.md).
Verifiche, firma e checksum: [report della 1.1.7](android/releases/1.1.7-2026-11-01.md).
Le precedenti [1.1.6](android/releases/1.1.6-2026-10-31.md), [1.1.5](android/releases/1.1.5-2026-10-31.md) e
[1.1.4](android/releases/1.1.4-2026-10-31.md) conservano i rispettivi report storici.

## 1. Configurare l'accesso condiviso su Hostless

Il backend in produzione non parte senza `SHARED_ADMIN_PASSWORD_HASH`. Genera il valore
localmente senza scrivere la password nella cronologia della shell:

```powershell
cd backend
npm run build
$securePassword = Read-Host 'Password condivisa (almeno 12 caratteri)' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
  $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
  $passwordHash = $plainPassword | node scripts/generate-shared-admin-password-hash.js
} finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
  Remove-Variable plainPassword -ErrorAction SilentlyContinue
}
$passwordHash
```

Imposta nel servizio backend Hostless:

- `NODE_ENV=production`, necessario per cookie sicuri e gestione corretta del proxy HTTPS;
- `SHARED_ADMIN_PASSWORD_HASH`: il valore `scrypt$...` appena generato;
- `SHARED_ADMIN_AUTH_ENABLED=true`;
- `SHARED_DATA_USER_ID=user1` per conservare il bankroll già esistente;
- `CORS_ORIGIN=https://scommese-sportive-frontend.hostless.site,https://localhost`.

La stessa password va comunicata solo al secondo amministratore. Non va inserita nel
repository, nell'APK o nelle variabili `REACT_APP_*`.

## 2. Generare un APK di prova

Requisiti: Node.js 22+, Android SDK 36 e JDK 21. Dalla cartella `frontend`:

```powershell
npm ci
npm run mobile:sync
cd android
./gradlew.bat assembleDebug
```

L'APK risultante è:

```text
frontend/android/app/build/outputs/apk/debug/app-debug.apk
```

Può essere copiato sui due telefoni e installato abilitando temporaneamente
"Installa app sconosciute" per l'app usata per aprire il file.

## 3. APK release firmato per gli aggiornamenti

Perché gli aggiornamenti si installino sopra la versione precedente, usa sempre il
keystore originale. Se manca, recuperalo dal backup privato: crearne un altro non
produce un aggiornamento con firma compatibile. La configurazione prevista è
`frontend/android/key.properties`, secondo [key.properties.example](../frontend/android/key.properties.example), con percorso,
alias e password originali. Il file `key.properties` e i file `*.jks` sono esclusi da Git.

```powershell
cd frontend
npm run mobile:sync
cd android
./gradlew.bat assembleRelease
```

L'APK firmato sarà in:

```text
frontend/android/app/build/outputs/apk/release/app-release.apk
```

`mobile:sync` ricompila il frontend in produzione e aggiorna gli asset Android.
Imposta `JAVA_HOME` sul JDK 21 e `ANDROID_HOME` sulla cartella Android SDK prima
della build. Ogni aggiornamento distribuito deve incrementare `versionCode` in
`frontend/android/app/build.gradle`. La release richiede la firma configurata e
non abilita la modalita debug.

Esegui prima il deploy coordinato del backend e del frontend, poi distribuisci l'APK.
Senza il nuovo backend autenticato l'APK non può completare il login.

## 4. Verificare il filtro nativo delle giocate

La configurazione 1.1.3 (`versionCode=5`) usa lo stesso backend Hostless; il numero
di versione nel progetto non dimostra la disponibilità di un APK release firmato.
Il riuso persistente della calibrazione richiede la pubblicazione
del backend e del workflow nightly aggiornati: non viene eseguito nell'APK.
Le credenziali Turso e dei provider restano sul server.

L'aggiornamento 1.1.2 (`versionCode=4`) mantiene la firma privata esistente e
distribuisce la UI con giocatori, player props e formazioni sospesi. Le
ottimizzazioni letture e la pausa server richiedono anche il deploy backend;
installare il nuovo APK da solo non aggiorna il server.

La versione 1.1.1 limita lo sfondo dello splash alla finestra Android, evitando
che le righe del selettore degli esiti ereditino l'altezza dell'immagine.
Il test `NativeFilterLayoutTest` verifica le quattro opzioni dopo il passaggio
dal tema di avvio al tema dell'app.

Dalla cartella `frontend/android`, con JDK 21 e SDK Android configurati:

```powershell
./gradlew.bat :app:assembleDebug :app:testDebugUnitTest :app:assembleDebugAndroidTest
```

Con un emulatore o dispositivo di test già avviato:

```powershell
./gradlew.bat :app:connectedDebugAndroidTest "-Pandroid.testInstrumentationRunnerArguments.class=it.footpredictor.personal.NativeFilterLayoutTest"
```

Il prefisso `:app:` limita la verifica al modulo applicativo. Il test controlla
il layout nativo senza effettuare login o chiamate al backend.
