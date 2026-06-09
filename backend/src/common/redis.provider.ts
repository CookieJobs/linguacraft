import { FactoryProvider, Logger } from '@nestjs/common'
import Redis from 'ioredis'

export const REDIS = 'REDIS'

export const redisProvider: FactoryProvider<Redis> = {
  provide: REDIS,
  useFactory: () => {
    // ioredis 连接失败时会触发 unhandled 'error' 事件(Node 默认会把它当 unhandledRejection 抛出),
    // 这里挂个 listener 把噪音吃掉,ioredis 自己会持续重连,等 Redis 起来即可
    const client = new Redis(process.env.REDIS_URL || 'redis://localhost:6379', {
      maxRetriesPerRequest: null,
      enableReadyCheck: true,
      retryStrategy: (times) => Math.min(times * 200, 2000)
    })
    const log = new Logger('Redis')
    client.on('error', (err) => log.warn(`Redis unavailable, retrying: ${err?.message || err}`))
    client.on('ready', () => log.log('Redis ready'))
    return client
  }
}
