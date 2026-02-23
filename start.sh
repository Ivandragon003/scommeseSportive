#!/bin/bash
# Script avvio FootPredictor su Linux/Mac

set -e

echo "🔍 Verifica Docker..."
if ! command -v docker &> /dev/null; then
    echo "❌ Docker non trovato. Installalo da https://docker.com"
    exit 1
fi

if ! docker info &> /dev/null; then
    echo "❌ Docker non è in esecuzione. Avvialo prima."
    exit 1
fi

echo "📁 Creazione cartella dati..."
mkdir -p ./data

echo "🔨 Build e avvio container (prima volta richiede 3-5 minuti)..."
docker compose up --build -d

echo ""
echo "✅ FootPredictor avviato!"
echo "   🌐 Frontend: http://localhost:3000"
echo "   🔌 Backend:  http://localhost:3001/api/health"
echo ""
echo "Per fermare: docker compose down"
echo "Per vedere i log: docker compose logs -f"
