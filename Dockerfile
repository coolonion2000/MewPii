# pii web — dsh-styled Web UI for the pi coding agent
# Node 22.19+ required (pi SDK requirement).
FROM node:22-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-slim
# git for the Git tab / pi's git integrations; ca-certs for HTTPS model APIs
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates openssh-client && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NODE_ENV=production NODE_OPTIONS=--max-old-space-size=768 PII_WORKSPACE_ROOTS=/code:/app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
# production deps only (pi SDK + ws)
RUN npm ci --omit=dev --no-audit --no-fund
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/server/bin server/bin
COPY --from=build /app/web/dist web/dist
COPY README.md LICENSE NOTICE ./

# pi state persists here, including web-created skills at /root/.pi/agent/skills
VOLUME /root/.pi
EXPOSE 31041
ENV PII_HOST=0.0.0.0 PII_PORT=31041
# REQUIRED when listening on 0.0.0.0: PII_PASSWORD=<strong password>
ENTRYPOINT ["node", "server/bin/mewpii.js"]
