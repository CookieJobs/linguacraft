// input: @nestjs/common, @nestjs/mongoose, mongoose, ../stats/stats.schema, ../user/user.schema, ../learning/user-word-progress.schema, ../learning/mastery.schema, ../learning/vocab.schema
// output: AdminService
// pos: 后端/管理模块
// 若我被更新，请同步更新我的开头注释，以及所属的文件夹的 README。
import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'
import { UserDocument } from '../user/user.schema'
import { UserProfileDocument } from '../user/user.schema'
import { UserWordProgressDocument } from '../learning/user-word-progress.schema'
import { WordMasteryDocument } from '../learning/mastery.schema'
import { DailyActivityDocument, UserStatsDocument } from '../stats/stats.schema'
import { VocabWordDocument } from '../learning/vocab.schema'

@Injectable()
export class AdminService {
  constructor(
    @InjectModel('User') private userModel: Model<UserDocument>,
    @InjectModel('UserProfile') private profileModel: Model<UserProfileDocument>,
    @InjectModel('UserWordProgress') private progressModel: Model<UserWordProgressDocument>,
    @InjectModel('WordMastery') private masteryModel: Model<WordMasteryDocument>,
    @InjectModel('DailyActivity') private activityModel: Model<DailyActivityDocument>,
    @InjectModel('UserStats') private statsModel: Model<UserStatsDocument>,
    @InjectModel('VocabWord') private vocabModel: Model<VocabWordDocument>
  ) {}

  private dayStart(d: Date) { return new Date(d.toISOString().slice(0,10) + 'T00:00:00.000Z') }

  async getDashboard() {
    const now = new Date()
    const today = this.dayStart(now)
    const weekAgo = new Date(today.getTime() - 7 * 86400000)
    const monthAgo = new Date(today.getTime() - 30 * 86400000)

    const [totalUsers, profiles, totalVocab, totalMasteredRecords, todayActive, weekActive, monthActive, allStats, newUsersWeek, newUsersMonth] = await Promise.all([
      this.userModel.countDocuments(),
      this.profileModel.find().lean(),
      this.vocabModel.countDocuments(),
      this.masteryModel.countDocuments(),
      this.activityModel.countDocuments({ date: { $gte: today } }),
      this.activityModel.countDocuments({ date: { $gte: weekAgo } }),
      this.activityModel.countDocuments({ date: { $gte: monthAgo } }),
      this.statsModel.find().lean(),
      this.userModel.countDocuments({ createdAt: { $gte: weekAgo } }),
      this.userModel.countDocuments({ createdAt: { $gte: monthAgo } })
    ])

    // Users per education level
    const levelCounts: Record<string, number> = {}
    for (const p of profiles) {
      const lv = p.educationLevel || 'unset'
      levelCounts[lv] = (levelCounts[lv] || 0) + 1
    }

    // Total unique users with word progress
    const usersWithProgress = await this.progressModel.distinct('userId')
    const usersWithMastery = await this.masteryModel.distinct('userId')

    // Stage distribution across all users
    const stageAgg = await this.progressModel.aggregate([
      { $group: { _id: '$stage', count: { $sum: 1 } } }
    ])
    const stageDist: Record<string, number> = { stage0: 0, stage1: 0, stage2: 0, stage3: 0 }
    for (const s of stageAgg) {
      stageDist[`stage${s._id}`] = s.count
    }

    // Avg streak (of users who have streak > 0)
    const streaks = allStats.filter(s => s.currentStreak > 0).map(s => s.currentStreak)
    const avgStreak = streaks.length > 0 ? Math.round(streaks.reduce((a, b) => a + b, 0) / streaks.length) : 0
    const longestStreak = allStats.length > 0 ? Math.max(...allStats.map(s => s.longestStreak || 0)) : 0

    // Top 10 users by mastered count
    const topUsers = allStats
      .filter(s => s.totalMastered > 0)
      .sort((a, b) => b.totalMastered - a.totalMastered)
      .slice(0, 10)
      .map(s => ({ userId: s.userId, totalMastered: s.totalMastered, currentStreak: s.currentStreak }))

    return {
      totalUsers,
      newUsersThisWeek: newUsersWeek,
      newUsersThisMonth: newUsersMonth,
      usersByLevel: levelCounts,
      totalVocabWords: totalVocab,
      totalMasteredRecords,
      usersLearning: usersWithProgress.length,
      usersMastered: usersWithMastery.length,
      activeToday: todayActive,
      activeThisWeek: weekActive,
      activeThisMonth: monthActive,
      stageDistribution: stageDist,
      avgStreak,
      longestStreak,
      topUsers
    }
  }

