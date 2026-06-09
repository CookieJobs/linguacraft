import { HydratedDocument, Schema, Types } from 'mongoose'

export interface UserWordProgress {
  userId: Types.ObjectId
  wordId: Types.ObjectId
  // 0-3 阶段,前端展示和 mastery 触发沿用
  stage: number
  exposureCount: number
  correctCount: number
  consecutiveCorrect: number
  wrongCount: number
  wrongStreak: number // 连续答错次数,累积 2 次才降 stage
  lastPracticedAt: Date
  nextReviewAt: Date
  // SM-2 自适应间隔字段 (新增 2026-06-08)
  // - easeFactor: 难度系数,默认 2.5,答对微涨、答错衰减,下限 1.3
  // - interval: 当前计划复习间隔(天)
  // - repetitions: 连续答对次数,答错归 0
  easeFactor: number
  interval: number
  repetitions: number
}

export type UserWordProgressDocument = HydratedDocument<UserWordProgress>

export const UserWordProgressSchema = new Schema<UserWordProgress>({
  userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  wordId: { type: Schema.Types.ObjectId, ref: 'VocabWord', required: true, index: true },
  stage: { type: Number, required: true, min: 0, max: 3, default: 0 },
  exposureCount: { type: Number, required: true, default: 0 },
  correctCount: { type: Number, required: true, default: 0 },
  consecutiveCorrect: { type: Number, required: true, default: 0 },
  wrongCount: { type: Number, required: true, default: 0 },
  wrongStreak: { type: Number, required: true, default: 0 },
  lastPracticedAt: { type: Date, default: Date.now },
  nextReviewAt: { type: Date, default: Date.now, index: true },
  easeFactor: { type: Number, required: true, default: 2.5, min: 1.3 },
  interval: { type: Number, required: true, default: 0 },
  repetitions: { type: Number, required: true, default: 0, min: 0 }
})

UserWordProgressSchema.index({ userId: 1, wordId: 1 }, { unique: true })
UserWordProgressSchema.index({ userId: 1, nextReviewAt: 1 })
