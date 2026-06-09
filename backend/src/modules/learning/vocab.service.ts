// input: @nestjs/common, @nestjs/mongoose, mongoose, ./vocab.schema
// output: VocabService
// pos: 后端/学习模块
// 若我被更新，请同步更新我的开头注释，以及所属的文件夹的 README。
import { Injectable } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model, Types } from 'mongoose'
import { VocabWordDocument } from './vocab.schema'

type Level = 'Primary' | 'Middle' | 'High' | 'CET4' | 'CET6' | 'University' | 'Professional'

function seededRandom(seed: string) { let h = 2166136261 >>> 0; for (let i = 0; i < seed.length; i++) { h ^= seed.charCodeAt(i); h = Math.imul(h, 16777619) } return () => { h += 0x6D2B79F5; let t = Math.imul(h ^ (h >>> 15), 1 | h); t ^= t + Math.imul(t ^ (t >>> 7), 61 | t); return ((t ^ (t >>> 14)) >>> 0) / 4294967296 } }

const WEIGHTS: Record<Level, Record<'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2', number>> = {
  Primary: { A1: 0.7, A2: 0.3, B1: 0, B2: 0, C1: 0, C2: 0 },
  Middle: { A1: 0.1, A2: 0.5, B1: 0.4, B2: 0, C1: 0, C2: 0 },
  High: { A1: 0, A2: 0.1, B1: 0.6, B2: 0.3, C1: 0, C2: 0 },
  CET4: { A1: 0, A2: 0, B1: 0.2, B2: 0.5, C1: 0.3, C2: 0 },
  CET6: { A1: 0, A2: 0, B1: 0, B2: 0.2, C1: 0.6, C2: 0.2 },
  University: { A1: 0, A2: 0, B1: 0.15, B2: 0.45, C1: 0.35, C2: 0.05 },
  Professional: { A1: 0, A2: 0, B1: 0, B2: 0.1, C1: 0.5, C2: 0.4 }
}

@Injectable()
export class VocabService {
  constructor(@InjectModel('VocabWord') private vocabModel: Model<VocabWordDocument>) { }
  async pickWords(level: Level, exclude: string[] = [], limit = 5, seed?: string, textbook?: string) {
    const readyState = (this.vocabModel as any)?.db?.readyState ?? (this.vocabModel.collection as any)?.conn?.readyState
    if (typeof readyState === 'number' && readyState !== 1) throw new Error('DB_NOT_READY')
    const rng = seededRandom(seed || (Date.now().toString()))
    const excludeLower = new Set(exclude.map(s => s.toLowerCase()))

    const query: any = {}
    if (textbook) {
      query.textbooks = textbook
    }

    const candidates = await this.vocabModel.find(query).lean()
    const filtered = candidates.filter(w => !excludeLower.has(String(w.headword || '').toLowerCase()))
    const uniq: Record<string, typeof candidates[number]> = {}; for (const w of filtered) { if (!uniq[w.lemma]) uniq[w.lemma] = w }
    const pool = Object.values(uniq)
    const weights = WEIGHTS[level]
    const norm = (s: string): 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2' => { const v = (s || 'A1').toUpperCase(); if (v === 'A1' || v === 'A2' || v === 'B1' || v === 'B2' || v === 'C1' || v === 'C2') return v as any; return 'A1' }
    let resultPool = pool
    if (resultPool.length === 0) {
      const anyCandidates = await this.vocabModel.find({}).lean()
      const anyFiltered = anyCandidates.filter(w => !excludeLower.has(String(w.headword || '').toLowerCase()))
      const uniqAny: Record<string, typeof anyCandidates[number]> = {}; for (const w of anyFiltered) { if (!uniqAny[w.lemma]) uniqAny[w.lemma] = w }
      resultPool = Object.values(uniqAny)
    }
    if (resultPool.length === 0) throw new Error('VOCAB_EMPTY')
    const scored = resultPool.map(w => ({ w, score: (weights[norm(w.cefr)] || 0) + (1 / Math.max(1, w.freqRank ?? 1)) * 0.1 }))
    scored.sort(() => rng() - 0.5)
    scored.sort((a, b) => b.score - a.score)
    scored.sort(() => rng() - 0.5)
    scored.sort((a, b) => b.score - a.score)

    // Inject enhanced audio URL if missing
    return scored.slice(0, limit).map(s => {
      const w = s.w

      // Apply contextual definition if textbook matches
      if (textbook && w.contextualDefinitions?.length) {
        const contextDef = w.contextualDefinitions.find(cd => cd.textbook === textbook)
        if (contextDef) {
          w.definitionZh = contextDef.definitionZh
          w.exampleEn = contextDef.exampleEn
        }
      }

      if (!w.audioUrl) {
        // Type 2 = US English, Type 1 = UK
        w.audioUrl = `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(w.headword)}&type=2`
      }
      return w
    })
  }

  async listHeadwordsByLevel(level: string): Promise<string[]> {
    const words = await this.vocabModel.find({ levels: level }).select({ headword: 1 }).lean()
    return words.map(w => String(w.headword || '')).filter(Boolean)
  }

  async getById(id: string): Promise<VocabWordDocument | null> {
    return this.vocabModel.findById(id).exec()
  }

  async getRandomDistractors(count: number, excludeId: string, level?: string): Promise<VocabWordDocument[]> {
    const query: any = { _id: { $ne: excludeId } }
    if (level) {
      query.levels = level
    }
    const countDocs = await this.vocabModel.countDocuments(query)
    if (countDocs < count) {
      return this.vocabModel.find(query).limit(count).exec()
    }
    
    return this.vocabModel.aggregate([
      { $match: { _id: { $ne: new Types.ObjectId(excludeId) }, ...(level ? { levels: level } : {}) } },
      { $sample: { size: count } }
    ]).exec() as unknown as VocabWordDocument[]
  }
}
