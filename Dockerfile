FROM node:22-bookworm-slim

# poppler-utils: pdfinfo (titles, page counts) and pdftoppm (PDF covers)
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
# .npmrc sets ignore-scripts: every native dep ships prebuilt binaries, so no compiler is needed
COPY package.json package-lock.json .npmrc ./
RUN npm ci --omit=dev
COPY tsconfig.json ./
COPY src ./src
COPY public ./public

# The container listens on all interfaces; shelf.sh publishes the port on 127.0.0.1 only,
# because there is no login. Don't publish it more widely without putting auth in front.
ENV LIBRARY_DIR=/library DATA_DIR=/data HOST=0.0.0.0 PORT=4321 SHELF_DOCKER=1
# Create /data owned by the unprivileged user *before* declaring the volume, so a fresh named
# volume inherits that ownership (otherwise it is root-owned and the app can't write its database).
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 4321
USER node
CMD ["node_modules/.bin/tsx", "src/server.ts"]
