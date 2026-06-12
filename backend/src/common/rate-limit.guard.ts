// input: @nestjs/common, reflect-metadata, ioredis, ../common/redis.provider
// output: RateLimitGuard, @RateLimit 装饰器
// pos: 系统/通用
// 若我被更新,请同步更新我的开头注释,以及所属的文件夹的 README。
//
// 通用 Redis 滑动窗口限流守卫(用 fixed window 实现,简单可靠)
//   - key 格式: `rl:{namespace}:{identity}` (identity 默认 userId,未登录走 IP)
//   - 窗口: windowSec 秒
//   - 超出: throw HttpException 429
//
// 用法:
//   @UseGuards(JwtGuard, RateLimitGuard)
//   @RateLimit({ namespace: 'learning-session', limit: 60, windowSec: 3600 })
//   @Get('session') async getSession() { ... }
import { CanActivate, ExecutionContext, HttpException, HttpStatus, Inject, Injectable, SetMetadata, createParamDecorator } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import { Request } from 'express'
import Redis from 'ioredis'
import { REDIS } from './redis.provider'

export interface RateLimitOptions {
  /** 限流命名空间,例如 'learning-session' / 'auth-login' */
  namespace: string
  /** 窗口内最大请求数 */
  limit: number
  /** 窗口秒数 */
  windowSec: number
  /** 身份提取方式: 'user'(默认) | 'ip' | 'both'(任一超即拒) */
  identity?: 'user' | 'ip' | 'both'
}

export const RATE_LIMIT_KEY = 'rate_limit_options'
export const RateLimit = (opts: RateLimitOptions) => SetMetadata(RATE_LIMIT_KEY, opts)

@Injectable()
export class RateLimitGuard implements CanActivate {
  constructor(
    private reflector: Reflector,
    @Inject(REDIS) private redis: Redis
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const opts = this.reflector.getAllAndOverride<RateLimitOptions>(RATE_LIMIT_KEY, [
      ctx.getHandler(),
      ctx.getClass()
    ])
    if (!opts) return true // 没装饰 = 不限流

    const req = ctx.switchToHttp().getRequest<Request & { user?: any }>()
    const ip = this.extractIp(req)
    const userId = req.user?.id ? String(req.user.id) : null

    const identities: string[] = []
    const mode = opts.identity || 'user'
    if (mode === 'user' && userId) identities.push(`u:${userId}`)
    else if (mode === 'ip') identities.push(`ip:${ip}`)
    else if (mode === 'both') {
      if (userId) identities.push(`u:${userId}`)
      identities.push(`ip:${ip}`)
    } else {
      // 未登录且 mode=user,降级到 IP
      identities.push(`ip:${ip}`)
    }

    // 任一身份超限即拒
    for (const id of identities) {
      const key = `rl:${opts.namespace}:${id}`
      try {
        const count = await this.redis.incr(key)
        if (count === 1) {
          await this.redis.expire(key, opts.windowSec)
        }
        if (count > opts.limit) {
          const ttl = await this.redis.ttl(key)
          throw new HttpException(
            {
              message: 'rate_limited',
              namespace: opts.namespace,
              limit: opts.limit,
              retryAfter: ttl > 0 ? ttl : opts.windowSec
            },
            HttpStatus.TOO_MANY_REQUESTS
          )
        }
      } catch (e: any) {
        // 2026-06-11: Redis 不可用时 fail-open, 不要让 rate-limit 把整个请求 hang 死
        // 安全代价: Redis 挂了 = 不限流, 但服务还能用 (上次 Redis 死掉直接导致 login 15s 超时)
        // 这个 trade-off 合理, 因为本地 dev 经常没起 Redis
        if (e instanceof HttpException) throw e // 429 必须抛
        console.warn(`[RateLimitGuard] redis 不可用, fail-open for ${opts.namespace}:${id}: ${e.message?.slice(0, 80)}`)
        return true
      }
    }
    return true
  }

  private extractIp(req: Request): string {
    const xff = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
    return xff || req.socket.remoteAddress || '0.0.0.0'
  }
}
