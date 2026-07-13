FROM node:22.17-alpine

WORKDIR /app

COPY --chown=node:node package.json ./
COPY --chown=node:node src ./src

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3000

USER node

EXPOSE 3000

CMD ["node", "src/server.js"]
