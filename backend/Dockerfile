# Stage 1: compilazione TypeScript
FROM node:20 AS builder

WORKDIR /app

COPY package*.json ./
# Installa TUTTO (incluso playwright) per la compilazione TypeScript
RUN npm install

# Installa playwright anche qui per i tipi durante la compilazione
RUN npx playwright install chromium || true

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# Stage 2: runtime
FROM node:20 AS runtime

WORKDIR /app

COPY package*.json ./
RUN npm install

# Scarica Chromium con tutte le dipendenze di sistema
RUN npx playwright install --with-deps chromium

COPY --from=builder /app/dist ./dist

EXPOSE 3001

CMD ["node", "dist/index.js"]
