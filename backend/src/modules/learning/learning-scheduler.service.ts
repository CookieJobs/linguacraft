import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model, Types } from 'mongoose'
import { UserWordProgress } from './user-word-progress.schema'
import { WordMastery } from './mastery.schema'
import { VocabWord } from './vocab.schema'
import { StatsService } from '../stats/stats.service'
import { PetService } from '../pet/pet.service'
import { WalletService } from '../wallet/wallet.service'

@Injectable()
export class LearningSchedulerService {
  constructor(
    @InjectModel('UserWordProgress') private userWordProgressModel: Model<UserWordProgress>,
    @InjectModel('WordMastery') private wordMasteryModel: Model<WordMastery>,
    @InjectModel('VocabWord') private vocabWordModel: Model<VocabWord>,
    private statsService: StatsService,
    private petService: PetService,
    private walletService: WalletService
  ) {}

  /**
   * 获取用户当前需要复习的单词列表
   * @param userId 用户ID
   * @param limit 限制数量
   */
  async getDueWords(userId: string, limit: number = 20): Promise<any[]> {
    const now = new Date()
    return this.userWordProgressModel.find({
      userId: new Types.ObjectId(userId),
      nextReviewAt: { $lte: now }
    })
    .sort({ nextReviewAt: 1 })
    .limit(limit)
    .populate('wordId')
    .exec()
  }

  async getAllLearnedWordIds(userId: string): Promise<string[]> {
    const items = await this.userWordProgressModel.find({ userId: new Types.ObjectId(userId) }).select('wordId').exec()
    return items.map(item => String(item.wordId))
  }

  async submitAnswer(userId: string, wordId: string, isCorrect: boolean, userSentence?: string) {
    const now = new Date()

    let progress = await this.userWordProgressModel.findOne({
      userId: new Types.ObjectId(userId),
      wordId: new Types.ObjectId(wordId)
    })

    if (!progress) {
      progress = new this.userWordProgressModel({
        userId: new Types.ObjectId(userId),
        wordId: new Types.ObjectId(wordId),
        stage: 0,
        exposureCount: 0,
        correctCount: 0,
        wrongCount: 0,
        consecutiveCorrect: 0,
        wrongStreak: 0,
        lastPracticedAt: now,
        nextReviewAt: now,
        // SM-2 字段
        easeFactor: 2.5,
        interval: 0,
        repetitions: 0
      })
    }

    // 兼容旧数据(2026-06-08 之前没有 SM-2 字段的记录)
    if (progress.easeFactor == null) progress.easeFactor = 2.5
    if (progress.interval == null) progress.interval = 0
    if (progress.repetitions == null) progress.repetitions = 0

    progress.exposureCount += 1
    progress.lastPracticedAt = now

    if (isCorrect) {
      progress.correctCount += 1
      progress.consecutiveCorrect = (progress.consecutiveCorrect || 0) + 1
      progress.wrongStreak = 0 // 重置连续答错计数

      // Reward for correct answer
      await this.walletService.addCoins(userId, 1, 'correct_answer')
      await this.petService.addExp(userId, 1)
      await this.petService.restoreEnergy(userId, 2)

      const previousStage = progress.stage

      // SM-2: 答对时 reps += 1, EF 微涨, interval 按 SM-2 公式算
      // - reps==1: 1 天
      // - reps==2: 6 天
      // - reps>=3: 上一 interval * EF, 至少 1 天
      progress.repetitions = (progress.repetitions || 0) + 1
      progress.easeFactor = Math.min(2.8, (progress.easeFactor || 2.5) + 0.1) // 答对 EF 涨,上限 2.8

      let sm2Interval: number
      if (progress.repetitions === 1) sm2Interval = 1
      else if (progress.repetitions === 2) sm2Interval = 6
      else sm2Interval = Math.max(1, Math.round((progress.interval || 1) * progress.easeFactor))
      progress.interval = sm2Interval

      // Stage 升:跟 reps 对齐(每答对一次升一级,最多 3)
      if (progress.stage < 3) {
        progress.stage = Math.min(3, progress.repetitions)
      }

      // Mastery Logic: stage 从 2 升到 3,或 (已经在 stage 3 且带 userSentence)
      const justMastered = previousStage === 2 && progress.stage === 3
      const updateMasteryWithSentence = progress.stage === 3 && !!userSentence

      if (justMastered || updateMasteryWithSentence) {
        // Bonus for mastery
        await this.walletService.addCoins(userId, 10, 'word_mastered')
        await this.petService.addExp(userId, 10)

        // Fetch VocabWord details
        const vocabWord = await this.vocabWordModel.findById(wordId)
        if (vocabWord) {
          // Create or update WordMastery
          await this.wordMasteryModel.findOneAndUpdate(
            { userId, word: vocabWord.headword },
            {
              userId,
              word: vocabWord.headword,
              definition: vocabWord.definitionZh,
              partOfSpeech: vocabWord.pos,
              example: vocabWord.exampleEn,
              userSentence: userSentence || vocabWord.exampleEn,
              masteredAt: now,
              sourceLevel: vocabWord.cefr
            },
            { upsert: true, new: true }
          )

          // Call Stats checkin
          await this.statsService.checkin(userId)
        }
      }

      // 用 SM-2 interval 算下次复习时间
      progress.nextReviewAt = new Date(now.getTime() + sm2Interval * 24 * 60 * 60 * 1000)

    } else {
      progress.wrongCount += 1
      progress.consecutiveCorrect = 0
      progress.wrongStreak = (progress.wrongStreak || 0) + 1

      // SM-2: 答错 reps 归 0, EF 衰减(下限 1.3), interval 重置 1 天
      // (但 wrongStreak 累积 2 次才降 stage,跟原逻辑一致避免一次错就崩)
      progress.repetitions = 0
      progress.easeFactor = Math.max(1.3, (progress.easeFactor || 2.5) - 0.2)
      progress.interval = 1

      if (progress.wrongStreak >= 2) {
        progress.stage = Math.max(0, progress.stage - 1) // 降一级,不归零
        progress.wrongStreak = 0 // 重置连续答错计数
      }
      // 答错:1 天后再来(给用户 1 天巩固时间,比原来的"立即"温和一点,SM-2 经典做法)
      progress.nextReviewAt = new Date(now.getTime() + 1 * 24 * 60 * 60 * 1000)
    }

    return progress.save()
  }

  /**
   * 更新单词的学习进度（例如使用间隔重复算法更新 nextReviewAt）
   * @param progressId 进度记录ID
   * @param isCorrect 是否回答正确
   */
  async updateProgress(progressId: string, isCorrect: boolean): Promise<UserWordProgress | null> {
    // TODO: 实现间隔重复算法 (Spaced Repetition System)
    // 暂时简单实现：正确则推迟复习，错误则立即复习
    
    const progress = await this.userWordProgressModel.findById(progressId)
    if (!progress) return null

    if (isCorrect) {
      progress.correctCount += 1
      // 简单逻辑：根据 stage 增加复习间隔
      // 实际应用中应使用更复杂的算法，如 SuperMemo-2
      const daysToAdd = Math.pow(2, progress.stage)
      progress.nextReviewAt = new Date(Date.now() + daysToAdd * 24 * 60 * 60 * 1000)
      if (progress.stage < 3) {
        progress.stage += 1
      }
    } else {
      progress.wrongCount += 1
      progress.stage = 0 // 重置阶段
      progress.nextReviewAt = new Date() // 立即复习
    }

    progress.exposureCount += 1
    progress.lastPracticedAt = new Date()
    
    return progress.save()
  }
}
