FROM node:22-bookworm AS build

WORKDIR /app
COPY package.json package-lock.json .npmrc ./
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=3001 \
    HOSTNAME=0.0.0.0 \
    DATA_DIR=/data
WORKDIR /app
COPY --from=build /app ./
RUN mkdir -p /data
VOLUME ["/data"]
EXPOSE 3001
CMD ["npm", "run", "start", "--", "-H", "0.0.0.0", "-p", "3001"]
