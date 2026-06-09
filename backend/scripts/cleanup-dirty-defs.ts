// input: mongoose, fs, scan-dirty-defs 的检测函数
// output: 清洗后的 definitions 字段 (dry-run 默认, --apply 写入 DB)
// pos: 系统/通用
// 若我被更新,请同步更新我的开头注释,以及所属的文件夹的 README.
//
// linguacraft 脏分级释义清洗脚本 (基于 scan-dirty-defs 的检测)
//
// 清洗策略 (按优先级, 每条只清洗"判定为脏"的部分):
//   1. 提取 "看起来像中文释义" 的部分:
//      - 找第一个 [xxx] 音标或 (xxx 英文括号 或 ; ; 后的 headword (drink)
//      - 只保留前面的中文部分
//   2. 对保留部分 trim + 移除 "v. n. adj." 等词性标签 (如果后面没中文)
//   3. 移除末尾的 "drink (drank, drunk) [drɪŋk]..." 这种被串的相邻词条
//
// 跑法:
//   # dry-run (默认, 只看, 不写库):
//   npx ts-node scripts/cleanup-dirty-defs.ts
//
//   # 实际写库:
//   npx ts-node scripts/cleanup-dirty-defs.ts --apply
//
//   # 限制只清洗前 N 个 (调试用):
//   npx ts-node scripts/cleanup-dirty-defs.ts --limit 10
//
// 输出:
//   - 控制台: 每个脏词展示 before/after + 是否变化
//   - JSON:   /tmp/linguacraft-cleanup-preview.json (dry-run) 或 /tmp/linguacraft-cleanup-applied.json (apply)
//   - CSV:    /tmp/linguacraft-cleanup-changes.csv  方便 review

import * as mongoose from 'mongoose'
import * as dotenv from 'dotenv'
import * as fs from 'fs'
import * as path from 'path'
dotenv.config({ path: path.resolve(__dirname, '../.env') })

interface VocabWord {
  _id: any
  headword: string
  lemma: string
  pos: string
  definitionZh: string
  ipa?: string
  definitions?: Record<string, string>
}

const GRADE_KEYS = ['primary', 'middle', 'high', 'cet4', 'cet6', 'university', 'professional'] as const
type GradeKey = typeof GRADE_KEYS[number]

interface CleanResult {
  lemma: string
  headword: string
  grade: GradeKey
  before: string
  after: string
  changed: boolean
  rule: string  // 用了什么清洗规则
}

function isAscii(s: string): boolean {
  return /^[\x00-\x7F]+$/.test(s)
}

/**
 * 核心清洗: 从脏字符串里提取"看起来像中文释义"的部分
 * 启发式:
 *   - 找到第一个 [xxx] (音标) 或 (xxx 英文括号 或 " drink" " drive" 这种 " space+headword" 模式
 *   - 返回从开头到那个位置前的中文部分
 */
