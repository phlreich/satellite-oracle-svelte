# satellite-oracle-svelte/Dockerfile
FROM node:24
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
RUN chown -R node:node /usr/src/app
USER node
EXPOSE 3000
CMD [ "node", "scripts/start-server-with-warmup.mjs" ]
