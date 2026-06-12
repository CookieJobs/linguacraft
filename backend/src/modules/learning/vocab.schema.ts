// input: mongoose
// output: VocabWordSchema, VocabWordDocument
// pos: 后端/学习模块
// 若我被更新，请同步更新我的开头注释，以及所属的文件夹的 README。
import { HydratedDocument, Schema } from 'mongoose'

export interface GradeDefinitions {
  primary?: string
  middle?: string
  high?: string
  university?: string
  professional?: string
  cet4?: string
  cet6?: string
  [key: string]: string | undefined
}

export interface VocabWord {
  headword: string
  lemma: string
  pos: string
  cefr: string
  freqRank?: number
  definitionEn: string
  definitionZh: string
  exampleEn: string
  ipa?: string
  audioUrl?: string
  levels: string[]
  topics: string[]
  textbooks?: string[]
  source?: string
  definitions?: GradeDefinitions
  contextualDefinitions?: {
    textbook: string
    definitionZh: string
    exampleEn: string
  }[]
}

export type VocabWordDocument = HydratedDocument<VocabWord>

export const VocabWordSchema = new Schema<VocabWord>({
  headword: { type: String, required: true, index: true },
  lemma: { type: String, required: true },
  pos: { type: String, required: true, default: 'n.' },
  cefr: { type: String, required: true },
  freqRank: { type: Number, default: null },
  definitionEn: { type: String, required: true },
  definitionZh: { type: String, required: true },
  exampleEn: { type: String, required: true },
  ipa: { type: String },
  audioUrl: { type: String },
  levels: { type: [String], default: [] },
  topics: { type: [String], default: [] },
  textbooks: { type: [String], default: [] },
  source: { type: String },
  definitions: {
    primary: { type: String, default: '' },
    middle: { type: String, default: '' },
    high: { type: String, default: '' },
    cet4: { type: String, default: '' },
    cet6: { type: String, default: '' },
    university: { type: String, default: '' },
    professional: { type: String, default: '' },
    // 历史遗留 key (不补 default, 避免混淆):
    junior: { type: String },
    senior: { type: String }
  },
  contextualDefinitions: [
    {
      textbook: { type: String, required: true },
      definitionZh: { type: String, required: true },
      exampleEn: { type: String, required: true }
    }
  ]
})

VocabWordSchema.index({ lemma: 1, pos: 1 }, { unique: true })
VocabWordSchema.index({ cefr: 1 })

// prod 必跑一次 mongo update 把空值补 default, 否则老数据没这字段:
//   cd backend && npx ts-node scripts/backfill-schema-defaults.ts
// (2026-06-12 schema defaults 新增 pos='n.', freqRank=null, definitions.{primary/middle/high/cet4/cet6/university/professional}='')
