FROM node:22-slim AS deps
WORKDIR /app
COPY gateway/package*.json ./
RUN npm install --omit=dev --no-audit --no-fund

FROM node:22-slim AS build
WORKDIR /app
COPY gateway/package*.json ./
RUN npm install --no-audit --no-fund
COPY gateway ./gateway
COPY formal_verification ./formal_verification
WORKDIR /app/gateway
RUN npm run build

FROM node:22-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/gateway/dist ./dist
COPY gateway/package*.json ./
COPY skills ./skills
COPY agents/agents-catalog.json agents/agents-manifest.json ./agents/
COPY agents/src ./agents/src
COPY formal_verification/skill-hub-registry.json ./formal_verification/skill-hub-registry.json
EXPOSE 8080
CMD ["node", "dist/gateway/src/index.js"]
