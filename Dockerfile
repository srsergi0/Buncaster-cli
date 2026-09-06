# Stage 1: compilar binario estático y bundle del frontend
FROM oven/bun:alpine AS builder
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
RUN bun install --frozen-lockfile
COPY src ./src
COPY public ./public
# Pre-compilar bundle del frontend web para servirlo de forma instantánea
RUN bun build src/web/App.tsx --outfile=public/app.js --target=browser
# Compilar binario autónomo de Buncaster
RUN bun build --compile --target=bun-linux-x64-modern --outfile=buncaster src/cli.ts

# Stage 2: imagen mínima de producción (solo ffmpeg + binario + estáticos)
FROM alpine:3.20
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY --from=builder /app/buncaster /app/buncaster
COPY --from=builder /app/public /app/public

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-4321}/health" || wget -qO- "http://127.0.0.1:8080/health" || exit 1

EXPOSE 8080
EXPOSE 4321
EXPOSE 1935
EXPOSE 1936/udp

ENV NODE_ENV=production
ENV NO_PROMPT=true

CMD ["/app/buncaster", "-y"]
