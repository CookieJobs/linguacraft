// input: mongoose, dotenv
// output: 给 vocabwords 集合补 schema default 值 (dry-run 默认, --apply 写库)
// pos: 系统/运维
// 若我被更新, 请同步更新我的开头注释, 以及所属文件夹的 README.
//
// linguacraft vocabwords schema default 回填脚本
//
// 目的: vocab.schema.ts 新增的 default (2026-06-12) 只对新插入生效, 老数据没这字段.
//   需要 prod 上线前一次性回填, 否则:
//     - 54 词 pos 为空 → 学习模块取词失败
//     - 977 词 freqRank 为空 → SRS 排序拿不到
//     - definitions.{primary/middle/high/cet4/cet6/university/professional} 为空 → 新版释义取不到
//
// 默认值:
//   pos: 'n.'
//   freqRank: null
//   definitions.{primary|middle|high|cet4|cet6|university|professional}: ''
//
// 模式:
//   - 默认 (dry-run): 统计会改多少条 + 显示样例
//   - --apply:        实际 updateMany 改库
//
// 跑法:
//   cd backend && npx ts-node scripts/backfill-schema-defaults.ts
//   cd backend && npx ts-node scripts/backfill-schema-defaults.ts --apply
//
// 输出: 控制台 + /tmp/linguacraft-backfill-defaults-report.json

import * as mongoose from 'mongoose'
import * as dotenv from 'dotenv'
import * as fs from 'fs'
import * as path from 'path'

dotenv.config({ path: path.resolve(__dirname, '../.env') })

const APPLY = process.argv.includes('--apply')
const REPORT_PATH = '/tmp/linguacraft-backfill-defaults-report.json'

interface UpdatePlan {
  field: string
  condition: Record<string, any>
  set: Record<string, any>
  matched: number
  modified: number
}

// 用 $exists:false OR null/'' 三条件 (mongoose schema 不强制空值类型, 老数据可能 null/''/undefined 三种都存在)
function buildMissingCondition(fieldPath: string): Record<string, any> {
  return {
    $or: [
      { [fieldPath]: { $exists: false } },
      { [fieldPath]: null },
      ...(fieldPath.endsWith('Rank') ? [] : [{ [fieldPath]: '' }])
    ]
  }
}

async function main() {
  console.log(`[mode] ${APPLY ? 'APPLY (will write to DB)' : 'DRY-RUN (read only)'}`)
  await mongoose.connect(process.env.MONGO_URL!)
  // 用 minimal model 拿 collection, 不依赖 VocabWordSchema (schema 改了之后行为可能不一致)
  const VocabWord = mongoose.model('VocabWord', new mongoose.Schema({}, { strict: false, collection: 'vocabwords' }))
  const col = VocabWord.collection

  const plans: UpdatePlan[] = [
    // pos: 54 词缺
    {
      field: 'pos',
      condition: buildMissingCondition('pos'),
      set: { pos: 'n.' },
      matched: 0, modified: 0
    },
    // freqRank: 977 词缺 (保留 null, 不强行填值, 让未来 enrich 决定)
    {
      field: 'freqRank',
      condition: buildMissingCondition('freqRank'),
      set: { freqRank: null },
      matched: 0, modified: 0
    },
    // definitions.primary / middle / high / cet4 / cet6 / university / professional
    ...['primary', 'middle', 'high', 'cet4', 'cet6', 'university', 'professional'].map(k => ({
      field: `definitions.${k}`,
      condition: buildMissingCondition(`definitions.${k}`),
      set: { [`definitions.${k}`]: '' },
      matched: 0, modified: 0
    }))
  ]

  let totalMatched = 0
  let totalModified = 0
  const sampleByField: Record<string, any[]> = {}

  for (const plan of plans) {
    const matched = await col.countDocuments(plan.condition)
    plan.matched = matched
    totalMatched += matched

    // 取 3 条样例 (dry-run 用)
    const samples = await col.find(plan.condition, { projection: { headword: 1, lemma: 1, pos: 1, freqRank: 1, definitions: 1 } })
      .limit(3)
      .toArray()
    sampleByField[plan.field] = samples.map(s => ({
      _id: String(s._id),
      headword: s.headword,
      lemma: s.lemma,
      currentValue: getNestedValue(s, plan.field)
    }))

    if (APPLY && matched > 0) {
      const result = await col.updateMany(plan.condition, { $set: plan.set })
      plan.modified = result.modifiedCount
      totalModified += result.modifiedCount
    }
  }

  const report = {
    mode: APPLY ? 'apply' : 'dry-run',
    timestamp: new Date().toISOString(),
    totalMatched,
    totalModified,
    plans: plans.map(p => ({ field: p.field, matched: p.matched, modified: p.modified, set: p.set })),
    samples: sampleByField
  }

  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2))
  console.log(`\n[report] written to ${REPORT_PATH}`)
  console.log(`[total] matched ${totalMatched}, modified ${totalModified}`)
  console.log(`\n[breakdown]`)
  for (const p of plans) {
    const arrow = APPLY ? `${p.matched} → ${p.modified} modified` : `${p.matched} matched`
    console.log(`  ${p.field.padEnd(35)} ${arrow}`)
  }

  // 显示样例 (dry-run 更有价值)
  if (!APPLY) {
    console.log(`\n[samples per field] (showing first 3 of each)`)
    for (const [field, samples] of Object.entries(sampleByField)) {
      console.log(`  ${field}:`)
      for (const s of samples) {
        console.log(`    - ${s.headword} (${s.lemma}) current=${JSON.stringify(s.currentValue)}`)
      }
    }
  }

  await mongoose.disconnect()
  console.log(`\n[done] ${APPLY ? 'applied to DB' : 'no changes made'}`)
}

function getNestedValue(obj: any, path: string): any {
  return path.split('.').reduce((acc, key) => acc?.[key], obj)
}

main().catch(e => {
  console.error(`[fatal] ${e.message}`)
  process.exit(1)
})
