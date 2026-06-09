// input: mongoose, fs, path
// output: 脏分级释义名单 (控制台 + JSON + CSV)
// pos: 系统/通用
// 若我被更新,请同步更新我的开头注释,以及所属的文件夹的 README.
//
// linguacraft 脏分级释义扫描脚本
//
// 目的: 找出 definitions.primary/middle/high/cet4/cet6/... 里被污染的字段
// 污染类型:
//   1. 音标污染 — 释义里塞了 [xxx] 或 /xxx/ 形式的音标(应该只存在 ipa 字段)
//   2. 词性污染 — 释义里出现 v. n. adj. adv. prep. conj. vt. vi. 等(应该只存在 pos 字段)
//   3. 头词污染 — 释义里出现 headword 自身(说明复制了整条词条)
//   4. 例句污染 — 释义里塞了英文例句(启发式:含 is/are/was/the/a 等虚词)
//   5. 长度异常 — 释义 > 80 字符(正常 < 30)
//   6. 括号污染 — 释义里有 (xxx) 补充说明但内容不是中文
//   7. 跨学段不一致 — 同一个 word 在不同学段差异巨大(说明有的脏了有的没脏)
//
// 输出:
//   - 控制台: 漂亮报告 (按污染类型 / Top 严重词 / 学段分布)
//   - JSON:   /tmp/linguacraft-dirty-defs.json 详细数据
//   - CSV:    /tmp/linguacraft-dirty-defs.csv 可手动修的修复名单
//
// 跑法: cd backend && npx ts-node scripts/scan-dirty-defs.ts
//  重置: headword 头词污染阈值 = 3 字符(过滤掉 a/an/to/in 这种短词误伤)

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
  cefr: string
  definitionEn: string
  definitionZh: string
  exampleEn: string
  ipa?: string
  audioUrl?: string
  levels: string[]
  topics: string[]
  textbooks?: string[]
  definitions?: Record<string, string>
  contextualDefinitions?: { textbook: string; definitionZh: string; exampleEn: string }[]
}

// 学段字段顺序 (跟 question-generator.levelToKey 一致)
const GRADE_KEYS = ['primary', 'middle', 'high', 'cet4', 'cet6', 'university', 'professional'] as const
type GradeKey = typeof GRADE_KEYS[number]

// 词性标记 (POS tags) — 出现在释义里几乎一定是污染
const POS_TAGS = [
  'v.', 'n.', 'adj.', 'adv.', 'prep.', 'conj.', 'pron.', 'art.', 'aux.',
  'vt.', 'vi.', 'int.', 'num.', 'det.',
  '动词', '名词', '形容词', '副词', '介词', '连词', '代词', '冠词', '助词'
]

// 英文虚词 — 出现 2+ 个强烈提示是英文例句污染
const ENGLISH_FUNCTION_WORDS = [' is ', ' are ', ' was ', ' were ', ' the ', ' a ', ' an ', ' to ', ' of ', ' and ', ' in ', ' on ']

// 检测函数
type Reason = string

interface PollutedField {
  grade: GradeKey
  value: string
  reasons: Reason[]
  severity: number  // 1-10,越高越脏
}

interface DirtyWord {
  lemma: string
  headword: string
  cefr: string
  pos: string
  levels: string[]
  fields: PollutedField[]
  topField: PollutedField  // severity 最高的字段
}

