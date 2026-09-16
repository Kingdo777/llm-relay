ARG BASE_IMAGE=llm-relay-base:latest
FROM ${BASE_IMAGE}

WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN sha256sum -c /usr/local/share/llm-relay-base-deps.sha256 \
    || (echo "Dependencies changed or incompatible base image; rebuild Dockerfile.Base and set BASE_IMAGE to the new image." >&2; exit 1)
COPY . .
RUN npm run build && npm prune --omit=dev --offline --ignore-scripts --no-audit --no-fund

ENV NODE_ENV=production \
    PORT=3001 \
    HOSTNAME=0.0.0.0 \
    DATA_DIR=/data
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 3001
CMD ["npm", "run", "start", "--", "-H", "0.0.0.0", "-p", "3001"]
