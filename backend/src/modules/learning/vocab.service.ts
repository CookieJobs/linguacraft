// input: @nestjs/common, @nestjs/mongoose, mongoose, ./vocab.schema
// output: VocabService
// pos: 后端/学习模块
// 若我被更新，请同步更新我的开头注释，以及所属的文件夹的 README。
import { Injectable, Logger } from '@nestjs/common'
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
  private readonly logger = new Logger(VocabService.name)
  constructor(@InjectModel('VocabWord') private vocabModel: Model<VocabWordDocument>) { }
  async pickWords(level: Level, exclude: string[] = [], limit = 5, seed?: string, textbook?: string) {
    const readyState = (this.vocabModel as any)?.db?.readyState ?? (this.vocabModel.collection as any)?.conn?.readyState
    if (typeof readyState === 'number' && readyState !== 1) throw new Error('DB_NOT_READY')
    const rng = seededRandom(seed || (Date.now().toString()))
    const excludeLower = new Set(exclude.map(s => s.toLowerCase()))

    // 2026-06-10 L2 兜底: 学段是硬边界 (vocab.levels 含 level) — CEFR 只在同池内做软排序
    // - 指定 textbook: 按 textbook 过滤 (textbook 优先级最高, 单本教材跨学段是允许的)
    // - 未指定 textbook: 按 vocab.levels 硬过滤该学段
    // - 池子空 → 警告 + 用旧 CEFR 软排序兜底 (防止冷启动 vocab.levels 全空)
    const query: any = {}
    if (textbook) {
      query.textbooks = textbook
    } else {
      query.levels = level
    }

    let candidates = await this.vocabModel.find(query).lean()
    let usedFallback = false
    if (candidates.length === 0) {
      // 兜底: vocab.levels 字段缺失或该学段无词, 退到全表 + CEFR 软排序
      // 这种情况数据层有 bug, 应在 seed/import 时修, 不应该污染主流程
      const warnMsg = `[pickWords] vocab.levels filter empty for level=${level} textbook=${textbook || '(none)'}, falling back to full corpus + CEFR soft-sort`
      console.warn(warnMsg)
      this.logger?.warn?.(warnMsg)
      candidates = await this.vocabModel.find({}).lean()
      usedFallback = true
    }
    const filtered = candidates.filter(w => !excludeLower.has(String(w.headword || '').toLowerCase()))
    const uniq: Record<string, typeof candidates[number]> = {}; for (const w of filtered) { if (!uniq[w.lemma]) uniq[w.lemma] = w }
    const pool = Object.values(uniq)
    const weights = WEIGHTS[level]
    const norm = (s: string): 'A1' | 'A2' | 'B1' | 'B2' | 'C1' | 'C2' => { const v = (s || 'A1').toUpperCase(); if (v === 'A1' || v === 'A2' || v === 'B1' || v === 'B2' || v === 'C1' || v === 'C2') return v as any; return 'A1' }
    const resultPool = pool
    if (resultPool.length === 0) throw new Error('VOCAB_EMPTY')
    if (usedFallback) {
      // 兜底路径: 强化 CEFR 软排序权重, 减少跨学段污染
      // 实际业务应保证 vocab.levels 字段在 seed/import 时填对, 这里只是 last-resort
    }
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

  /** 将 levels 值映射到 definitions 的 key */
  private levelToKey(level: string): string {
    const map: Record<string, string> = {
      'Primary': 'primary',
      'Middle': 'middle',
      'High': 'high',
      'CET4': 'cet4',
      'CET6': 'cet6',
      'University': 'cet4',     // 兜底：大学四六级与 CET4 释义策略相近
      'Professional': 'cet6',   // 兜底：雅思托福与 CET6 释义策略相近
    }
    return map[level] || 'middle'
  }

  /**
   * 检测分级释义是否"脏" — 词库历史 import 把相邻词条串到了一起 (e.g. dress 后接 drink/drive)
   * 检测规则 (只标记真污染, 正常词典格式如 "n. 1. xxx" 不算):
   *   1. 含 [...] 音标 — 释义里不应该有音标
   *   2. 含 /xxx/ 音标 — 同上
   *   3. 头词污染 — 释义里出现 headword 自身 (短词 < 4 字符跳过, 防误伤 a/to/in)
   *   4. 含多个英文单词 (英文拼音) — 真污染特征: "drink (drank, drunk)" 这种
   *
   * 不判为脏 (false positive 避免):
   *   - "n. 1. xxx 2. yyy" 多义项编号
   *   - "|| 短语归纳" (e.g. "at full tilt")
   *   - 长词典释义 (很多正常释义 > 80 字符, 不应该单靠长度判)
   *   - "adj. n. v." 词性在前 (释义是形容词/名词/动词本身就含词性标签)
   *
   * 复用: 2026-06-09 C-Phase2 词库体检 admin 也用这个判脏
   */
  isDirtyGradeDefinition(value: string, headword: string): boolean {
    if (!value || !value.trim()) return false
    const v = value.trim()
    // 0. 白名单: 正常词典格式 (多义项编号 || 短语归纳) — 不算脏
    // 例: "1. 支柱 2. 一双 || at full tilt" "n. 1. xxx 2. yyy"
    if (/\|\|/.test(v)) return false
    if (/\d+\.\s/.test(v)) return false
    // 1. 音标污染 [...]
    if (/\[[a-zA-Zʃʒθðŋɪʊəɒæɛɔʌːə̯ɹɾθɡʔˈˌː.,\s\-]+\]/.test(v)) return true
    // 2. 音标污染 /.../
    if (/\/[a-zA-Zʃʒθðŋɪʊəɒæɛɔʌːə̯ɹɾθɡʔˈˌː.,\s\-]+\//.test(v)) return true
    // 3. 头词污染 (长 headword)
    if (headword && headword.length >= 4) {
      const re = new RegExp(`\\b${headword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i')
      if (re.test(v)) return true
    }
    // 4. 含 2+ 连续英文单词 (拼音串污染)
    // 例: "drink (drank, drunk)" "stand stood stood" "television=TV"
    const englishWordRun = /[a-zA-Z]{3,}(\s+[a-zA-Z',.]{2,}){2,}/
    if (englishWordRun.test(v)) return true
    // 5. 2026-06-10: "&字母." 头词串入 (e.g. flutter "&n. 1. 振翅, 拍翼")
    //    词库 import 时把 headword 拼到了词性标签前, 产生 "&n." "&v." "&vi.&n." 这种乱码
    if (/^&[a-z]+\./i.test(v)) return true
    // 5b. "&字母." 出现在释义内部 (e.g. "中文释义 &v. xxx")
    if (/[^a-zA-Z]&[a-z]+\./i.test(v)) return true
    return false
  }

  /**
   * 获取单词在指定级别的分级释义
   * 三级 fallback: grade_definitions[key] → definitionZh
   * 脏字段自动跳过 (2026-06-09: 词库历史 import 把相邻词条串到一起)
   *
   * 业务方:
   *   - question-generator.service 用这个给题目返选项 text
   *   - learning.controller GET /learning/wrong-words 用这个返 definition 字段
   *   - C-Phase2 词库体检 admin 用 isDirtyGradeDefinition 标脏 (扫描用)
   */
  getGradeDefinition(word: VocabWordDocument, level: string): string {
    const key = this.levelToKey(level)
    const gradeDef = word.definitions?.[key]
    if (gradeDef && gradeDef.trim() && !this.isDirtyGradeDefinition(gradeDef, word.headword)) {
      return gradeDef
    }
    return word.definitionZh || ''
  }
}
