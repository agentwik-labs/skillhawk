FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY bin ./bin
COPY src ./src
COPY web ./web
COPY registry ./registry
COPY seed ./seed
ENV HOST=0.0.0.0 PORT=7420 SKILLYARD_DATA=/data
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 7420
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:7420/api/health || exit 1
# Serve only. The demo data (`seed`) is for local trials: docker run ... skillhawk node bin/skillyard.js seed
CMD ["node", "bin/skillyard.js", "serve", "--log"]
