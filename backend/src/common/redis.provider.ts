import { FactoryProvider, Logger } from '@nestjs/common'
import Redis from 'ioredis'

export const REDIS = 'REDIS'

export const redisProvider: FactoryProvider<Redis> = {
  provide: REDIS,
  useFactory: () => {
    // ioredis 连接失败时会触发 unhandled 'error' 事件(Node 默认会把它当 unhandledRejection 抛出),
    // 这里挂个 listener 把噪音吃掉,ioredis 自己会持续重连,等 Redis 起来即可
    //
    // 2026-06-11: maxRetriesPerRequest: null → 1
    // 旧配置 = 每次命令(incr/expire/ttl)都进离线重试队列, Redis 不可达时死等几十秒
    // 新配置 = 命令最多重试 1 次, 立即 fail, 让 rate-limit guard 的 try/catch 接住 fail-open
    // 配合 retryStrategy 限制 reconnect 节奏, 避免 log spam
    const client = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: 1,
      enableReadyCheck: true,
      enableOfflineQueue: false,
      retryStrategy: (times) => Math.min(times * 500, 3000)
    })
    const log = new Logger('Redis')
    client.on('error', (err) => log.warn(`Redis unavailable, retrying: ${err?.message || err}`))
    client.on('ready', () => log.log('Redis ready'))
    return client
  }
}
