# ── Build stage ──────────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Copy dependency manifests first (layer cache optimization)
COPY package*.json ./
RUN npm ci --omit=dev

# ── Production stage ──────────────────────────────────────────────────────────
FROM node:20-alpine

# Non-root user for security
RUN addgroup -S webhook && adduser -S webhook -G webhook

WORKDIR /app

# Copy dependencies from builder
COPY --from=builder /app/node_modules ./node_modules

# Copy application source (excludes .dockerignore entries)
COPY . .

# Create logs directory
RUN mkdir -p logs && chown -R webhook:webhook /app

USER webhook

ENV NODE_ENV=production
ENV PORT=4000

EXPOSE 4000

# Health check — polls the public system/info endpoint
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:4000/api/system/info || exit 1

CMD ["node", "server.js"]
