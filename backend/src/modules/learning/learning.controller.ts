// input: @nestjs/common, @nestjs/mongoose, mongoose, ../../common/jwt.guard, ../stats/stats.service, ./vocab.service, ./deepseek.service, ./mastery.schema
// output: LearningController, route:learning
// pos: 后端/学习模块
// 若我被更新，请同步更新我的开头注释，以及所属的文件夹的 README。
import { Body, Controller, Post, UseGuards, Req, Get, Query, BadRequestException, Res } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'
import { JwtGuard } from '../../common/jwt.guard'
import { RateLimit, RateLimitGuard } from '../../common/rate-limit.guard'
import { safeError } from '../../common/redact'
import { StatsService } from '../stats/stats.service'
import { VocabService } from './vocab.service'
import { WordMasteryDocument } from './mastery.schema'
import { TextbookService } from './textbook.service'
import { ProgressService } from './progress.service'
import fetch from 'node-fetch'
import { Response } from 'express'

import { DeepSeekService } from './deepseek.service'
import { LearningSchedulerService } from './learning-scheduler.service'
import { QuestionGeneratorService } from './question-generator.service'
import { UserProfileDocument } from '../user/user.schema'

/** 规范化后的学段 (vocab.service.levelToKey / getGradeDefinition 期望的格式) */
type NormalizedLevel = 'Primary' | 'Middle' | 'High' | 'CET4' | 'CET6' | 'University' | 'Professional'

@Controller('learning')
@UseGuards(RateLimitGuard)
export class LearningController {
  constructor(
    @InjectModel('WordMastery') private masteryModel: Model<WordMasteryDocument>,
    @InjectModel('UserProfile') private profileModel: Model<UserProfileDocument>,
    private vocab: VocabService,
    private stats: StatsService,
    private deepseek: DeepSeekService,
    private textbookService: TextbookService,
    private progressService: ProgressService,
    private scheduler: LearningSchedulerService,
    private questionGenerator: QuestionGeneratorService
  ) { }

  /**
   * 把前端 EducationLevel 枚举值 (e.g. "Primary School (小学)") 映射到内部 short code (e.g. "Primary")
   * 用于 GET /learning/session 的 level/textbook query 参数 + user profile.educationLevel
   */
  private normalizeLevel(level: string): NormalizedLevel {
    const map: Record<string, NormalizedLevel> = {
      'Primary School (小学)': 'Primary', 'Junior High School (初中)': 'Middle', 'Senior High School (高中)': 'High',
      'CET-4 (四级)': 'CET4', 'CET-6 (六级)': 'CET6',
      'University (大学/四六级)': 'University', 'Professional/Study Abroad (雅思/托福/职场)': 'Professional',
      'Primary': 'Primary', 'Middle': 'Middle', 'High': 'High', 'CET4': 'CET4', 'CET6': 'CET6',
      'University': 'University', 'Professional': 'Professional'
    }
    return map[level] || (level as NormalizedLevel) || 'Primary'
  }

  /**
   * 拉取用户 profile.educationLevel 并规范化;没设置时返回 undefined (由 question-generator 兜底到 word.levels[0])
   */
  private async getUserLevel(userId: string): Promise<NormalizedLevel | undefined> {
    const profile = await this.profileModel.findOne({ userId: String(userId) }).lean()
    if (!profile?.educationLevel) return undefined
    return this.normalizeLevel(profile.educationLevel)
  }

