# NexaDesk AI - Production API Container
FROM node:20-alpine AS base

WORKDIR /app

RUN apk add --no-cache libc6-compat

# Copy package manifests
COPY package.json package-lock.json ./

# Install dependencies
RUN npm ci

# Copy application sources
COPY shared/ ./shared/
COPY apps/api/ ./apps/api/
COPY tsconfig.json tsconfig.app.json tsconfig.node.json ./

# Validate TypeScript compilation for the API
RUN npm run typecheck:api

# Run as non-root user
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 nexadesk

USER nexadesk

EXPOSE 3000

ENV NODE_ENV=production \
    PORT=3000 \
    HOST=0.0.0.0

HEALTHCHECK --interval=10s --timeout=3s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://127.0.0.1:3000/health/live || exit 1

CMD ["npm", "run", "start:api"]
