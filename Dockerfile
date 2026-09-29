# GSRTC Live: no npm dependencies, so the image is just Node + our source.
FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    DATA_DIR=/app/data

WORKDIR /app
COPY package.json ./
COPY server ./server
COPY web ./web

# Position history lives here; mount a volume on it (see docker-compose.yml).
RUN mkdir -p /app/data && chown -R node:node /app
USER node

EXPOSE 8080
VOLUME ["/app/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# `node` directly (not npm) so SIGTERM reaches the server and history is flushed on stop.
CMD ["node", "server/index.js"]
