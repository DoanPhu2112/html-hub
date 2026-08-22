FROM oven/bun:1.2-alpine

WORKDIR /app
ENV NODE_ENV=production
ENV PORT=4173
ENV DATA_DIR=/app/data
ENV UPLOAD_DIR=/app/uploads

COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install

COPY categories.json ./categories.json
COPY src ./src
COPY public ./public

RUN mkdir -p /app/data /app/uploads
EXPOSE 4173
CMD ["bun", "src/server.js"]
