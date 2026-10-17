FROM node:20-bookworm-slim

ENV DEBIAN_FRONTEND=noninteractive \
    NODE_ENV=production

RUN apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        chromium \
        curl \
        ffmpeg \
        fonts-liberation \
        procps \
        pulseaudio \
        pulseaudio-utils \
        python3 \
        python3-socks \
        xauth \
        xvfb \
    && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --shell /bin/bash bot \
    && mkdir -p /home/bot/.local/bin \
    && curl -fsSL "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp" \
        -o /home/bot/.local/bin/yt-dlp \
    && chmod 755 /home/bot/.local/bin/yt-dlp \
    && chown -R bot:bot /home/bot

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev && chown -R bot:bot /app

COPY bot.js start.sh ./
RUN chmod 755 start.sh && chown bot:bot bot.js start.sh

USER bot

ENV PATH="/home/bot/.local/bin:${PATH}" \
    HOME="/home/bot" \
    CHROMIUM_PATH="/usr/bin/chromium"

CMD ["./start.sh"]