  @Get('session') @UseGuards(JwtGuard)
  // 拉题目:每个用户每小时 60 次(留足 buffer,正常一天 20 题,顶多 5 次/天)
  @RateLimit({ namespace: 'learning-session', limit: 60, windowSec: 3600, identity: 'user' })
  async getSession(@Req() req: any, @Query('level') level?: string, @Query('textbook') textbook?: string) {
    const userId = req.user.id

    // Louis 新学习路径：每次 10 题 = 4 旧词 + 6 新词
    // 旧词：从待复习列表获取（最多4个，stage 1-3）
    const OLD_WORD_COUNT = 4
    const NEW_WORD_COUNT = 6
    const dueItems = await this.scheduler.getDueWords(userId, OLD_WORD_COUNT)

    // 2026-06-09 B 任务: 按用户学段展示分级释义
    // userLevel 优先于 word.levels[0]; 没设置时 question-generator 内部兜底到 word.levels[0]
    const userLevel = await this.getUserLevel(userId)

    const questions: any[] = []
    const allLearnedWordIds = await this.scheduler.getAllLearnedWordIds(userId)

    // 处理旧词：按 stage 匹配题型
    for (const item of dueItems) {
      const word = item.wordId as any
      if (!word) continue

      let q: any
      if (item.stage === 0 || item.stage === 1) {
        // Stage 0-1: 选择题 (识别层)
        const mode = Math.random() > 0.5 ? 'en-zh' : 'zh-en'
        q = await this.questionGenerator.generateChoiceQuestion(word, mode, userLevel)
      } else if (item.stage === 2) {
        // Stage 2: 填空题 (quiz, 用例句挖空,语境识别)
        q = await this.questionGenerator.generateQuizQuestion(word)
      } else {
        // Stage 3: 造句题 (sentence, 深度运用层)
        // 已掌握的词需要产出而不是识别,造句题才能验证真掌握
        // 前端用 SentenceQuestion 组件渲染文本框;后端 DeepSeek.evaluateSentence 判分
        q = await this.questionGenerator.generateSentenceQuestion(word)
      }

      if (q) {
        q.progressId = String(item._id)
        const isDummyExample = word.exampleEn?.startsWith('Example for ') && word.exampleEn?.includes(word.headword);
        q.word = {
          word: word.headword,
          definition: userLevel ? this.vocab.getGradeDefinition(word, userLevel) : word.definitionZh,
          partOfSpeech: word.pos,
          example: isDummyExample ? '' : word.exampleEn,
          audioUrl: word.audioUrl
        }
        questions.push(q)
      }
    }

    // 填入新词：补充到 10 题
    const neededSlots = Math.max(0, 10 - questions.length)
    if (neededSlots > 0 && level) {
      const levelCode = this.normalizeLevel(level)
      try {
        const newWords = await this.vocab.pickWords(
          levelCode,
          allLearnedWordIds,
          neededSlots,
          Math.random().toString(),
          textbook
        )

        for (const word of newWords) {
          const w = word as any
          const mode = Math.random() > 0.5 ? 'en-zh' : 'zh-en'
          const q: any = await this.questionGenerator.generateChoiceQuestion(w, mode, userLevel)
          const isDummyExample = w.exampleEn?.startsWith('Example for ') && w.exampleEn?.includes(w.headword);
          q.word = {
            word: w.headword,
            definition: userLevel ? this.vocab.getGradeDefinition(w, userLevel) : w.definitionZh,
            partOfSpeech: w.pos,
            example: isDummyExample ? '' : w.exampleEn,
            audioUrl: w.audioUrl
          }
          questions.push(q)
        }
      } catch (e) {
        // ignore VOCAB_EMPTY or others
      }
    }

    return { questions }
  }

  @Get('textbooks')
  async listTextbooks(@Query('level') level?: string) {
    const normalize = (s: string): string => {
      const map: Record<string, any> = {
        'Primary School (小学)': 'Primary', 'Junior High School (初中)': 'Middle', 'Senior High School (高中)': 'High',
        'CET-4 (四级)': 'CET4', 'CET-6 (六级)': 'CET6',
        'University (大学/四六级)': 'University', 'Professional/Study Abroad (雅思/托福/职场)': 'Professional'
      }
      return map[s] || s
    }
    const levelCode = level ? normalize(level) : undefined;
    return {
      textbooks: await this.textbookService.listTextbooks(levelCode)
    }
  }

  @Get('progress') @UseGuards(JwtGuard)
  async getProgress(@Req() req: any, @Query('level') level?: string, @Query('textbook') textbook?: string) {
    const normalize = (s: string): string => {
      const map: Record<string, any> = {
        'Primary School (小学)': 'Primary', 'Junior High School (初中)': 'Middle', 'Senior High School (高中)': 'High',
        'CET-4 (四级)': 'CET4', 'CET-6 (六级)': 'CET6',
        'University (大学/四六级)': 'University', 'Professional/Study Abroad (雅思/托福/职场)': 'Professional'
      }
      return map[s] || s
    }
    return this.progressService.getProgress(req.user.id, level ? normalize(level) : undefined, textbook)
  }

