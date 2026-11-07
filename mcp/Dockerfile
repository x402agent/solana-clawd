# solana-clawd MCP Server — Fly.io Dockerfile
# Deploy: fly launch --config mcp/fly.toml && fly deploy

FROM node:22-alpine AS builder

WORKDIR /app/mcp

# Copy package files and install deps
COPY mcp/package.json mcp/package-lock.json mcp/tsconfig.json ./
RUN npm ci

# Copy source and build
COPY mcp/src ./src
RUN npm run build

# ─── Runtime ──────────────────────────────────────────────────────────────────
FROM node:22-alpine

WORKDIR /app/mcp

# Copy only production deps
COPY mcp/package.json mcp/package-lock.json ./
RUN npm ci --omit=dev

# Copy built dist
COPY --from=builder /app/mcp/dist ./dist

# Copy SOUL.md and skills directory (for MCP resources)
COPY SOUL.md /app/SOUL.md
COPY skills /app/skills
COPY src /app/src
COPY README.md /app/README.md

# Environment defaults
ENV PORT=3000
ENV NODE_ENV=production

EXPOSE 3000

# Health check for Fly.io
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://localhost:3000/health').then(r=>r.ok?process.exit(0):process.exit(1)).catch(()=>process.exit(1))"

CMD ["node", "dist/http.js"]
