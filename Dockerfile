# satellite-oracle-svelte/Dockerfile
FROM node:24 AS build
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime
WORKDIR /usr/src/app
ENV NODE_ENV=production
COPY --from=build --chown=node:node /usr/src/app/package*.json ./
COPY --from=build --chown=node:node /usr/src/app/node_modules ./node_modules
COPY --from=build --chown=node:node /usr/src/app/build ./build
COPY --from=build --chown=node:node /usr/src/app/scripts ./scripts
COPY --from=build --chown=node:node /usr/src/app/static ./static
RUN mkdir -p src/data && chown -R node:node /usr/src/app
USER node
EXPOSE 3000
CMD [ "node", "scripts/start-server-with-warmup.mjs" ]
