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
        completeness
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
    for (const w of enriched) {
      const c = (w.cefr || 'UNKNOWN').toUpperCase()
      byCefr[c] = (byCefr[c] || 0) + 1
      for (const lv of w.levels) byLevel[lv] = (byLevel[lv] || 0) + 1
      for (const f of w.missingFields) {
        const key = f.replace('(dummy)', '')
        if (fieldMissing[key] != null) fieldMissing[key]++
      }
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
        fieldMissing
      },
      words: enriched
    }
  }
}