  async getUsers() {
    const users = await this.userModel.find().sort({ createdAt: -1 }).lean()
    const profiles = await this.profileModel.find().lean()
    const stats = await this.statsModel.find().lean()

    const profileMap = new Map(profiles.map(p => [p.userId, p]))
    const statsMap = new Map(stats.map(s => [s.userId, s]))

    // Get progress counts per user
    const progressAgg = await this.progressModel.aggregate([
      { $group: { _id: '$userId', total: { $sum: 1 }, stages: { $push: '$stage' } } }
    ])

    const progressMap = new Map<string, { total: number; stage0: number; stage1: number; stage2: number; stage3: number }>()
    for (const p of progressAgg) {
      const uid = String(p._id)
      const stageDist = { stage0: 0, stage1: 0, stage2: 0, stage3: 0 }
      for (const s of p.stages) stageDist[`stage${s}`] = (stageDist[`stage${s}`] || 0) + 1
      progressMap.set(uid, { total: p.total, ...stageDist })
    }

    return users.map(u => {
      const uid = String(u._id)
      const p = profileMap.get(uid)
      const s = statsMap.get(uid)
      const prog = progressMap.get(uid)
      return {
        id: uid,
        email: u.email,
        isAdmin: !!u.isAdmin,
        createdAt: u.createdAt,
        educationLevel: p?.educationLevel || 'unset',
        textbook: p?.textbook || null,
        wordsTotal: prog?.total || 0,
        wordsStage0: prog?.stage0 || 0,
        wordsStage1: prog?.stage1 || 0,
        wordsStage2: prog?.stage2 || 0,
        wordsStage3: prog?.stage3 || 0,
        totalMastered: s?.totalMastered || 0,
        currentStreak: s?.currentStreak || 0,
        longestStreak: s?.longestStreak || 0,
        lastActive: s?.lastActivityDate || null
      }
    })
  }

  async getUserDetail(userId: string) {
    const user = await this.userModel.findById(userId).lean()
    if (!user) return null

    const [profile, stats, activities, masteryList] = await Promise.all([
      this.profileModel.findOne({ userId }).lean(),
      this.statsModel.findOne({ userId }).lean(),
      this.activityModel.find({ userId }).sort({ date: -1 }).limit(90).lean(),
      this.masteryModel.find({ userId }).sort({ masteredAt: -1 }).lean()
    ])

    // Get word progress with word details
    const progressList = await this.progressModel.find({ userId })
      .populate('wordId')
      .sort({ lastPracticedAt: -1 })
      .lean()

    const words = progressList.map(p => {
      const w = p.wordId as any
      return {
        wordId: String(p._id),
        word: w?.headword || 'unknown',
        definition: w?.definitionZh || '',
        stage: p.stage,
        correctCount: p.correctCount,
        wrongCount: p.wrongCount,
        consecutiveCorrect: p.consecutiveCorrect,
        exposureCount: p.exposureCount,
        lastPracticedAt: p.lastPracticedAt,
        nextReviewAt: p.nextReviewAt
      }
    })

    return {
      id: String(user._id),
      email: user.email,
      isAdmin: !!user.isAdmin,
      createdAt: user.createdAt,
      educationLevel: profile?.educationLevel || 'unset',
      textbook: profile?.textbook || null,
      currentStreak: stats?.currentStreak || 0,
      longestStreak: stats?.longestStreak || 0,
      totalMastered: stats?.totalMastered || 0,
      lastActive: stats?.lastActivityDate || null,
      activeDays: activities.length,
      masteredList: masteryList.map(m => ({
        word: m.word,
        definition: m.definition,
        partOfSpeech: m.partOfSpeech,
        masteredAt: m.masteredAt
      })),
      words
    }
  }

  async setAdmin(userId: string, isAdmin: boolean) {
    await this.userModel.findByIdAndUpdate(userId, { $set: { isAdmin } })
    return { ok: true, userId, isAdmin }
  }

