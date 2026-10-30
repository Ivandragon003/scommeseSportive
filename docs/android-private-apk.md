# FootPredictor su Android (APK privato)

L'app Android include una copia della UI React e usa lo stesso backend Hostless della versione web.
Capacitor usa `webDir: 'build'` e non configura `server.url`: l'APK carica gli asset
inclusi nel pacchetto, non il sito frontend remoto. Un deploy web non aggiorna la UI dell'APK.
Non contiene database, budget o password: budget, giocate e archivio restano nel database
Turso condiviso sotto l'utente canonico `user1`.

## Stato al 30 ottobre 2026: web aggiornato, APK non aggiornato

Il frontend web `3c503fa9` è stato pubblicato e verificato su Hostless. Include stake A
variabile dal consiglio, stake C fisso all'1% e consiglio Nightly archiviato con quota e
importo effettivamente registrati. Per avere questa UI su Android serve un nuovo APK.
Il backend configurato resta `https://scommese-sportive-backend.hostless.app/api`.

La preparazione dell'APK firmato è bloccata: nel checkout manca
`frontend/android/key.properties` e non sono disponibili un keystore release identificato
come quello originale e un precedente APK release con cui confrontare il certificato.
JDK 21 e SDK Android 36 sono presenti, ma non sostituiscono la firma mancante.
Non sono state create nuove chiavi né generati APK non firmati o con firma debug; versione Gradle
`1.1.3`/`versionCode=5` e asset Android sono rimasti invariati. Nessun APK 1.1.4 è stato generato.

Per riprendere servono il keystore originale e la sua configurazione locale privata,
oltre al precedente APK firmato o a un riferimento verificato del certificato. Non
inserire password o chiavi nella conversazione. Prima della distribuzione occorre
confrontare la firma e verificare aggiornamento, login, cookie e nuova UI su Android.
La compatibilità osservata nel browser non prova il comportamento della WebView su telefono.
Nel frattempo si può usare il sito web aggiornato; la Nightly cloud non richiede l'APK,
né PC o smartphone accesi.

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
