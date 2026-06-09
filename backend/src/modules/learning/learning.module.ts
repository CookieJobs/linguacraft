// input: @nestjs/common, @nestjs/mongoose, ./learning.controller, ./vocab.service, ./story.controller, ./deepseek.service, ./vocab.schema, ./mastery.schema, ../user/user.schema, ../stats/stats.module, ./vocab-seed.service, ../../common/jwt.guard
// output: LearningModule
// pos: 后端/学习模块
// 若我被更新，请同步更新我的开头注释，以及所属的文件夹的 README。
import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import { LearningController } from './learning.controller'
import { VocabService } from './vocab.service'

import { StoryController } from './story.controller'
import { DeepSeekService } from './deepseek.service'
import { TextbookService } from './textbook.service'
import { ProgressService } from './progress.service'
import { VocabWordSchema } from './vocab.schema'
import { WordMasterySchema } from './mastery.schema'
import { UserWordProgressSchema } from './user-word-progress.schema'
import { LearningSchedulerService } from './learning-scheduler.service'
import { QuestionGeneratorService } from './question-generator.service'
import { UserSchema, UserProfileSchema } from '../user/user.schema'
import { StatsModule } from '../stats/stats.module'
import { VocabSeedService } from './vocab-seed.service'
import { JwtGuard } from '../../common/jwt.guard'
import { PetModule } from '../pet/pet.module'
import { WalletModule } from '../wallet/wallet.module'

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'User', schema: UserSchema },
      // 2026-06-09 B 任务: GET /learning/session 按用户 profile.educationLevel 展示分级释义
      { name: 'UserProfile', schema: UserProfileSchema },
      { name: 'VocabWord', schema: VocabWordSchema },
      { name: 'WordMastery', schema: WordMasterySchema },
      { name: 'UserWordProgress', schema: UserWordProgressSchema }
    ]),
    StatsModule,
    PetModule,
    WalletModule
  ],
  controllers: [LearningController, StoryController],
  providers: [
    JwtGuard,
    VocabService,
    DeepSeekService,
    VocabSeedService,
    TextbookService,
    ProgressService,
    LearningSchedulerService,
    QuestionGeneratorService
  ],
  exports: [
 VocabService, //2026-06-09 C-Phase2:词库体检 admin复用 isDirtyGradeDefinition
 LearningSchedulerService,
 QuestionGeneratorService
] 
})
export class LearningModule { }
