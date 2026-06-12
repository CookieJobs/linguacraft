// input: @nestjs/common, @nestjs/mongoose, ./admin.controller, ./admin.service, ../user/user.schema, ../learning/user-word-progress.schema, ../learning/mastery.schema, ../learning/vocab.schema, ../stats/stats.schema, ../../common/admin.guard, ../../common/jwt.guard
// output: AdminModule
// pos: 后端/管理模块
// 若我被更新，请同步更新我的开头注释，以及所属文件夹的 README。
import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import { AdminController } from './admin.controller'
import { AdminDevController } from './admin-dev.controller'
import { AdminService } from './admin.service'
import { UserSchema, UserProfileSchema } from '../user/user.schema'
import { UserWordProgressSchema } from '../learning/user-word-progress.schema'
import { WordMasterySchema } from '../learning/mastery.schema'
import { VocabWordSchema } from '../learning/vocab.schema'
import { DailyActivitySchema, UserStatsSchema } from '../stats/stats.schema'
import { JwtGuard } from '../../common/jwt.guard'
import { AdminGuard } from '../../common/admin.guard'

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'User', schema: UserSchema },
      { name: 'UserProfile', schema: UserProfileSchema },
      { name: 'UserWordProgress', schema: UserWordProgressSchema },
      { name: 'WordMastery', schema: WordMasterySchema },
      { name: 'VocabWord', schema: VocabWordSchema },
      { name: 'DailyActivity', schema: DailyActivitySchema },
      { name: 'UserStats', schema: UserStatsSchema }
    ])
  ],
  controllers: [AdminController, AdminDevController],
  providers: [AdminService, JwtGuard, AdminGuard]
})
export class AdminModule {}