  @Get('audio')
  async proxyAudio(@Query('word') word: string, @Res() res: Response) {
    if (!word) throw new BadRequestException('Word is required')

    // Use Youdao TTS (Type 2 = US English)
    const url = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(word)}&type=2`

    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      })

      if (!response.ok) throw new Error(`Failed to fetch audio: ${response.status}`)

      res.set('Content-Type', 'audio/mpeg')
      res.set('Cache-Control', 'public, max-age=31536000') // Cache for 1 year

      // Pipe the stream
      response.body.pipe(res)
    } catch (e) {
      console.error('Audio proxy error:', safeError(e))
      res.status(500).send('Audio fetch failed')
    }
  }

  @Post('words') @UseGuards(JwtGuard)
  async words(@Body() body: { level: string; exclude?: string[]; textbook?: string }) {
    const normalize = (s: string): 'Primary' | 'Middle' | 'High' | 'CET4' | 'CET6' | 'University' | 'Professional' => {
      const map: Record<string, any> = {
        'Primary School (小学)': 'Primary', 'Junior High School (初中)': 'Middle', 'Senior High School (高中)': 'High',
        'CET-4 (四级)': 'CET4', 'CET-6 (六级)': 'CET6',
        'University (大学/四六级)': 'University', 'Professional/Study Abroad (雅思/托福/职场)': 'Professional',
        'Primary': 'Primary', 'Middle': 'Middle', 'High': 'High', 'CET4': 'CET4', 'CET6': 'CET6'
      }
      return map[s] || 'Primary'
    }
    const levelCode = normalize(body.level)
    const seed = `${levelCode}:${new Date().toISOString().slice(0, 10)}`
    try {
      const picked = await this.vocab.pickWords(levelCode, body.exclude || [], 5, seed, body.textbook)
      return picked.map((w: any) => {
        const isDummyExample = w.exampleEn?.startsWith('Example for ') && w.exampleEn?.includes(w.headword);
        return {
          word: w.headword,
          definition: { English: w.definitionEn, Chinese: w.definitionZh },
          partOfSpeech: w.pos,
          example: isDummyExample ? '' : w.exampleEn,
          audioUrl: w.audioUrl
        };
      })
    } catch (e: any) {
      const msg = String(e?.message || '')
      if (msg === 'VOCAB_EMPTY') throw new BadRequestException('VOCAB_EMPTY')
      if (msg === 'DB_NOT_READY') throw new BadRequestException('DB_NOT_READY')
      throw e
    }
  }

  @Post('submit') @UseGuards(JwtGuard)
  // 提交答题:每个用户每分钟 30 次(每题 ~2 秒点击,10 题/天 = 远低于)
  @RateLimit({ namespace: 'learning-submit', limit: 30, windowSec: 60, identity: 'user' })
  async submit(
    @Body() body: { wordId: string; selectedOptionId?: string; userSentence?: string },
    @Req() req: any
  ) {
    if (!body.wordId) throw new BadRequestException('wordId is required')
    if (!body.selectedOptionId && !body.userSentence) {
      throw new BadRequestException('selectedOptionId or userSentence is required')
    }

    // 服务端反作弊:不信前端传的 isCorrect,自己重判
    // - choice/quiz: 用 question-generator 的契约 — 正确项的 id 就是 word._id,所以 selectedOptionId === wordId 即为答对
    //   干扰项是其他 word 的 _id,改前端没法"全对刷金币"
    // - sentence: 走 DeepSeek.evaluateSentence 判分
    let isCorrect: boolean

    if (body.selectedOptionId) {
      isCorrect = body.selectedOptionId === body.wordId
    } else {
      // sentence 题
      const word = await this.vocab.getById(body.wordId)
      if (!word) throw new BadRequestException('word not found')
      const result = await this.deepseek.evaluateSentence(
        { word: word.headword, definition: word.definitionZh, partOfSpeech: word.pos, example: word.exampleEn },
        body.userSentence!
      )
      isCorrect = !!result?.isCorrect
    }

    return this.scheduler.submitAnswer(req.user.id, body.wordId, isCorrect, body.userSentence)
  }

  @Post('evaluate') @UseGuards(JwtGuard)
  // DeepSeek 评估:每个用户每分钟 10 次(防止恶意刷调用 = 钱)
  @RateLimit({ namespace: 'learning-evaluate', limit: 10, windowSec: 60, identity: 'user' })
  async evaluate(@Body() body: { word: any; sentence: string }) {
    return this.deepseek.evaluateSentence(body.word, body.sentence)
  }
  @Post('mastery') @UseGuards(JwtGuard)
  async addMastery(@Body() body: { userId?: string; word: string; definition: string; partOfSpeech: string; example: string; userSentence: string; masteredAt?: string; sourceLevel?: string }, @Req() req: any) {
    const userId = req.user.id
    const masteredAt = body.masteredAt ? new Date(body.masteredAt) : new Date()
    await this.masteryModel.create({
      userId,
      word: body.word,
      definition: body.definition,
      partOfSpeech: body.partOfSpeech,
      example: body.example,
      userSentence: body.userSentence,
      masteredAt,
      sourceLevel: body.sourceLevel
    })
    await this.stats.checkin(userId, masteredAt)
    return { ok: true }
  }
  @Post('mastery/list') @UseGuards(JwtGuard)
  async listMastery(@Req() req: any) {
    const items = await this.masteryModel.find({ userId: req.user.id }).sort({ masteredAt: -1 }).lean()
    return items
  }

  @Get('mastery/count') @UseGuards(JwtGuard)
  async countMastery(@Req() req: any, @Query('since') since?: string, @Query('level') level?: string) {
    const where: any = { userId: req.user.id }
    if (since) {
      const d = new Date(since)
      if (!isNaN(d.getTime())) where.masteredAt = { $gte: d }
    }
    // If level provided, count only masteries whose word belongs to the given vocab level
    if (level) {
      const words = await this.vocab.listHeadwordsByLevel(level)
      if (words.length === 0) return { count: 0 }
      where.word = { $in: words }
    }
    const count = await this.masteryModel.countDocuments(where)
    return { count }
  }

  // ============= 错题本 =============
  // GET /api/learning/wrong-words?level=...&textbook=...
  // 列出用户答错过且未掌握的单词(wrongCount > 0 && stage < 3)
  // 2026-06-09 B 任务: definition 字段按用户学段展示 (getGradeDefinition)
  @Get('wrong-words') @UseGuards(JwtGuard)
  @RateLimit({ namespace: 'learning-wrong-list', limit: 120, windowSec: 3600, identity: 'user' })
  async listWrongWords(
    @Req() req: any,
    @Query('level') level?: string,
    @Query('textbook') textbook?: string
  ) {
    const userId = req.user.id
    const userLevel = await this.getUserLevel(userId)
    const items = await this.progressService.getWrongWords(
      userId,
      level ? this.normalizeLevel(level) : undefined,
      textbook
    )
    // 按学段重写 definition (默认是 progressService 给的 word.definitionZh)
    // progressService 已把 definitions 字段带回来 (见 getWrongWords 注释), 避免 N+1
    const resolved = items.map((it: any) => {
      if (!userLevel) return it
      return { ...it, definition: this.vocab.getGradeDefinition(it as any, userLevel) }
    })
    return { items: resolved, count: resolved.length }
  }

  // POST /api/learning/wrong-words/practice
  // 拉 5 道错题组成 quick session, 用于"错题重练"
  // body: { level?: string, textbook?: string }
  // 2026-06-09 B 任务: 走 generateChoiceQuestion 时传 userLevel, 学习侧按学段展示
  @Post('wrong-words/practice') @UseGuards(JwtGuard)
  @RateLimit({ namespace: 'learning-wrong-practice', limit: 30, windowSec: 3600, identity: 'user' })
  async practiceWrongWords(
    @Req() req: any,
    @Body() body: { level?: string; textbook?: string }
  ) {
    const userId = req.user.id
    const level = body.level ? this.normalizeLevel(body.level) : undefined
    const userLevel = await this.getUserLevel(userId)
    const items = await this.progressService.getWrongWords(userId, level, body.textbook, 5)
    if (items.length === 0) {
      return { questions: [], count: 0, message: 'no_wrong_words' }
    }

    const questions: any[] = []
    for (const item of items) {
      // 重新拉 VocabWord 完整文档(为喂给 questionGenerator)
      const word = await this.vocab.getById(item.wordId)
      if (!word) continue
      const mode = Math.random() > 0.5 ? 'en-zh' : 'zh-en'
      const q: any = await this.questionGenerator.generateChoiceQuestion(word, mode, userLevel)
      const isDummyExample = word.exampleEn?.startsWith('Example for ') && word.exampleEn?.includes(word.headword)
      q.word = {
        word: word.headword,
        definition: userLevel ? this.vocab.getGradeDefinition(word, userLevel) : word.definitionZh,
        partOfSpeech: word.pos,
        example: isDummyExample ? '' : word.exampleEn,
        audioUrl: word.audioUrl
      }
      questions.push(q)
    }
    return { questions, count: questions.length }
  }
}
