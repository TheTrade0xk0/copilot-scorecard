FROM node:18-alpine

RUN apk add --no-cache bash curl

WORKDIR /app

# Install Claude Code globally during build (cached)
RUN npm install -g @anthropic-ai/claude-code

COPY package.json ./
RUN npm install --production

COPY server.js ./

EXPOSE 3000

CMD ["node", "server.js"]