  // 词库体检：拉全量词 + 派生"完整度"指标
  async getVocab() {
    const words = await this.vocabModel.find().lean()

    // 学段 key 列表 (跟 vocab.service.levelToKey / question-generator 一致)
    const GRADE_KEYS = ['primary', 'middle', 'high', 'cet4', 'cet6', 'university', 'professional']

    const enriched = words.map((w: any) => {
      const levels: string[] = w.levels || []
      const ce = w.cefr || 'UNKNOWN'
      const isMissing = (s: any) => !s || (typeof s === 'string' && s.trim() === '')
      const isDummyEx = !!w.exampleEn && w.exampleEn.startsWith('Example for ') && w.exampleEn.includes(w.headword)
      const missingFields: string[] = []
      if (isMissing(w.definitionZh)) missingFields.push('definitionZh')
      if (isMissing(w.definitionEn)) missingFields.push('definitionEn')
      if (isMissing(w.exampleEn)) missingFields.push('exampleEn')
      if (isMissing(w.ipa)) missingFields.push('ipa')
      if (isMissing(w.audioUrl)) missingFields.push('audioUrl')
      if (w.freqRank == null) missingFields.push('freqRank')
      if (isMissing(w.pos)) missingFields.push('pos')
      if (isDummyEx) missingFields.push('exampleEn(dummy)')

      const TOTAL_FIELDS = 7
      const completeness = +(((TOTAL_FIELDS - missingFields.length) / TOTAL_FIELDS) * 100).toFixed(1)

      // 2026-06-09 C-Phase2: 标出每个词的哪些学段分级释义是"脏"的 (会 fallback 到 definitionZh)
      const fallbackGrades: string[] = []
      const defs = w.definitions || {}
      for (const gk of GRADE_KEYS) {
        const val = defs[gk]
        if (val && val.trim() && this.isDirtyGradeDefinition(val, w.headword)) {
          fallbackGrades.push(gk)
        }
      }

      return {
        id: String(w._id),
        headword: w.headword,
        lemma: w.lemma,
        pos: w.pos || '',
        cefr: ce,
        freqRank: w.freqRank ?? null,
        definitionEn: w.definitionEn || '',
        definitionZh: w.definitionZh || '',
        exampleEn: w.exampleEn || '',
        ipa: w.ipa || '',
        audioUrl: w.audioUrl || '',
        levels,
        topics: w.topics || [],
        textbooks: w.textbooks || [],
        source: w.source || '',
        definitions: w.definitions || {},
        contextualDefinitions: w.contextualDefinitions || [],
        isDummyExample: isDummyEx,
        missingFields,
        completeness,
        // C-Phase2: 哪些学段是脏的 (fallback 走的)
        fallbackGrades,
        fallback: fallbackGrades.length > 0
      }
    })

    // 全局统计
    const TOTAL = enriched.length
    const completenessSum = enriched.reduce((s, w) => s + w.completeness, 0)
    const avgCompleteness = TOTAL > 0 ? +(completenessSum / TOTAL).toFixed(1) : 0
    const realExampleCount = enriched.filter(w => !w.isDummyExample && w.exampleEn).length
    const realExamplePct = TOTAL > 0 ? +((realExampleCount / TOTAL) * 100).toFixed(1) : 0
    const byCefr: Record<string, number> = {}
    const byLevel: Record<string, number> = {}
    const fieldMissing: Record<string, number> = {
      definitionZh: 0, definitionEn: 0, exampleEn: 0, ipa: 0,
      audioUrl: 0, freqRank: 0, pos: 0
    }
    // C-Phase2: fallback 统计
    const fbByGrade: Record<string, number> = Object.fromEntries(GRADE_KEYS.map(k => [k, 0]))
    let totalFallbackFields = 0
    let affectedWords = 0
    const sampleWords: Array<{ headword: string; grade: string; dirty: string; fallback: string }> = []
    for (const w of enriched) {
      const c = (w.cefr || 'UNKNOWN').toUpperCase()
      byCefr[c] = (byCefr[c] || 0) + 1
      for (const lv of w.levels) byLevel[lv] = (byLevel[lv] || 0) + 1
      for (const f of w.missingFields) {
        const key = f.replace('(dummy)', '')
        if (fieldMissing[key] != null) fieldMissing[key]++
      }
      // 累加 fallback 统计
      for (const gk of w.fallbackGrades) {
        fbByGrade[gk] = (fbByGrade[gk] || 0) + 1
        totalFallbackFields++
        if (sampleWords.length < 20) {
          sampleWords.push({
            headword: w.headword,
            grade: gk,
            dirty: w.definitions[gk] || '',
            fallback: w.definitionZh || ''
          })
        }
      }
      if (w.fallbackGrades.length > 0) affectedWords++
    }

    return {
      total: TOTAL,
      generatedAt: new Date().toISOString(),
      summary: {
        avgCompleteness,
        realExampleCount,
        realExamplePct,
        byCefr,
        byLevel,
        fieldMissing,
        // C-Phase2: 体检页用的 fallback 命中统计
        fallbackStats: {
          totalFallbackFields,
          affectedWords,
          affectedPct: TOTAL > 0 ? +((affectedWords / TOTAL) * 100).toFixed(2) : 0,
          byGrade: fbByGrade,
          sampleWords
        }
      },
      words: enriched
    }
  }

