FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build
CMD ["sh", "-c", "node -r ts-node/register src/db/migrate.ts && node dist/app.js"]
