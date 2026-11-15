FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --no-fund
COPY . .
RUN npm run build && npm run build:node

FROM node:24-bookworm-slim AS runtime
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data CONTAINER=true
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/migrations ./migrations
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 8080
VOLUME ["/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD ["node", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
CMD ["node", "server/start.mjs"]
