FROM node:24-alpine

WORKDIR /app

# Install dependencies first (better layer caching)
COPY package.json ./
RUN npm install --omit=dev

# Copy sources
COPY src ./src

# Listen on CapRover port
ENV PORT=3000

EXPOSE 3000

CMD ["node", "src/server.js"]
