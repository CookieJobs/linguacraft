# Build stage
FROM node:20-alpine AS builder
WORKDIR /app
COPY backend/package.json backend/package-lock.json backend/tsconfig.json ./
RUN npm ci
COPY backend/src ./src
RUN npm run build

# Production stage
FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --production && apk del python3 make g++
COPY --from=builder /app/dist ./dist
COPY backend/scripts ./scripts
COPY data ./data
EXPOSE 5500
CMD ["node", "dist/main.js"]
