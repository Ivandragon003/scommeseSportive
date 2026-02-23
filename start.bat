@echo off
echo Verifica Docker...
docker info >nul 2>&1
if %errorlevel% neq 0 (
    echo ERRORE: Docker non e' in esecuzione. Avvialo prima.
    pause
    exit /b 1
)

echo Creazione cartella dati...
if not exist "data" mkdir data

echo Build e avvio container (prima volta richiede 3-5 minuti)...
docker compose up --build -d

echo.
echo FootPredictor avviato!
echo   Frontend: http://localhost:3000
echo   Backend:  http://localhost:3001/api/health
echo.
echo Per fermare: docker compose down
echo Per i log:   docker compose logs -f
pause
