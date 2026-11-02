FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY dist ./dist
USER node
# stdio transport: the container is executed by the agent host, not served.
ENTRYPOINT ["node", "dist/index.js"]
