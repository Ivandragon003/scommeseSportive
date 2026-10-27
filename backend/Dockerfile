# Pin the runtime used by both the web app and the T-15 worker.
FROM node:20-bookworm-slim@sha256:2cf067cfed83d5ea958367df9f966191a942351a2df77d6f0193e162b5febfc0 AS node-base

FROM node-base AS builder

WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts/clean-build.js ./scripts/clean-build.js
RUN npm run build

# Optional local verification image. Python/CatBoost is a training/parity tool;
# production inference reads the numeric JSON trees directly in Node.
FROM builder AS ml-verification
USER root
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-venv libgomp1 \
    && rm -rf /var/lib/apt/lists/*
COPY ml/requirements-linux-verification.txt ./ml/requirements-linux-verification.txt
RUN python3 -m venv /opt/ml && /opt/ml/bin/pip install --no-cache-dir -r ml/requirements-linux-verification.txt
ENV ML_PYTHON=/opt/ml/bin/python
COPY ml ./ml
COPY test ./test
COPY scripts ./scripts

FROM node-base AS runtime

WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

ENV NODE_ENV=production

COPY --from=builder /app/dist ./dist
COPY migrations ./migrations
COPY scripts ./scripts

# Runtime data and scratch files are ephemeral; Turso remains the shared store.
RUN mkdir -p /app/data /app/artifacts && chown -R node:node /app
USER node

EXPOSE 3001

HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3001)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/index.js"]