function cleanValue(dirty: string, headword: string): { cleaned: string; rule: string } {
  if (!dirty) return { cleaned: dirty, rule: 'noop' }

  const v = dirty.trim()
  let cut = v.length  // 切到的位置 (inclusive, 切到 cut 之前)
  let rule = 'unchanged'

  // 规则 1: 找第一个 [xxx] 音标 — 切掉它和后面
  const ipaMatch = v.match(/[\[][a-zA-Zʃʒθðŋɪʊəɒæɛɔʌːə̯ɹɾθɡʔˈˌː.,\s\-]+[\]]/)
  if (ipaMatch && ipaMatch.index !== undefined && ipaMatch.index > 0) {
    if (ipaMatch.index < cut) {
      cut = ipaMatch.index
      rule = 'cut_at_ipa'
    }
  }

  // 规则 2: 找 " drink" " drive" 这种 " 空格+headword" 模式 — 切掉它和后面
  if (headword && headword.length >= 3) {
    // 用 " headword" 找 (前面必须有空格, 避免切到词内部)
    const re = new RegExp(`\\s+${headword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`, 'i')
    const m = v.match(re)
    if (m && m.index !== undefined && m.index < cut) {
      cut = m.index
      rule = 'cut_at_next_word'
    }
  }

  // 规则 3: 找 " (xxx" 英文括号 (含 3+ 字母) — 切掉 ( 但保留中文
  const parenRe = /\s+\(([a-zA-Z]{3,}[^)]*)\)/
  const pm = v.match(parenRe)
  if (pm && pm.index !== undefined && pm.index < cut) {
    cut = pm.index
    rule = rule === 'unchanged' ? 'cut_at_paren' : rule
  }

  let cleaned = v.slice(0, cut).trim()

  // 规则 4: 清理末尾的 "v. n. adj." 标签 (如果后面没中文)
  // 例: "热的; adj. 热的"  →  "热的"
  cleaned = cleaned.replace(/[;；]\s*(v\.|n\.|adj\.|adv\.|vt\.|vi\.|prep\.|conj\.|pron\.|art\.|aux\.|int\.|num\.|det\.)\s*$/i, '').trim()

  // 规则 5: 清理末尾的 "adj." "n." 单独结尾
  cleaned = cleaned.replace(/\s+(adj|n|v|adv|vt|vi|prep|conj|pron|art|aux|int|num|det)\.\s*$/i, '').trim()

  // 规则 6: 清理 "&" 开头 (例: "& n. 拖, 拉, 牵引"  →  "拖, 拉, 牵引")
  cleaned = cleaned.replace(/^&+\s*/, '').trim()

  // 规则 7: 清理末尾分号
  cleaned = cleaned.replace(/[;；]\s*$/, '').trim()

  if (cleaned === v) {
    return { cleaned: v, rule: 'unchanged' }
  }

  return { cleaned, rule }
}

