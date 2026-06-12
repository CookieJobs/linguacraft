<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI app

本仓库已采用清晰的前后端分层：
- 前端（Vite + React）在 `frontend/`，开发端口 `300x`（按占用自动调整）。
- 后端（NestJS + Prisma）在 `backend/`，统一前缀 `/api`，开发端口 `5500`。

## 本地运行

**先决条件：** Node.js（建议 v18+）、本地或容器化的 MongoDB 与 Redis（可选）

1. 安装前端依赖：
   `npm install`
2. 配置后端环境：进入 `backend/`，将 `.env.example` 复制为 `.env`，并设置：
   - `API_PORT=5500`
   - `MONGO_URL`（本地默认示例为 `mongodb://localhost:27017/linguacraft`）
   - `JWT_SECRET`
   - `DEEPSEEK_API_KEY`（以及可选 `DEEPSEEK_MODEL`，默认 `deepseek-chat`）
3. 启动后端：
   `cd backend && npm install && npm run dev`
   启动后会自动导入 `data/vocab/words.json` 词库（若数据库为空）。
4. 在另一个终端启动前端：
   `npm run dev`

前端开发代理已将 `/api` 请求转发到 `http://localhost:5500`（见 `frontend/vite.config.ts`）。

## Docker Compose（可选）
使用根目录的 `docker-compose.yml` 可以一键启动 MongoDB、Redis 与后端 Backend 服务。请确保端口与环境变量一致（已统一为 `5500`）。

## 部署

生产部署资产位于 `deploy/`，包含 `deploy/frontend/Dockerfile` 与 `deploy/backend/Dockerfile`，以及 NGINX 反向代理配置（上游为 `backend` 服务）。请根据实际域名与 TLS 证书调整 `deploy/nginx/nginx.conf`。

## 测试

`backend/src/__tests__/smoke.test.ts` 跑上线前 6 个 P0 检查 (health / admin auth / dev 旁路 / login 校验 / pickWords)。本地需要 MongoDB 27017 端口可用，**不需要** Redis（`RateLimitGuard` 走 fail-open）。

```bash
cd backend && npm install
cd backend && npm test
```

CI 走 `.github/workflows/ci.yml`：push / PR to main 时跑 backend `tsc + jest` + frontend `vite build`，5 分钟 timeout，MongoDB 6.0 service container 跑测试。


## 📖 核心架构说明：词库与教材关系

为了防止遗忘，特此记录本项目的“词库-教材”核心数据架构。本项目没有采用传统的“固定课程/课时”硬编码模式，而是建立了一个动态的、基于标签和图谱关系的词库系统。

### 1. 数据模型结构
* **全量词库 ([VocabWord](backend/src/modules/learning/vocab.schema.ts))**：
  * 包含单词拼写、词干、词性、CEFR等级、基础中英文释义及例句。
  * **核心字段**：`levels` (适用学段，如小学/初中)、`textbooks` (所属教材名称数组)、`contextualDefinitions` (语境化释义，即同一个词在不同教材中可能有不同的重点释义或例句)。
* **用户学习进度 ([UserWordProgress](backend/src/modules/learning/user-word-progress.schema.ts))**：
  * 记录每个用户对每个单词的掌握情况。包含学习阶段 (`stage`: 0-3) 用于支持 SRS (间隔重复记忆) 算法，以及下次复习时间 (`nextReviewAt`) 等。
* **教材数据 (`Textbook`)**：
  * 原始数据存储于 `data/raw/DictionaryData/book.csv` 和关联表 `relation_book_word.csv` 中，通过脚本导入数据库，建立教材树形结构（如大类 -> 具体教材版本）。

### 2. 词库与实际教材的关联机制
* **多对多映射**：每一个单词都通过 `textbooks` 数组字段明确关联到多本具体的出版教材。
* **动态生成课时**：系统未写死静态的“第一课/第二课”。当用户在前端选定特定教材或学段时，后端会：
  1. 从该教材对应的词汇池中圈定单词范围。
  2. 结合用户的个人进度，计算出新词和待复习词。
  3. 动态生成一次专属的学习会话 (`Learning Session`)。
* **按教材获取所有单词**：系统原生支持通过教材筛选词汇表。前端可直接调用 `GET /learning/progress?textbook=xxx` 接口，后端将返回该教材下的全部单词列表及当前用户的掌握进度，完美支持“教材词汇浏览”等功能。

## 文档与更新约定
- 任意功能、架构、写法的改动完成后，必须同步更新受影响目录的 `README.md` 与相关文件的开头注释（input/output/pos）。
- 未同步更新视为变更未完成；提交请包含对应文档同步。
- 每个目录必须维护：三行极简架构说明（≤3行）+“一旦我所属的文件夹有所变化，请更新我。”声明+文件清单（文件名/地位/功能）。

## 生产环境部署

### 使用 Docker Compose 部署
1. **准备环境变量**：
   ```bash
   # 复制环境变量模板
   cp .env.example .env
   # 编辑 .env 文件，设置以下变量：
   # DEEPSEEK_API_KEY=your_deepseek_api_key_here
   # JWT_SECRET=your_secure_jwt_secret_here
   ```

2. **使用生产配置**：
   ```bash
   # 复制生产配置模板
   cp docker-compose.prod.yml.example docker-compose.prod.yml
   # 启动所有服务
   docker-compose -f docker-compose.prod.yml up -d
   ```

3. **验证部署**：
   ```bash
   # 检查服务状态
   docker-compose -f docker-compose.prod.yml ps
   
   # 测试健康检查
   curl http://localhost:5500/api/health
   
   # 访问前端
   curl http://localhost
   ```

### 一键部署脚本（裸机 / VM 部署，不用 docker）

仓库自带 `scripts/deploy-prod.sh`，服务器上准备一次后，每次发布跑一行：

```bash
# 首次：服务器准备好 mongo / redis / node 20+ / nginx，然后：
cd /opt/linguacraft
git clone https://github.com/CookieJobs/linguacraft.git .
cd backend && cp .env.production.example .env && nano .env  # 填 JWT_SECRET/ALLOWED_ORIGINS/MONGO_URL/DEEPSEEK_API_KEY
chmod 600 .env

# 之后每次发布：
sudo bash scripts/deploy-prod.sh
# 跳过数据回填（schema 没改时）：  --skip-backfill
# 跳过 smoke test：                  --skip-smoke
# 改部署路径 / 服务名：              REPO_DIR=/srv/xxx SERVICE_NAME=xxx bash scripts/deploy-prod.sh
```

脚本会顺序：pull → 装依赖 → 编译后端 + 前端 build → 同步前端到 `$WEB_ROOT`（默认 `/var/www/linguacraft`）→ 跑 `backfill-schema-defaults` → `systemctl restart linguacraft-backend` → 跑 `smoke-test-prod.sh` 8/8。

部署修复说明（v1.1.0 之前的旧 docker 方式，保留作为对比）：
1. **Docker构建问题**：在 `backend/Dockerfile` 中添加了构建工具以支持原生模块
2. **环境变量安全**：生产配置使用环境变量而非硬编码密钥
3. **Nginx配置**：正确配置了前端服务端口 (5173)

### 安全注意事项
- 不要将包含真实API密钥的 `.env` 文件提交到版本控制
- 定期更换 JWT_SECRET 和 API 密钥
- 使用强密码保护数据库和Redis服务
