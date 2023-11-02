# satellite-oracle-svelte/Dockerfile
FROM node:latest
WORKDIR /usr/src/app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
EXPOSE 3000
CMD [ "node", "build" ]
