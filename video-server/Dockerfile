# ── build stage: node-canvas をビルド（プリビルドが無いCPUでもOK） ──
FROM node:20-bookworm-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       build-essential python3 pkg-config \
       libcairo2-dev libpango1.0-dev libjpeg62-turbo-dev \
       libgif-dev librsvg2-dev \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev

# ── runtime stage: 実行に必要なものだけ ──
FROM node:20-bookworm-slim

# ffmpeg: 動画生成
# fonts-ipafont-gothic: MSゴシックに近いIPAゴシック（動画の文字に使用）
# fonts-noto-cjk: フォールバック用日本語フォント
# libcairo2等: node-canvas のランタイムライブラリ
RUN apt-get update \
  && apt-get install -y --no-install-recommends \
       ffmpeg ca-certificates fonts-ipafont-gothic fonts-noto-cjk \
       libcairo2 libpango-1.0-0 libpangocairo-1.0-0 \
       libjpeg62-turbo libgif7 librsvg2-2 \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY . .

ENV PORT=3000
EXPOSE 3000
CMD ["npm", "start"]
