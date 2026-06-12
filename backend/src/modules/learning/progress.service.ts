import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model, Types } from 'mongoose'
import { VocabWordDocument } from './vocab.schema'
import { WordMasteryDocument } from './mastery.schema'
import { UserWordProgressDocument } from './user-word-progress.schema'

@Injectable()
export class ProgressService {
    constructor(
        @InjectModel('VocabWord') private vocabModel: Model<VocabWordDocument>,
        @InjectModel('WordMastery') private masteryModel: Model<WordMasteryDocument>,
        @InjectModel('UserWordProgress') private userWordProgressModel: Model<UserWordProgressDocument>
    ) { }

    async getProgress(userId: string, level?: string, textbook?: string) {
        // 1. Fetch relevant vocabulary
        const vocabQuery: any = {}
        if (level) vocabQuery.levels = level
        if (textbook) vocabQuery.textbooks = textbook

        const words = await this.vocabModel.find(vocabQuery).select('_id headword definitionZh partOfSpeech').lean()
        const wordMap = new Map(words.map(w => [w.headword, w]))

        // 2. Fetch user mastery for these words
        const specificWords = words.map(w => w.headword)
        const wordIds = words.map(w => w._id)

        const mastery = await this.masteryModel.aggregate([
            { $match: { userId, word: { $in: specificWords } } },
            { $group: { _id: '$word', count: { $sum: 1 }, lastMastered: { $max: '$masteredAt' } } }
        ])
        const masteryMap = new Map(mastery.map(m => [m._id, m]))

        const userProgress = await this.userWordProgressModel.find({
            userId: new Types.ObjectId(userId),
            wordId: { $in: wordIds }
        }).lean()
        const progressMap = new Map(userProgress.map(p => [p.wordId.toString(), p]))

        // 3. Merge data
        const now = new Date()
        let masteredCount = 0
        let learningCount = 0
        let toReviewCount = 0
        let strugglingCount = 0

        const list = words.map(w => {
            const m = masteryMap.get(w.headword)
            const p = progressMap.get(w._id.toString())

            const isMastered = !!m || (p && p.stage === 3)
            let isLearning = false
            let isToReview = false
            let isStruggling = false

            if (isMastered) {
                masteredCount++
            } else if (p && (p.stage === 1 || p.stage === 2)) {
                isLearning = true
                learningCount++
            }

            if (p && p.nextReviewAt && new Date(p.nextReviewAt) <= now) {
                isToReview = true
                toReviewCount++
            }

            // 2026-06-10: 阈值从 > 3 改为 >= 2
            // 旧值 > 3 意味着同一词错 4 次才算 struggling, 实际用户答题分散在不同词上, 永远不触发
            // 改 >= 2 (错 2 次即 struggling) 是反复错但还没掌握的语义, 跟错题本 (wrongCount > 0) 形成层次
            if (p && p.wrongCount >= 2) {
                isStruggling = true
                strugglingCount++
            }

            return {
                word: w.headword,
                definition: w.definitionZh,
                mastered: isMastered,
                learning: isLearning,
                toReview: isToReview,
                struggling: isStruggling,
                masteryCount: m?.count || 0,
                lastMastered: m?.lastMastered || null,
                stage: p?.stage || 0,
                wrongCount: p?.wrongCount || 0,
                consecutiveCorrect: p?.consecutiveCorrect || 0,
                exposureCount: p?.exposureCount || 0,
                nextReviewAt: p?.nextReviewAt || null
            }
        })

        const newCount = words.length - masteredCount - learningCount

        return {
            totalCount: words.length,
            masteredCount,
            mastered: masteredCount,
            learning: learningCount,
            new: newCount,
            toReview: toReviewCount,
            struggling: strugglingCount,
            list
        }
    }

    /**
     * 错题本: 返回用户答错过但未掌握的单词列表
     * 判定: wrongCount > 0 && stage < 3
     * 排序: wrongCount DESC, lastPracticedAt DESC
     * 支持按 level/textbook 过滤
     */
    async getWrongWords(userId: string, level?: string, textbook?: string, limit = 200) {
        const match: any = {
            userId: new Types.ObjectId(userId),
            wrongCount: { $gt: 0 },
            stage: { $lt: 3 }
        }

        // 先拿符合条件的 progress
        const progresses = await this.userWordProgressModel
            .find(match)
            .sort({ wrongCount: -1, lastPracticedAt: -1 })
            .limit(limit)
            .lean()

        if (progresses.length === 0) return []

        // 关联 VocabWord
        const wordIds = progresses.map(p => p.wordId)
        const vocabQuery: any = { _id: { $in: wordIds } }
        if (level) vocabQuery.levels = level
        if (textbook) vocabQuery.textbooks = textbook

        let words = await this.vocabModel.find(vocabQuery).lean()
        // 2026-06-10: level 过滤后 0 词 → fallback 到不按 level 过滤
        // 场景: 用户答错过的词不在该 level 池内 (例: 之前 pickWords 没硬过滤, 给小学用户喂了 CET4 词,
        //      答错后 progress 记到 CET4 词上, 错题本按 Primary 过滤时拿不到 vocab)
        // 修法: level 过滤后空, 不带 level 再查一次, 仍空才真返回空
        if (words.length === 0 && level) {
            const fallbackQuery: any = { _id: { $in: wordIds } }
            if (textbook) fallbackQuery.textbooks = textbook
            words = await this.vocabModel.find(fallbackQuery).lean()
        }
        const wordMap = new Map(words.map(w => [String(w._id), w]))

        // 过滤掉按 level/textbook 过滤后不存在的词,合并返回
        // 2026-06-09 B 任务: 携带 definitions + headword + definitionZh 给 controller 算 grade def
        // (避免 controller 在 wrong-words 列表上做 N+1 refetch)
        return progresses
            .map(p => {
                const w = wordMap.get(String(p.wordId))
                if (!w) return null
                return {
                    wordId: String(p.wordId),
                    word: w.headword,
                    headword: w.headword,
                    definition: w.definitionZh,
                    definitions: w.definitions || null,
                    partOfSpeech: w.pos,
                    example: w.exampleEn,
                    audioUrl: w.audioUrl,
                    wrongCount: p.wrongCount,
                    lastWrongAt: p.lastPracticedAt,
                    stage: p.stage,
                    consecutiveCorrect: p.consecutiveCorrect,
                    nextReviewAt: p.nextReviewAt,
                    cefr: w.cefr,
                    levels: w.levels
                }
            })
            .filter((x): x is NonNullable<typeof x> => x !== null)
    }
}
