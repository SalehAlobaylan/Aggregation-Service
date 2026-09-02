# Build stage
FROM node:22-alpine AS builder

WORKDIR /app

# Node 22 may need to compile optional native transports when a matching
# prebuilt artifact is unavailable for the target architecture.
RUN apk add --no-cache python3 make g++

# Copy package files
COPY package*.json ./

# Install dependencies
RUN npm ci

# Copy source code
COPY tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN npm run build

# Production stage
FROM node:22-slim AS production

WORKDIR /app

# Install system dependencies: ffmpeg, yt-dlp, python3
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    python3 \
    python3-pip \
    build-essential \
    curl \
    wget \
    && pip3 install --no-cache-dir --break-system-packages yt-dlp==2026.8.19 yt-dlp-ejs==0.8.0 bgutil-ytdlp-pot-provider==1.3.1 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*

# Copy package files
COPY package*.json ./

# Install production dependencies only, then remove the compiler toolchain.
# Runtime Python remains because yt-dlp itself is a Python application.
RUN npm ci --omit=dev \
    && apt-get purge -y --auto-remove build-essential \
    && rm -rf /var/lib/apt/lists/* /root/.npm

# Copy built files from builder
COPY --from=builder /app/dist ./dist

# Create temp directory for media processing
RUN mkdir -p /tmp/wahb-media && chmod 777 /tmp/wahb-media

# Create non-root user
RUN groupadd -g 1001 nodejs && \
    useradd -u 1001 -g nodejs -s /bin/bash aggregation

# Change ownership
RUN chown -R aggregation:nodejs /app /tmp/wahb-media

# Switch to non-root user
USER aggregation

# Expose metrics/admin port used by the service
EXPOSE 5002

# Health check
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:5002/health || exit 1

# Start the service
CMD ["node", "dist/index.js"]
