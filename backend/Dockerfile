# Stage 1: compilazione TypeScript
FROM node:20 AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# Stage 2: runtime
FROM node:20 AS runtime

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY --from=builder /app/dist ./dist

EXPOSE 3001

CMD ["node", "dist/index.js"]
