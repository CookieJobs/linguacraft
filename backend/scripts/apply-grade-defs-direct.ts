/**
 * 直接 apply dry-run 报告到 mongo
 * - 绕开 enrich-grade-definitions.ts 的 modifiedCount 误判 bug
 * - 用 findOneAndUpdate + returnDocument: 'before' 看 apply 前的值
 * - 只写 changed 字段, 避免 0 写入误报
 */
import * as fs from 'fs'
import * as mongoose from 'mongoose'

const REPORT_PATH = '/tmp/linguacraft-enrich-grade-definitions.json'
const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017/linguacraft'

interface Suggestion {
  lemma: string
  pos: string
  currentPrimary: string
  currentMiddle: string
  currentHigh: string
  aiPrimary: string
  aiMiddle: string
  aiHigh: string
  primaryChanged: boolean
  middleChanged: boolean
  highChanged: boolean
  change: boolean
}

async function main() {
  if (!fs.existsSync(REPORT_PATH)) {
    console.error(`❌ 报告不存在: ${REPORT_PATH}`)
    process.exit(1)
  }
  const report = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf-8'))
  const suggestions: Suggestion[] = (report.suggestions || []).filter((s: Suggestion) => s.change)
  console.log(`📋 报告 ${suggestions.length} 词待 apply (生成于 ${report.generatedAt})`)
  console.log(`   filter: ${JSON.stringify(report.filter)}`)
  console.log()

  console.log(`连接 mongo: ${MONGO_URL}`)
  await mongoose.connect(MONGO_URL)
  const V = mongoose.model('VocabWord', new mongoose.Schema({}, { strict: false }))

  let written = 0
  let errs = 0
  const t0 = Date.now()

  for (const s of suggestions) {
    const $set: any = {}
    // 关键: 重新验证 db 真实状态 ——
    // 报告的 currentPrimary 等是 dry-run 时拉的值, 可能在 dry-run 和 apply 之间被别人改过
    const dbDoc = await V.findOne({ lemma: s.lemma, pos: s.pos }, { definitions: 1 }).lean() as any
    if (!dbDoc) {
      errs++
      console.error(`  ⚠️  词 ${s.lemma}/${s.pos} 在 db 里找不到`)
      continue
    }
    const dbDef = dbDoc.definitions || {}
    const dbP = (dbDef.primary || '').trim()
    const dbM = (dbDef.middle || '').trim()
    const dbH = (dbDef.high || '').trim()
    // 重新判断: db 真空才 $set
    if (s.primaryChanged && !dbP) $set['definitions.primary'] = s.aiPrimary
    if (s.middleChanged && !dbM) $set['definitions.middle'] = s.aiMiddle
    if (s.highChanged && !dbH) $set['definitions.high'] = s.aiHigh
    if (Object.keys($set).length === 0) {
      // db 已经有值了, skip (不浪费 $set)
      continue
    }
    try {
      const result = await V.updateOne(
        { lemma: s.lemma, pos: s.pos },
        { $set }
      )
      if (result.matchedCount > 0) written++
      else {
        errs++
        console.error(`  ⚠️  词 ${s.lemma}/${s.pos} updateOne 匹配 0`)
      }
    } catch (e: any) {
      errs++
      console.error(`  ✗ 写 ${s.lemma}/${s.pos} 失败: ${e.message?.slice(0, 100)}`)
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1)
  console.log()
  console.log(`✅ apply 完成: ${written}/${suggestions.length} 词已更新 (errors: ${errs}, ${elapsed}s)`)
  await mongoose.disconnect()
}

main().catch(e => {
  console.error('fatal:', e)
  process.exit(1)
})