  /**
   * 2026-06-20 一次性导入端点: 本地 Mongo 词库 definitions 同步到 prod
   *
   * 触发场景: 本地跑过 enrich-grade-definitions.ts 后, 没把 Mongo 数据同步到 prod,
   *          prod Primary 题的释义全退到长 definitionZh, 体验崩坏
   *          (deploy-prod.sh 只同步代码, 不同步 Mongo)
   *
   * 设计:
   * - 只覆盖 `definitions` 字段, 不动 definitionZh / levels / exampleEn / ipa / 等其他任何字段
   * - 按 `headword` (case-insensitive) 配对, 不靠 _id (本地 prod 是不同 Mongo)
   * - 不存在的 headword 记到 unmatched, 不创建新词
   * - 一个 headword 多个 pos 记录会全更新 (跟本地 dedup-by-headword 一致)
   * - 单批 ≤ 500 词, 总数无上限 (分批调用即可)
   *
   * 临时用, 跑完数据同步后可以删掉这个端点
   */
  async importDefinitions(records: Array<{ headword: string; pos?: string; definitions: Record<string, string> }>) {
    if (!Array.isArray(records) || records.length === 0) {
      return { matched: 0, modified: 0, unmatched: [], errors: [] }
    }
    if (records.length > 500) {
      throw new Error(`batch_too_large: ${records.length} (max 500 per request, split into batches)`)
    }

    let matched = 0
    let modified = 0
    const unmatched: string[] = []
    const errors: Array<{ headword: string; error: string }> = []

    for (const rec of records) {
      const hw = String(rec.headword || '').trim()
      if (!hw) continue

      // 只挑非空 def 字段写, 避免把 prod 已有值覆盖成空字符串
      const setDefs: Record<string, string> = {}
      for (const [k, v] of Object.entries(rec.definitions || {})) {
        if (v && String(v).trim()) setDefs[`definitions.${k}`] = String(v)
      }
      if (Object.keys(setDefs).length === 0) {
        unmatched.push(`${hw} (no non-empty def fields)`)
        continue
      }

      try {
        const filter: any = { headword: new RegExp(`^${hw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i') }
        if (rec.pos) filter.pos = rec.pos

        // 先 count 看看有没有, 没就 skip
        const cnt = await this.vocabModel.countDocuments(filter)
        if (cnt === 0) {
          unmatched.push(hw + (rec.pos ? ` (pos=${rec.pos})` : ''))
          continue
        }
        matched += cnt

        const r = await this.vocabModel.updateMany(filter, { $set: setDefs })
        modified += r.modifiedCount || 0
      } catch (e: any) {
        errors.push({ headword: hw, error: e?.message || String(e) })
      }
    }

    return { matched, modified, unmatched, errors, requested: records.length }
  }

  /**
   * 检测分级释义是否"脏" — 跟 vocab.service.isDirtyGradeDefinition 保持一致
   * (2026-06-09 C-Phase2 词库体检用)
   * 这里 inline 一份而不是 import VocabService: 避免 admin module 导入 learning module
   * 造成循环依赖 (admin 已经在 app.module 链里)。
   * 同步规则: 跟 vocab.service 的检测函数完全一致,改了要两边都改
   */
  private isDirtyGradeDefinition(value: string, headword: string): boolean {
    if (!value || !value.trim()) return false
    const v = value.trim()
    if (/\|\|/.test(v)) return false
    if (/\d+\.\s/.test(v)) return false
    if (/\[[a-zA-Zʃʒθðŋɪʊəɒæɛɔʌːə̯ɹɾθɡʔˈˌː.,\s\-]+\]/.test(v)) return true
    if (/\/[a-zA-Zʃʒθðŋɪʊəɒæɛɔʌːə̯ɹɾθɡʔˈˌː.,\s\-]+\//.test(v)) return true
    if (headword && headword.length >= 4) {
      const re = new RegExp(`\\b${headword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
      if (re.test(v)) return true
    }
    if (/[a-zA-Z]{3,}(\s+[a-zA-Z',.]{2,}){2,}/.test(v)) return true
    return false
  }
}