async function main() {
  const APPLY = process.argv.includes('--apply')
  const LIMIT = (() => {
    const i = process.argv.indexOf('--limit')
    return i >= 0 ? parseInt(process.argv[i + 1], 10) : 0
  })()

  const mongoUrl = process.env.MONGO_URL || 'mongodb://localhost:27017/linguacraft'
  await mongoose.connect(mongoUrl)
  const VocabWord = mongoose.model('VocabWord', new mongoose.Schema({}, { strict: false }))

  // 读 scan-dirty-defs 输出 (复用检测结果)
  const scanFile = '/tmp/linguacraft-dirty-defs.json'
  if (!fs.existsSync(scanFile)) {
    console.error(`找不到 ${scanFile}, 请先跑 scripts/scan-dirty-defs.ts`)
    process.exit(1)
  }
  const scan = JSON.parse(fs.readFileSync(scanFile, 'utf-8'))
  const dirtyWords: any[] = scan.dirtyWords

  console.log(`\n🧹  linguacraft 脏分级释义清洗器`)
  console.log(`   数据库:   ${mongoUrl}`)
  console.log(`   模式:     ${APPLY ? '⚠️  APPLY (会写库)' : '🔍 DRY-RUN (只看, 不写)'}`)
  console.log(`   脏词数:   ${dirtyWords.length}`)
  console.log(`   限制:     ${LIMIT > 0 ? `前 ${LIMIT} 个` : '全部'}`)
  console.log('')

  // 加载所有词的 headword + ipa (cleanValue 用)
  const lemmas = dirtyWords.map((w: any) => w.lemma)
  const wordDocs = await VocabWord.find({ lemma: { $in: lemmas } }).select('headword ipa lemma definitions').lean() as unknown as VocabWord[]
  const wordMap = new Map<string, VocabWord>()
  for (const w of wordDocs) wordMap.set(w.lemma, w)

  const results: CleanResult[] = []
  let previewCount = 0
  const limit = LIMIT > 0 ? LIMIT : dirtyWords.length

  // 控制台先打前 30 个示例
  console.log('═'.repeat(72))
  console.log(`  📋 清洗预览 (前 30 条)`)
  console.log('═'.repeat(72))

  for (let i = 0; i < Math.min(30, dirtyWords.length); i++) {
    const dw = dirtyWords[i]
    const w = wordMap.get(dw.lemma)
    if (!w) continue

    for (const f of dw.fields) {
      const before = f.value
      const { cleaned, rule } = cleanValue(before, w.headword)
      const changed = cleaned !== before
      const r: CleanResult = {
        lemma: w.lemma,
        headword: w.headword,
        grade: f.grade,
        before,
        after: cleaned,
        changed,
        rule
      }
      results.push(r)

      if (previewCount < 30 && changed) {
        const beforeShort = before.length > 50 ? before.slice(0, 50) + '...' : before
        const afterShort = cleaned.length > 50 ? cleaned.slice(0, 50) + '...' : cleaned
        console.log(`\n  [${w.headword}·${f.grade}] rule=${rule}`)
        console.log(`    BEFORE: "${beforeShort}"`)
        console.log(`    AFTER:  "${afterShort}"`)
        previewCount++
      }
    }
  }

  // 全部跑完
  for (let i = 30; i < dirtyWords.length; i++) {
    const dw = dirtyWords[i]
    const w = wordMap.get(dw.lemma)
    if (!w) continue
    for (const f of dw.fields) {
      const { cleaned, rule } = cleanValue(f.value, w.headword)
      results.push({
        lemma: w.lemma,
        headword: w.headword,
        grade: f.grade,
        before: f.value,
        after: cleaned,
        changed: cleaned !== f.value,
        rule
      })
    }
  }

  // 统计
  const total = results.length
  const changed = results.filter(r => r.changed)
  const byRule: Record<string, number> = {}
  for (const r of changed) {
    byRule[r.rule] = (byRule[r.rule] || 0) + 1
  }

  console.log('\n')
  console.log('═'.repeat(72))
  console.log(`  📊 清洗统计`)
  console.log('═'.repeat(72))
  console.log(`  脏字段总数:    ${total}`)
  console.log(`  实际可清洗:    ${changed.length} (${pct(changed.length, total)})`)
  console.log(`  无变化:        ${total - changed.length} (脏判定但清洗无效果)`)
  console.log('')
  console.log('  清洗规则分布:')
  for (const [r, n] of Object.entries(byRule).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${(r + '                              ').slice(0, 30)} ${String(n).padStart(4)}`)
  }
  console.log('')

  // 写 JSON
  const outFile = APPLY ? '/tmp/linguacraft-cleanup-applied.json' : '/tmp/linguacacraft-cleanup-preview.json'
  fs.writeFileSync(outFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    mode: APPLY ? 'apply' : 'dry-run',
    totalFields: total,
    changedFields: changed.length,
    byRule,
    results
  }, null, 2))

  // 写 CSV
  const csvLines = ['lemma,headword,grade,rule,changed,before,after']
  for (const r of changed) {
    const before = r.before.replace(/"/g, '""')
    const after = r.after.replace(/"/g, '""')
    csvLines.push(`"${r.lemma}","${r.headword}","${r.grade}","${r.rule}",${r.changed},"${before}","${after}"`)
  }
  fs.writeFileSync('/tmp/linguacraft-cleanup-changes.csv', csvLines.join('\n'), 'utf-8')

  console.log(`  📄 详细 JSON: ${outFile}`)
  console.log(`  📄 变更 CSV:  /tmp/linguacraft-cleanup-changes.csv (${changed.length} 行)`)
  console.log('')

  if (APPLY) {
    console.log('⚠️  写入数据库中...')
    let applied = 0
    for (const r of changed) {
      await VocabWord.updateOne(
        { lemma: r.lemma },
        { $set: { [`definitions.${r.grade}`]: r.after } }
      )
      applied++
    }
    console.log(`✅ 已更新 ${applied} 个字段`)
  } else {
    console.log('💡 试运行, 没改任何数据。跑 `npx ts-node scripts/cleanup-dirty-defs.ts --apply` 写入数据库。')
  }

  await mongoose.disconnect()
}

function pct(n: number, total: number): string {
  if (!total) return '0.0%'
  return ((n / total) * 100).toFixed(1) + '%'
}

main().catch((e) => {
  console.error('cleanup failed:', e)
  process.exit(1)
})
