// input: @nestjs/core, @nestjs/common, ./modules/app.module, dotenv
// output: 无
// pos: 系统/通用
// 若我被更新，请同步更新我的开头注释，以及所属的文件夹的 README。
//
// 2026-06-12: 上线前安全加固 (v0.2.0-pre)
// - 启动时强校验 JWT_SECRET (dev placeholder / 长度 < 32 直接拒启)
// - 启动时强校验 ALLOWED_ORIGINS (prod 不能用 *, dev 默认 *)
// - CORS 改成白名单模式 (逗号分隔 env, 默认 = dev: *, prod: https://app.linguacraft.com)
import 'reflect-metadata'
import { NestFactory } from '@nestjs/core'
import { ValidationPipe } from '@nestjs/common'
// eslint-disable-next-line @typescript-eslint/no-var-requires
require('dotenv').config()
import { AppModule } from './modules/app.module'

const NODE_ENV = process.env.NODE_ENV || 'development'
const IS_PROD = NODE_ENV === 'production'

/**
 * JWT_SECRET 安全检查 — prod 环境硬性门禁
 * - dev 占位符 (dev_secret_change_me / dev_secret) 拒绝
 * - 长度 < 32 拒绝 (HS256 起码 32 byte 熵)
 * - dev 环境仅 warn (不阻断本地开发)
 */
function assertSecureJwtSecret(): void {
  const secret = process.env.JWT_SECRET || ''
  const placeholders = ['dev_secret_change_me', 'dev_secret', 'change_me_to_a_random_string', '']
  if (IS_PROD) {
    if (placeholders.includes(secret)) {
      throw new Error('JWT_SECRET insecure: prod must override dev placeholder')
    }
    if (secret.length < 32) {
      throw new Error(`JWT_SECRET insecure: length ${secret.length} < 32 (HS256 needs >= 32 bytes)`)
    }
  } else {
    if (placeholders.includes(secret) || secret.length < 32) {
      process.stderr.write(
        `[WARN] JWT_SECRET is dev placeholder or too short (len=${secret.length}). ` +
          `OK for dev, will fail in production.\n`,
      )
    }
  }
}

/**
 * ALLOWED_ORIGINS 检查 — prod 不能用通配符
 * - dev 默认 '*' (允许任意 origin)
 * - prod 必须是显式逗号分隔的 origin 列表
 * - 解析: 逗号 split, 去空, 去尾随 '/'
 */
function resolveAllowedOrigins(): string[] | true {
  const raw = process.env.ALLOWED_ORIGINS
  if (raw === undefined || raw === '' || raw === '*') {
    if (IS_PROD) {
      throw new Error(
        'ALLOWED_ORIGINS must be set in production (comma-separated origins, e.g. ' +
          '"https://app.linguacraft.com,https://admin.linguacraft.com")',
      )
    }
    return true // dev 通配
  }
  const list = raw
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter((o) => o.length > 0)
  if (IS_PROD && list.length === 0) {
    throw new Error('ALLOWED_ORIGINS resolved to empty list in production')
  }
  return list
}

async function bootstrap() {
  try {
    // 启动时安全门禁 — 失败直接 throw, 进程不挂端口
    assertSecureJwtSecret()
    const allowedOrigins = resolveAllowedOrigins()

    const app = await NestFactory.create(AppModule)
    app.setGlobalPrefix('api')

    // CORS 白名单模式
    app.enableCors({
      origin: allowedOrigins,
      credentials: true,
    })

    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))
    const port = process.env.API_PORT ? Number(process.env.API_PORT) : 5500
    await app.listen(port)
    const corsMsg = allowedOrigins === true ? '*' : (allowedOrigins as string[]).join(',')
    process.stdout.write(
      `api:${port} | NODE_ENV=${NODE_ENV} | CORS=${corsMsg}\n`,
    )
  } catch (e) {
    const msg = (e as any)?.stack || String(e)
    process.stderr.write(`[bootstrap-fail] ${msg}\n`)
    // 启动失败用非零退出码, 让 supervisor / docker / pm2 能感知
    process.exit(1)
  }
}

bootstrap()