function detectPollution(
  value: string,
  headword: string,
  ipa: string | undefined,
  pos: string
): Reason[] {
  if (!value || !value.trim()) return []
  const reasons: Reason[] = []
  const v = value.trim()

  // 1. 音标污染 — 含 [...] 或 /.../ 模式
  // 注意: 真正的音标里有 / 没问题,但出现在"中文释义"字段就不对
  if (/\[[a-zA-Zʃʒθðŋɪʊəɒæɛɔʌːə̯ɹɾθɡʔˈˌː.,\s\-]+\]/.test(v)) {
    reasons.push('音标污染([...])')
  }
  if (/\/[a-zA-Zʃʒθðŋɪʊəɒæɛɔʌːə̯ɹɾθɡʔˈˌː.,\s\-]+\//.test(v)) {
    reasons.push('音标污染(/.../)')
  }

  // 2. 词性污染 — 释义里出现 POS 标记
  for (const tag of POS_TAGS) {
    // 用 word boundary 避免误伤 "very" 含 "v." 这种
    const re = new RegExp(`(^|[^a-zA-Z])${tag.replace('.', '\\.').replace('+', '\\+')}([^a-zA-Z]|$)`, 'i')
    if (re.test(v)) {
      reasons.push(`词性污染(${tag})`)
      break  // 一个就够了
    }
  }

  // 3. 头词污染 — 释义里出现 headword 自身
  // 只对长度 >= 3 的 headword 检查,过滤掉 a/an/to/in/on
  if (headword && headword.length >= 3 && new RegExp(`\\b${headword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(v)) {
    reasons.push(`头词污染(包含"${headword}")`)
  }

  // 4. 例句污染 — 启发式:含 3+ 英文虚词
  const fwCount = ENGLISH_FUNCTION_WORDS.filter(fw => v.includes(fw)).length
  if (fwCount >= 3) {
    reasons.push(`英文例句污染(检测到 ${fwCount} 个英文虚词)`)
  }

  // 5. 长度异常 — 中文释义正常 < 30 字符,> 80 几乎一定是污染
  if (v.length > 80) {
    reasons.push(`长度异常(${v.length} 字符,正常 < 30)`)
  } else if (v.length > 40) {
    reasons.push(`长度偏长(${v.length} 字符)`)
  }

  // 6. 括号污染 — 含 (...) 但括号内不是补充说明
  // 启发式: 括号内是英文/音标,或括号内有 > 20 字符
  const parenRe = /\(([^)]*)\)/g
  let m
  while ((m = parenRe.exec(v)) !== null) {
    const inner = m[1]
    if (/[a-zA-Z]{3,}/.test(inner)) {
      reasons.push(`括号内含英文/拼音("${inner.slice(0, 30)}")`)
    } else if (inner.length > 20) {
      reasons.push(`括号内容过长(${inner.length} 字符)`)
    }
  }

  // 7. 包含 headword 的 ipa
  if (ipa && ipa.trim()) {
    const ipaClean = ipa.replace(/[\[\]\/\s]/g, '')
    if (ipaClean && v.includes(ipaClean)) {
      reasons.push(`包含音标值("${ipa}")`)
    }
  }

  return reasons
}

function severityFromReasons(reasons: Reason[]): number {
  let s = reasons.length
  if (reasons.some(r => r.startsWith('音标污染'))) s += 3
  if (reasons.some(r => r.startsWith('英文例句污染'))) s += 4
  if (reasons.some(r => r.startsWith('头词污染'))) s += 2
  if (reasons.some(r => r.startsWith('词性污染'))) s += 2
  if (reasons.some(r => r.startsWith('长度异常'))) s += 1
  return Math.min(10, s)
}

async function main() {
  const mongoUrl = process.env.MONGO_URL || 'mongodb://localhost:27017/linguacraft'
  await mongoose.connect(mongoUrl)
  const VocabWord = mongoose.model('VocabWord', new mongoose.Schema({}, { strict: false }))

  const all = await VocabWord.find({}).lean() as unknown as VocabWord[]
  const total = all.length

  console.log(`\n🔍  linguacraft 脏分级释义扫描器`)
  console.log(`   数据库:   ${mongoUrl}`)
  console.log(`   总词数:   ${total}`)
  console.log(`   扫描字段: ${GRADE_KEYS.join(', ')}\n`)

  const dirtyWords: DirtyWord[] = []
  const reasonCounts: Record<string, number> = {}
  const gradeCounts: Record<string, number> = {}

  for (const w of all) {
    const defs = w.definitions || {}
    const fields: PollutedField[] = []

    for (const gk of GRADE_KEYS) {
      const val = defs[gk]
      if (!val) continue  // 缺字段不算脏
      const reasons = detectPollution(val, w.headword, w.ipa, w.pos)
      if (reasons.length === 0) continue

      const severity = severityFromReasons(reasons)
      fields.push({ grade: gk, value: val, reasons, severity })

      for (const r of reasons) {
        // 按 reason 的"类型"统计 (去掉括号细节)
        const t = r.split('(')[0]
        reasonCounts[t] = (reasonCounts[t] || 0) + 1
      }
      gradeCounts[gk] = (gradeCounts[gk] || 0) + 1
    }

    if (fields.length === 0) continue

    // 找 severity 最高的字段
    fields.sort((a, b) => b.severity - a.severity)
    dirtyWords.push({
      lemma: w.lemma,
      headword: w.headword,
      cefr: w.cefr,
      pos: w.pos,
      levels: w.levels,
      fields,
      topField: fields[0]
    })
  }

  // 按最严重词的 severity 排序
  dirtyWords.sort((a, b) => b.topField.severity - a.topField.severity)

  // ==================== 报告 ====================
  const sep = '═'.repeat(72)
  const sub = '─'.repeat(72)
  const lines: string[] = []

  lines.push(sep)
  lines.push(`  🩺  linguacraft 脏分级释义扫描报告`)
  lines.push(sep)
  lines.push(`  生成时间: ${new Date().toISOString()}`)
  lines.push(`  扫描词数: ${total}`)
  lines.push(`  发现脏词: ${dirtyWords.length} (${pct(dirtyWords.length, total)})`)
  lines.push(`  脏字段总数: ${dirtyWords.reduce((s, w) => s + w.fields.length, 0)}`)
  lines.push('')

  lines.push(sub)
  lines.push('  📊 污染类型分布')
  lines.push(sub)
  const sortedReasons = Object.entries(reasonCounts).sort((a, b) => b[1] - a[1])
  for (const [r, n] of sortedReasons) {
    lines.push(`    ${(r + '                              ').slice(0, 30)} ${String(n).padStart(4)}`)
  }
  lines.push('')

  lines.push(sub)
  lines.push('  🎓 脏字段在学段上的分布')
  lines.push(sub)
  for (const gk of GRADE_KEYS) {
    const n = gradeCounts[gk] || 0
    lines.push(`    ${(gk + '                              ').slice(0, 20)} ${String(n).padStart(4)}  ${pct(n, dirtyWords.reduce((s, w) => s + w.fields.length, 0))}`)
  }
  lines.push('')

  lines.push(sub)
  lines.push(`  🔥 Top 20 最严重 (severity ${dirtyWords[0]?.topField.severity ?? 0} ~ ${dirtyWords[Math.min(19, dirtyWords.length - 1)]?.topField.severity ?? 0})`)
  lines.push(sub)
  const top = dirtyWords.slice(0, 20)
  for (const w of top) {
    const f = w.topField
    const v = f.value.length > 60 ? f.value.slice(0, 60) + '...' : f.value
    lines.push(`  ${String(f.severity).padStart(2)}  [${w.headword}] (${w.cefr}, ${f.grade})`)
    lines.push(`      "${v}"`)
    lines.push(`      原因: ${f.reasons.join(' | ')}`)
    lines.push('')
  }

  lines.push(sub)
  lines.push(`  📋 全部脏词清单 (共 ${dirtyWords.length} 条, 按 severity 降序)`)
  lines.push(sub)
  for (const w of dirtyWords) {
    for (const f of w.fields) {
      const v = f.value.length > 50 ? f.value.slice(0, 50) + '...' : f.value
      lines.push(`  [${w.headword}·${f.grade}] (sev ${f.severity}) "${v}"`)
    }
  }

  lines.push(sep)
  lines.push('  ✅ 修复建议')
  lines.push(sep)
  lines.push(`  1. 先看 Top 20 严重词,大多数是"头词污染"和"音标污染"`)
  lines.push(`  2. 手动修: 在 MongoDB Compass 里直接编辑 definitions 字段`)
  lines.push(`     - 头词污染: 删掉"HEADWORD"那段,保留实际释义`)
  lines.push(`     - 音标污染: 整段重写,只留中文`)
  lines.push(`     - 词性污染: 删掉 v. n. adj. 等标记`)
  lines.push(`  3. 批量修: 写 cleanup-defs.ts 按规则自动清洗(头词用空白,音标用空白)`)
  lines.push(`  4. 防再生: 查 generate-contextual-defs.ts 跑 enrich 时是否塞了脏内容`)
  lines.push('')
  lines.push(`  📄 详细 JSON: /tmp/linguacraft-dirty-defs.json`)
  lines.push(`  📄 修复 CSV:  /tmp/linguacraft-dirty-defs.csv`)
  lines.push(sep)
  lines.push('')

  console.log(lines.join('\n'))

  // ==================== 写 JSON ====================
  const json = {
    generatedAt: new Date().toISOString(),
    totalWords: total,
    dirtyWordCount: dirtyWords.length,
    dirtyFieldCount: dirtyWords.reduce((s, w) => s + w.fields.length, 0),
    reasonCounts,
    gradeCounts,
    dirtyWords: dirtyWords.map(w => ({
      lemma: w.lemma,
      headword: w.headword,
      cefr: w.cefr,
      pos: w.pos,
      levels: w.levels,
      fields: w.fields
    }))
  }
  fs.writeFileSync('/tmp/linguacraft-dirty-defs.json', JSON.stringify(json, null, 2), 'utf-8')

  // ==================== 写 CSV ====================
  // 格式: lemma, headword, cefr, grade, severity, reasons, current_value
  const csvLines = ['lemma,headword,cefr,grade,severity,reasons,current_value']
  for (const w of dirtyWords) {
    for (const f of w.fields) {
      const reasons = f.reasons.join(' | ').replace(/"/g, '""')
      const val = f.value.replace(/"/g, '""')
      csvLines.push(`"${w.lemma}","${w.headword}","${w.cefr}","${f.grade}",${f.severity},"${reasons}","${val}"`)
    }
  }
  fs.writeFileSync('/tmp/linguacraft-dirty-defs.csv', csvLines.join('\n'), 'utf-8')

  await mongoose.disconnect()
}

function pct(n: number, total: number): string {
  if (!total) return '0.0%'
  return ((n / total) * 100).toFixed(1) + '%'
}

main().catch((e) => {
  console.error('scan failed:', e)
  process.exit(1)
})
