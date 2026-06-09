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
// 2026-06-09 C-Phase3 新增规则 (目标: 覆盖剩 70% 真脏字段, 转化率 26.5% → 60%+):
//   8. cut_at_embedded_word  — 中文 + 0-1空格 + 短英文headword (2-10 字符) + 0-1空格 + (中文|左括号)
//                             典型: "原因... CD(..." "月球... more(..." "需要... neighbour (美..."
//                             切割点: 中文+space 之间的空格开始 (中文保留)
//   9. cut_at_paren_english  — 短英文headword (2-10 字符) + 空格 + (英文括号注)
//                             典型: "fridge (=refrigerator)" "DVD (digital versatile disk)"
//                             切割点: headword 开始的空格位置
//  10. fallback_aggressive   — 当前面规则都没切但检测为脏, 用最严格规则
//                             找"中文 + 空格 + 4-15 字符英文" 切掉
//                             兜底覆盖所有"被串的相邻词条"案例
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

// C-Phase3 词性标签白名单 (跟 scan-dirty-defs.ts 保持一致)
const ENGLISH_POS_TAGS = [
  'v.', 'n.', 'adj.', 'adv.', 'prep.', 'conj.', 'pron.', 'art.', 'aux.',
  'vt.', 'vi.', 'int.', 'num.', 'det.'
]

// C-Phase3 语法词白名单 (跟 scan-dirty-defs.ts 保持一致)
const GRAMMAR_WORD_HEADWORDS = new Set<string>([
  'n', 'v', 'adj', 'adv', 'prep', 'conj', 'pron', 'art', 'aux', 'vt', 'vi', 'int', 'num', 'det',
  'noun', 'verbs', 'verb', 'adjective', 'adverb', 'preposition', 'conjunction',
  'pronoun', 'article', 'auxiliary', 'interjection', 'numeral', 'determiner',
  'to', 'of', 'for', 'in', 'on', 'at', 'by', 'with', 'from', 'as', 'an', 'the',
  'a', 'i', 'or', 'and', 'so', 'but', 'if',
  'it', 'is', 'do', 'be',
  'my', 'your', 'his', 'its', 'our', 'their',
  'me', 'you', 'him', 'her', 'us', 'them',
  'mine', 'yours', 'hers', 'ours', 'theirs',
  'myself', 'yourself', 'himself', 'herself', 'itself', 'ourselves', 'themselves',
  'this', 'that', 'these', 'those',
  'who', 'whom', 'whose', 'which', 'what', 'where', 'when', 'why', 'how',
])

// 常见英文虚词 — 出现 2+ 个强烈提示是英文内容
const ENGLISH_FUNCTION_WORDS_SET = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'to', 'of', 'in', 'on', 'at', 'by', 'for', 'with', 'from', 'as',
  'and', 'or', 'but', 'so', 'if', 'than', 'that', 'this', 'these', 'those',
  'it', 'its', 'he', 'she', 'they', 'we', 'i', 'you', 'he', 'him', 'her',
  'my', 'your', 'his', 'our', 'their', 'mine', 'yours', 'hers', 'ours', 'theirs',
])

function isEnglishPosTag(word: string): boolean {
  return ENGLISH_POS_TAGS.some(t => t.replace('.', '').toLowerCase() === word.toLowerCase())
}

function isFunctionWord(word: string): boolean {
  return ENGLISH_FUNCTION_WORDS_SET.has(word.toLowerCase())
}

function isAscii(s: string): boolean {
  return /^[\x00-\x7F]+$/.test(s)
}

/**
 * 核心清洗: 从脏字符串里提取"看起来像中文释义"的部分
 * 启发式:
 *   - 找到第一个 [xxx] (音标) 或 (xxx 英文括号 或 " drink" " drive" 这种 " space+headword" 模式
 *   - 返回从开头到那个位置前的中文部分
 *
 * C-Phase3 新增规则:
 *   8. cut_at_embedded_word  — 中文 + 短英文headword + (中文|左括号) 模式
 *   9. cut_at_paren_english  — 短英文headword + 空格 + (英文括号) 模式
 *  10. fallback_aggressive   — 兜底, 找"中文+空格+4+英文"切
 */
