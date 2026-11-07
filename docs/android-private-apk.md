# FootPredictor Android: APK privato

L'app include gli asset React compilati e usa le API condivise. Il sorgente
[Gradle](../frontend/android/app/build.gradle) dichiara versione **1.1.12**,
`versionCode=14`, package `it.footpredictor.personal`, release non debuggabile.
Questo numero non attesta un APK generato, distribuito o installato: tali
stati richiedono il controllo dell'artefatto e del dispositivo effettivi.
Una modifica web non autorizza automaticamente la build o distribuzione APK.

## UI inclusa e backend condiviso

[Capacitor](../frontend/capacitor.config.ts) usa `webDir: build`, hostname
`localhost` e schema Android `https`, senza `server.url`: carica la UI
inclusa nel pacchetto. Un deploy frontend non aggiorna gli asset dell'APK.
Il [client API](../frontend/src/utils/api.ts) usa `REACT_APP_API_URL` se
impostata in build, altrimenti il backend Hostless
`https://scommese-sportive-backend.hostless.app/api` sulla piattaforma nativa.

Portafogli, giocate e archivio risiedono nel Turso del backend. Sessione,
cookie e dati WebView locali restano invece sul dispositivo. Non inserire
password condivisa, token Turso o chiavi quote nell'APK o in `REACT_APP_*`.
Il backend deve consentire `https://localhost` nelle origini CORS e mantenere
HTTPS, autenticazione e identità utente coerenti. Per il rilascio server
vedere [Hostless](operations/hostless-deployment.md); per il comportamento
delle pagine vedere [operazioni](operations/README.md).

## Build autorizzata

Servono dipendenze frontend, JDK 21 e Android SDK con piattaforma 36,
coerente con [variables.gradle](../frontend/android/variables.gradle).
Configurare `JAVA_HOME` e `ANDROID_HOME` nell'ambiente locale appropriato.
Da `frontend`:

```powershell
npm ci
npm run mobile:sync
cd android
./gradlew.bat :app:assembleDebug
```

`mobile:sync` esegue la build React di produzione e sincronizza gli asset.
L'APK debug si trova in
`frontend/android/app/build/outputs/apk/debug/app-debug.apk`.
Non presentarlo come release di distribuzione.

Per una release firmata configurare privatamente
`frontend/android/key.properties` secondo
[key.properties.example](../frontend/android/key.properties.example), usando
il keystore e l'alias originali. Non creare una nuova chiave per tentare di
aggiornare un APK già distribuito. Dalla cartella `frontend/android`, dopo
la sincronizzazione degli asset:

```powershell
./gradlew.bat :app:assembleRelease
```

Output: `frontend/android/app/build/outputs/apk/release/app-release.apk`.
La build release richiede `key.properties`, salvo la modalità esplicita
seguente; il flag debug resta disattivato.

## Compatibilità con gli APK privati precedenti

L'aggiornamento richiede **stesso package, stesso certificato e versionCode
maggiore** della versione installata. L'etichetta debug/release non basta a
stabilire la compatibilità. Verificare l'APK realmente distribuito o installato,
non dedurre la sua firma dal solo nome del file.

Il progetto permette una release privata compatibile con il certificato
storico debug, soltanto se il relativo keystore esiste già:

```powershell
./gradlew.bat :app:assembleRelease -PcompatibleReleaseSigning=true
```

Se la chiave storica manca la build si interrompe, senza generarne una nuova.
Questa firma conserva la compatibilità privata: **non equivale a una firma
release pronta per il Play Store**. Senza il parametro resta richiesta la
configurazione release ordinaria. Non pubblicare keystore o password.

Prima della distribuzione:

1. Confrontare vecchio e nuovo APK con `apksigner verify --print-certs` e
   controllare package, versionCode e `debuggable=false` sull'artefatto finale.
2. Installare sul baseline effettivo mediante `adb install -r <nuovo-apk>`,
   senza disinstallazione o cancellazione dati. Se la firma non coincide,
   recuperare la chiave corretta; non rimuovere l'app per aggirare l'errore.
3. Verificare dati locali, avvio, login/sessione, navigazione e connessione
   al backend previsto. I saldi remoti richiedono una verifica separata:
   conservarli non è una proprietà dimostrata dal solo aggiornamento APK.
4. Conservare versione, certificato e SHA-256 dell'artefatto verificato nella
   consegna privata. Verificare separatamente il file distribuito e scaricato.

`UpgradeDataPreservationTest` offre fasi distinte `seedData`, `verifyData` e
`cleanupData`, con lo stesso `-e qaMarker qa_upgrade_<suffisso>`.
Eseguire seed sul vecchio APK, aggiornare, verificare sul nuovo e ripulire
alla fine. Non lanciare tutta la classe insieme: dipende dall'aggiornamento
esterno. Controlla preferenze, file, SQLite, localStorage e cookie fittizio,
con rete bloccata; non prova login remoto o cookie reali di sessione.
Una prova su emulatore non certifica il telefono fisico.

## Controlli nativi

Per i controlli di build e layout, da `frontend/android`:

```powershell
./gradlew.bat :app:assembleDebug :app:testDebugUnitTest :app:assembleDebugAndroidTest
./gradlew.bat :app:connectedDebugAndroidTest "-Pandroid.testInstrumentationRunnerArguments.class=it.footpredictor.personal.NativeFilterLayoutTest"
```

Il secondo comando richiede un emulatore o dispositivo di test avviato.
`NativeFilterLayoutTest` controlla le opzioni native dopo il passaggio dal
tema di avvio, senza login o chiamate backend. Questi controlli non
sostituiscono firma, aggiornamento in-place e verifica dell'APK finale.
