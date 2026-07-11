FROM node:22-slim

WORKDIR /app
COPY server/server.mjs ./server/server.mjs
RUN mkdir -p /var/lib/gandybnb && chown -R node:node /var/lib/gandybnb

USER node
ENV PORT=8787
ENV DATA_FILE=/var/lib/gandybnb/gandybnb.sqlite
EXPOSE 8787

CMD ["node", "--disable-warning=ExperimentalWarning", "server/server.mjs"]
