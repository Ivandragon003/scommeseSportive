# FootPredictor su Android (APK privato)

L'app Android include una copia della UI React e usa lo stesso backend Hostless della versione web.
Capacitor usa `webDir: 'build'` e non configura `server.url`: l'APK carica gli asset
inclusi nel pacchetto, non il sito frontend remoto. Un deploy web non aggiorna la UI dell'APK.
Non contiene database, budget o password: budget, giocate e archivio restano nel database
Turso condiviso sotto l'utente canonico `user1`.

## Revisione web successiva alla 1.1.10

Giocate usa ora filtri più leggibili e targhette distinte per A, C e baseline.
Budget riprende il layout precedente con riepilogo, grafico e capitale del modello
selezionato; il confronto mostra due portafogli indipendenti. Questa revisione è
disponibile nel Docker locale e non è inclusa nell'APK 1.1.10 già generato.
Su richiesta dell'utente, si genera un nuovo APK solo quando lo chiede esplicitamente.

PC e Android condividono componenti e funzioni; cambia la disposizione responsive.
La revisione successiva rende raggiungibili su entrambi il filtro Giocate chiuse,
ritorno/profitto nei dettagli, conteggi e riepiloghi, tema e glossario. La vista telefono
riduce spazi e altezza delle schede, mantenendo grafico e dati disponibili.
Queste modifiche al sorgente non aggiornano automaticamente l'APK già installato:
esso conserva gli asset inclusi nella sua build. Il client Android usa Hostless,
il web locale usa `/api` verso Docker; eventuali differenze di dati o versione del
backend vanno distinte da funzioni nascoste nel layout.

## Aggiornamento locale 1.1.10: Giocate unificate

La 1.1.10 / `versionCode=12` riunisce le giocate precedenti e A/C nella grafica
del registro precedente, su desktop e mobile. Le registrazioni prive di famiglia
A/C sono presentate come Baseline deterministica, senza ricalcoli retroattivi o
trasferimenti fra portafogli. Vedi [verifiche e pacchetto locale](android/releases/1.1.10-2026-11-01.md).
Il nuovo APK va installato per aggiornare la UI Android; non è stato pubblicato su GitHub.

## Versione precedente 1.1.9 release compatibile

La versione Android è `1.1.9` / `versionCode=11`, build release con debug disattivato. Include
il confronto dei consigli A/C nel dettaglio partita, compilato in un worktree isolato
dal commit `27c4c17d`. Comprende anche la [pulizia del client portafogli](operations/wallet-client-cleanup-2026-11-01.md),
assente dal precedente APK 1.1.8.
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
Giocate, Archivio e relativo dettaglio mostrano segno e nome della selezione:
`1`, `X`, `2`, `1X`, `X2`, `12`, `DNB 1/2`, Goal/No Goal e Over/Under con
soglia a punto decimale, per esempio `Under 2.5 gol`. DNB conserva l'avviso di
rimborso sul pareggio: non viene presentato come doppia chance.

Mancano ancora `frontend/android/key.properties` e il keystore release originale.
Si riutilizza esclusivamente il keystore debug già esistente, senza creare nuove chiavi.
Il precedente APK locale 1.1.1/code 3 ha lo stesso certificato Android Debug SHA-256
`21f01c0666c42ac6b960a0c840fbbef27c1bd833e4a8ce21a9c0e4fe909b23df`.
La distribuzione usa la variante **release non debuggabile**, mantenendo quel
certificato di sviluppo per compatibilità. Non è una nuova firma privata di
produzione e non è destinata al Play Store.

L'utente ha indicato la 1.1.8 debug scaricata dal link GitHub. La compatibilità
con quell'APK e la conservazione dei dati sono verificate su emulatore; il telefono
fisico non è collegato. Se Android segnala una firma incompatibile, non
disinstallare alla cieca: per un aggiornamento compatibile serve la firma originale.
Budget e giocate rimangono sul server, ma disinstallare cancella la sessione locale.
La Nightly cloud non richiede PC o smartphone accesi.

Download: [FootPredictor 1.1.9 release compatibile](https://github.com/Ivandragon003/scommeseSportive/releases/download/android-v1.1.9-release-20261101/FootPredictor-1.1.9-release.apk).
Funzionamento: [anteprima C e priorità Nightly](operations/challenger-preview-2026-10-31.md).
Verifiche, firma e checksum: [report della 1.1.9](android/releases/1.1.9-2026-11-01.md).
Le precedenti [1.1.8](android/releases/1.1.8-2026-11-01.md), [1.1.7](android/releases/1.1.7-2026-11-01.md), [1.1.6](android/releases/1.1.6-2026-10-31.md), [1.1.5](android/releases/1.1.5-2026-10-31.md) e
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

### Release compatibile con gli APK privati precedenti

Dalla versione 1.1.9 è disponibile una modalità esplicita per aggiornare gli APK
debug già distribuiti: build `release` con debug disattivato e certificato storico
invariato. Non crea né sostituisce chiavi e non equivale a una firma privata di
produzione per il Play Store. Il backend e l'origine WebView restano invariati.

```powershell
cd frontend/android
./gradlew.bat :app:assembleRelease -PcompatibleReleaseSigning=true
```

La modalità richiede il keystore storico già presente. Se manca, la build si
interrompe prima di poter generare una nuova chiave. Senza il parametro esplicito
resta obbligatoria la configurazione release `key.properties`. Prima di distribuire
il file, confronta con `apksigner verify --print-certs` il certificato dell'APK
precedente e quello nuovo: devono coincidere. Il file finale deve avere package
`it.footpredictor.personal`, codice versione maggiore e flag `debuggable=false`.

Il mantenimento dei dati va verificato installando con aggiornamento (`adb install -r`)
sopra l'APK effettivamente distribuito, senza disinstallazione o cancellazione dati.
Budget e giocate restano sul backend condiviso; sessioni scadute o revocate possono
comunque richiedere un nuovo login. Una prova su emulatore non certifica il telefono.

Il test strumentale `UpgradeDataPreservationTest` usa un marker QA univoco, file,
preferenze, SQLite, localStorage dell'origine reale e un cookie persistente
fittizio. Non avvia la schermata applicativa e blocca la rete. Esegui separatamente
`classe#seedData` sull'APK precedente, `classe#verifyData` dopo l'aggiornamento e
`classe#cleanupData` alla fine, passando lo stesso `-e qaMarker qa_upgrade_<suffisso>`.
Non eseguire l'intera classe insieme: le fasi dipendono dall'aggiornamento esterno.
Il cookie prova la conservazione dello store, non il login remoto o i cookie
partizionati della sessione reale.

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
