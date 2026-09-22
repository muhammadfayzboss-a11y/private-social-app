# Circle runs straight from source: no dependencies, no build step.
FROM node:22-alpine

# su-exec is used by the entrypoint to drop privileges after preparing the data volume.
RUN apk add --no-cache su-exec

WORKDIR /app
COPY . .
RUN chmod +x /app/docker-entrypoint.sh

ENV NODE_ENV=production \
    PORT=8080 \
    DATABASE_PATH=/data/circle.db \
    UPLOAD_DIR=/data/uploads

# /data must be a mounted volume so the database and media survive restarts.
VOLUME ["/data"]
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# The entrypoint fixes volume ownership and then runs the server as the "node" user.
ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "--disable-warning=ExperimentalWarning", "src/server.js"]
