# Stage 1: build React
FROM node:20-alpine AS builder

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY public ./public
COPY src ./src
COPY tsconfig.json ./

ENV GENERATE_SOURCEMAP=false
RUN npm run build

# Stage 2: nginx
FROM nginx:1.25-alpine AS runtime

COPY --from=builder /app/build /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
CMD ["nginx", "-g", "daemon off;"]