function cleanValue(dirty: string, headword: string): { cleaned: string; rule: string } {
  if (!dirty) return { cleaned: dirty, rule: 'noop' }

  const v = dirty.trim()
  let cut = v.length  // 切到的位置 (切到 cut 之前)
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

  // 规则 8 (C-Phase3 新增): 找 "中文 + 短英文headword" 模式 (串词)
  // 例: "原因... CD(conpact..." → 切到 "致" 之后空格
  //     "月球... more(much..." → 切到 "物" 之后空格
  //     "需要... neighbour (美..." → 切到 "须" 之后空格
  //     "诚实的... honour (美..." → 切到 "的" 之后空格
  //     "星期五 fridge (=refrig..." → 切到 "五" 之后空格
  //     "责任... DVD(digital..." → 切到 "务" 之后空格
  //     "(外)孙女 grandma=grandmother..." → 切到 "女" 之后空格
  // 模式: 中文字符 + 0-1空格 + 短英文 (2-10) + 0-1空格 + (中文|左括号)
  const embeddedRe = /[\u4e00-\u9fa5]\s?([a-zA-Z]{2,10})\s?[\u4e00-\u9fa5\(\[]/g
  let em
  while ((em = embeddedRe.exec(v)) !== null) {
    const word = em[1]
    // 排除英文 POS 标签
    if (isEnglishPosTag(word)) continue
    // 排除常见英文虚词
    if (isFunctionWord(word)) continue
    // 切割点: 中文字符后 (em.index + 1, 跳过 1 个中文字符, 在空格/英文边界)
    // v[em.index] = 中文字符
    // v[em.index + 1] = 空格或英文 (取决于 \s? 是否匹配)
    // 我们要切到 em.index + 1 (即中文字符的"后一位")
    // 例: "致 CD(" - em.index = "致" 位置, em[0] = "致 CD(", 切割点 = em.index + 1 = 空格位置
    // 例: "物more(" - em.index = "物" 位置, em[0] = "物more(", 切割点 = em.index + 1 = "m" 位置
    const cutPoint = em.index + 1
    if (cutPoint < cut) {
      cut = cutPoint
      rule = 'cut_at_embedded_word'
    }
    break
  }

  // 规则 9 (C-Phase3 新增): 找 "headword (英文括号)" 紧贴模式
  // 例: "fridge (=refrigerator)" "DVD (digital versatile disk)" "(pl BrE)(裤子)背带"
  // 模式: 空格 + 短英文headword (2-10 字符) + 空格 + (英文 + ...)
  const tightParenRe = /\s+([a-zA-Z]{2,10})\s+\(([a-zA-Z][^)]*)\)/
  const tm = v.match(tightParenRe)
  if (tm && tm.index !== undefined && tm.index < cut) {
    const word = tm[1]
    if (!isEnglishPosTag(word) && !isFunctionWord(word)) {
      const cutPoint = tm.index + 1  // 跳过空格 (headword 之前)
      if (cutPoint < cut) {
        cut = cutPoint
        rule = 'cut_at_paren_english'
      }
    }
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

  // 规则 10 (C-Phase3 新增): fallback_aggressive
  // 当前面规则都没切但检测为脏, 用最严格规则:
  // 找"中文 + 空格 + 4+ 字符英文" 切 (4 字符比规则 8 的 2 字符更严, 排除更多边界情况)
  // 兜底覆盖所有"被串的相邻词条"案例
  if (cleaned === v) {
    const fbRe = /[\u4e00-\u9fa5]\s+([a-zA-Z]{4,15})(?=[\s\u4e00-\u9fa5(\[]|$)/
    const fm = v.match(fbRe)
    if (fm && fm.index !== undefined) {
      const cutPoint = fm.index + 1  // 跳过中文字符
      // 排除: 切割点过小 (5 字符内) - 可能是开头的词典格式
      if (cutPoint >= 5 && cutPoint < cut) {
        cut = cutPoint
        rule = 'fallback_aggressive'
        cleaned = v.slice(0, cut).trim()
      }
    }
  }

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

  console.log(`\n🧹  linguacraft 脏分级释义清洗器 (C-Phase3 智能规则)`)
  console.log(`   数据库:   ${mongoUrl}`)
  console.log(`   模式:     ${APPLY ? '⚠️  APPLY (会写库)' : '🔍 DRY-RUN (只看, 不写)'}`)
  console.log(`   脏词数:   ${dirtyWords.length}`)
  console.log(`   限制:     ${LIMIT > 0 ? `前 ${LIMIT} 个` : '全部'}`)
  console.log(`   规则:     cut_at_ipa / cut_at_next_word / cut_at_paren + `)
  console.log(`             cut_at_embedded_word / cut_at_paren_english / fallback_aggressive (新)`)
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
  console.log(`  📋 清洗预览 (前 30 条, 只显示变化的)`)
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
  // 统计未变化
  const unchanged = total - changed.length
  const unchangedByGrade: Record<string, number> = {}
  for (const r of results.filter(r => !r.changed)) {
    unchangedByGrade[r.grade] = (unchangedByGrade[r.grade] || 0) + 1
  }

  console.log('\n')
  console.log('═'.repeat(72))
  console.log(`  📊 清洗统计`)
  console.log('═'.repeat(72))
  console.log(`  脏字段总数:    ${total}`)
  console.log(`  实际可清洗:    ${changed.length} (${pct(changed.length, total)})`)
  console.log(`  无变化:        ${unchanged} (${pct(unchanged, total)})`)
  console.log('')
  console.log('  清洗规则分布:')
  for (const [r, n] of Object.entries(byRule).sort((a, b) => b[1] - a[1])) {
    console.log(`    ${(r + '                              ').slice(0, 30)} ${String(n).padStart(4)}`)
  }
  console.log('')
  if (Object.keys(unchangedByGrade).length > 0) {
    console.log('  无变化学段分布:')
    for (const [g, n] of Object.entries(unchangedByGrade).sort((a, b) => b[1] - a[1])) {
      console.log(`    ${(g + '                              ').slice(0, 20)} ${String(n).padStart(4)}`)
    }
    console.log('')
  }

  // 写 JSON
  const outFile = APPLY ? '/tmp/linguacraft-cleanup-applied.json' : '/tmp/linguacraft-cleanup-preview.json'
  fs.writeFileSync(outFile, JSON.stringify({
    generatedAt: new Date().toISOString(),
    mode: APPLY ? 'apply' : 'dry-run',
    totalFields: total,
    changedFields: changed.length,
    unchangedFields: unchanged,
    byRule,
    unchangedByGrade,
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

    // 写库后再用 mongo countDocuments 验证脏字段数
    console.log('')
    console.log('═'.repeat(72))
    console.log(`  🔍 写库后验证 (countDocuments 查脏字段数)`)
    console.log('═'.repeat(72))
    const afterScan = await scanDirtyCount(VocabWord)
    console.log(`  写库后脏字段数: ${afterScan}`)
    console.log(`  Cleanup 完成后, 预期脏字段数从 ${scan.dirtyFieldCount} 降到 ${afterScan} (新规则触发了 ${(byRule['cut_at_embedded_word'] || 0) + (byRule['cut_at_paren_english'] || 0) + (byRule['fallback_aggressive'] || 0)} 次)`)
    console.log('═'.repeat(72))
  } else {
    console.log('💡 试运行, 没改任何数据。跑 `npx ts-node scripts/cleanup-dirty-defs.ts --apply` 写入数据库。')
  }

  await mongoose.disconnect()
}

/**
 * 写库后再扫一次, 统计剩余脏字段数
 * 用同样的检测规则 (跟 scan-dirty-defs.ts 一致)
 */
async function scanDirtyCount(VocabWord: any): Promise<number> {
  // 简单复用 scan-dirty-defs 的核心检测
  const { detectPollution } = await import('./scan-dirty-defs').catch(() => ({ detectPollution: null as any }))
  if (!detectPollution) return -1

  const all = await VocabWord.find({}).lean() as unknown as VocabWord[]
  let dirty = 0
  for (const w of all) {
    const defs = (w as any).definitions || {}
    for (const gk of GRADE_KEYS) {
      const val = defs[gk]
      if (!val) continue
      const reasons = detectPollution(val, w.headword, w.ipa, w.pos)
      if (reasons.length > 0) dirty++
    }
  }
  return dirty
}

function pct(n: number, total: number): string {
  if (!total) return '0.0%'
  return ((n / total) * 100).toFixed(1) + '%'
}

main().catch((e) => {
  console.error('cleanup failed:', e)
  process.exit(1)
})
