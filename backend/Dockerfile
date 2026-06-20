# Build stage
FROM node:20-alpine AS builder
WORKDIR /app
COPY backend/package.json backend/package-lock.json backend/tsconfig.json ./
RUN npm ci
COPY backend/src ./src
RUN npm run build
# 把 backfill 脚本也编译成 .js (脚本只依赖 mongoose/dotenv, 不引用 src/)
# 这样 production 镜像不需要装 ts-node, deploy 时直接 node 跑编译产物
COPY backend/scripts ./scripts
RUN npx tsc scripts/backfill-schema-defaults.ts \
    --outDir ./scripts-compiled \
    --module commonjs --target es2017 \
    --esModuleInterop --resolveJsonModule --skipLibCheck

# Production stage
FROM node:20-alpine
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev && apk del python3 make g++
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/scripts-compiled/backfill-schema-defaults.js ./scripts/backfill-schema-defaults.js
COPY data ./data
EXPOSE 5500
CMD ["node", "dist/main.js"]
