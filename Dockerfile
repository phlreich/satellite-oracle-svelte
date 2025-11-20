# satellite-oracle-svelte/Dockerfile
FROM node:24
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
EXPOSE 3000
CMD [ "node", "build" ]
