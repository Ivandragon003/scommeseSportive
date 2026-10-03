# FootPredictor su Android (APK privato)

L'app Android usa la stessa UI React e lo stesso backend Hostless della versione desktop.
Non contiene database, budget o password: budget, giocate e archivio restano nel database
Turso condiviso sotto l'utente canonico `user1`.

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

Perché gli aggiornamenti si installino sopra la versione precedente, conserva sempre lo
stesso keystore. Crealo una volta sola in una cartella privata, poi copia
`frontend/android/key.properties.example` in `frontend/android/key.properties` e inserisci
percorso, alias e password reali. Il file `key.properties` e i file `*.jks` sono esclusi da Git.

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
