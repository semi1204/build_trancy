FROM node:22-bookworm-slim

ENV NODE_ENV=production
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund
COPY adapter.mjs ./

USER node
ENTRYPOINT ["node", "/app/adapter.mjs"]
