# The agent has zero runtime dependencies, so there is nothing to install:
# the core engine is dropped straight into node_modules and resolved from there.
FROM node:20-alpine

WORKDIR /app

COPY packages/core ./node_modules/@faultline/core
COPY packages/agent ./agent

WORKDIR /app/agent

RUN mkdir -p /app/data && chown -R node:node /app
USER node

ENV NODE_ENV=production \
    FAULTLINE_HOST=0.0.0.0 \
    FAULTLINE_PORT=8787 \
    FAULTLINE_STORAGE_PATH=/app/data/faultline-state.json

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.FAULTLINE_PORT||8787)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["node", "bin/faultline.js"]
CMD ["start"]
