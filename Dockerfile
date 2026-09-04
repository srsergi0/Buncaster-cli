# Stage 1: compilar binario estático con bun build --compile
FROM oven/bun:alpine AS builder
WORKDIR /app
COPY package.json bun.lock tsconfig.json ./
RUN bun install --production --frozen-lockfile
COPY src ./src
RUN bun build --compile --target=bun-linux-x64-modern --outfile=buncaster src/index-rtmp.ts

# Stage 2: imagen mínima de runtime (solo ffmpeg + binario)
FROM alpine:3.20
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY --from=builder /app/buncaster /app/buncaster
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-8080}/health" || exit 1
EXPOSE 8080
EXPOSE 1935
EXPOSE 1936/udp
ENV NODE_ENV=production
CMD ["/app/buncaster"]
