FROM node:20-alpine

# Install native build deps for @napi-rs/canvas and Baileys
RUN apk add --no-cache \
    python3 make g++ \
    cairo-dev pango-dev jpeg-dev giflib-dev librsvg-dev \
    fontconfig ttf-dejavu

WORKDIR /app

# Configure npm for reliability inside Docker
RUN npm config set fetch-retry-mintimeout 20000 && \
    npm config set fetch-retry-maxtimeout 120000 && \
    npm config set fetch-retries 5

# Install dependencies (cached layer)
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy source files
COPY src/       ./src/
COPY public/    ./public/
COPY assets/    ./assets/
COPY index.js   ./

# Persistent data directory (mounted as volume at runtime)
RUN mkdir -p data/sessions data/invoices data/images

ENV NODE_ENV=production
ENV PORT=3000

EXPOSE 3000
STOPSIGNAL SIGTERM

CMD ["node", "src/server.js"]
