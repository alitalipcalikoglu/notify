# Build from this directory: docker build -t atc-notify .
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-alpine
ENV NODE_ENV=production DB_PATH=/data/notify.db PORT=3001
WORKDIR /app
RUN mkdir -p /data && chown node:node /data
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY openapi.yaml ./
COPY src ./src
USER node
VOLUME ["/data"]
EXPOSE 3001
HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- --no-check-certificate "$( [ -n "$TLS_CERT_PATH" ] && echo https || echo http )://127.0.0.1:3001/health" || exit 1
CMD ["node", "--disable-warning=ExperimentalWarning", "src/index.js"]
