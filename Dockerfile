FROM node:18-alpine

WORKDIR /app

# Install Claude Code globally during build
RUN npm install -g @anthropic-ai/claude-code

# Copy package files and install dependencies
COPY package.json ./
RUN npm install --production

# Copy server
COPY server.js ./

EXPOSE 3000

CMD ["node", "server.js"]
