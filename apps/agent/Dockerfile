# Agent service image (Railway). Build context = the repo root, because the agent needs the pnpm workspace (packages/*).
# Railway: set RAILWAY_DOCKERFILE_PATH=apps/agent/Dockerfile on the agent service. Runs TypeScript with tsx, like the worker.
FROM node:22-bookworm-slim

# ffmpeg: voice notes in (CAF → WAV for speech-to-text) and out (MP3 → M4A voice bubbles).
RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable
WORKDIR /app
COPY . .
# --prod=false keeps tsx (a devDependency) even with NODE_ENV=production.
RUN pnpm install --frozen-lockfile --prod=false

ENV NODE_ENV=production
EXPOSE 4002
CMD ["pnpm", "--filter", "agent", "start"]
