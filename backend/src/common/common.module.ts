// input: @nestjs/common, ../common/redis.provider, ../common/rate-limit.guard
// output: CommonModule
// pos: 系统/通用
// 若我被更新,请同步更新我的开头注释,以及所属的文件夹的 README。
//
// 提供跨模块的 provider (redis) + guard (rate limit)
// 在 AppModule 全局 imports 一次即可
import { Global, Module } from '@nestjs/common'
import { redisProvider } from './redis.provider'
import { RateLimitGuard } from './rate-limit.guard'

@Global()
@Module({
  providers: [redisProvider, RateLimitGuard],
  exports: [redisProvider, RateLimitGuard]
})
export class CommonModule {}
