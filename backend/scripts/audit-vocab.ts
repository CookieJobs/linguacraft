// input: mongoose, fs, path
// output: 词库审计报告 (console + JSON)
// pos: 系统/通用
// 若我被更新,请同步更新我的开头注释,以及所属的文件夹的 README。
//
// linguacraft 词库审计脚本 (替代占位版的 validate-vocab.ts)
//
// 报告维度:
//   1. 全局统计: 总词数 / 各级 level 分布 / CEFR 分布
//   2. 数据完整性: definitionZh/En/Example/IPA/Audio/FreqRank 的缺失数
//   3. isDummyExample 占比: exampleEn 是否还是 "Example for {headword}" 这种占位
//   4. contextualDefinitions 覆盖率 (按 textbook 维度)
//   5. 按 level 分组: 小学/初中/高中/四级/六级 各自的 isDummyExample 占比 (重点看小学)
//
// 输出:
//   - 控制台: 漂亮的可读报告
//   - JSON:   /tmp/linguacraft-vocab-audit.json 详细数据

import * as mongoose from 'mongoose'
import * as dotenv from 'dotenv'
import * as fs from 'fs'
dotenv.config()

interface VocabWord {
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
  definitions?: Record<string, string>
  contextualDefinitions?: { textbook: string; definitionZh: string; exampleEn: string }[]
}

const LEVELS = ['Primary', 'Middle', 'High', 'University', 'Professional', 'CET4', 'CET6']

function pct(n: number | undefined, total: number): string {
  if (!n || total === 0) return '0.0%'
  return ((n / total) * 100).toFixed(1) + '%'
}

function isDummyExample(w: VocabWord): boolean {
  return !!w.exampleEn && w.exampleEn.startsWith('Example for ') && w.exampleEn.includes(w.headword)
}

function isMissing(s: any): boolean {
  return !s || (typeof s === 'string' && s.trim() === '')
}

async function main() {
  const mongoUrl = process.env.MONGO_URL || 'mongodb://localhost:27017/linguacraft'
  await mongoose.connect(mongoUrl)
  const VocabWord = mongoose.model('VocabWord', new mongoose.Schema({}, { strict: false }))
  const all = await VocabWord.find({}).lean() as unknown as VocabWord[]

  const total = all.length
  const report: any = {
    generatedAt: new Date().toISOString(),
    total,
    byLevel: {} as Record<string, number>,
    byCefr: {} as Record<string, number>,
    completeness: {
      missingDefinitionZh: 0,
      missingDefinitionEn: 0,
      missingExampleEn: 0,
      missingIpa: 0,
      missingAudioUrl: 0,
      missingFreqRank: 0,
      missingPos: 0,
      isDummyExample: 0
    },
    contextualDefs: {
      totalRecords: 0,
      distinctTextbooks: 0,
      byTextbook: {} as Record<string, number>
    },
    examples: { dummy: 0, real: 0 },
    byLevelDetails: {} as Record<string, any>
  }

  // 收集
  for (const w of all) {
    // level
    for (const lv of (w.levels || [])) {
      report.byLevel[lv] = (report.byLevel[lv] || 0) + 1
    }
    // cefr
    const c = (w.cefr || 'UNKNOWN').toUpperCase()
    report.byCefr[c] = (report.byCefr[c] || 0) + 1

    // completeness
    if (isMissing(w.definitionZh)) report.completeness.missingDefinitionZh++
    if (isMissing(w.definitionEn)) report.completeness.missingDefinitionEn++
    if (isMissing(w.exampleEn)) report.completeness.missingExampleEn++
    if (isMissing(w.ipa)) report.completeness.missingIpa++
    if (isMissing(w.audioUrl)) report.completeness.missingAudioUrl++
    if (w.freqRank == null) report.completeness.missingFreqRank++
    if (isMissing(w.pos)) report.completeness.missingPos++

    // dummy example
    if (isDummyExample(w)) {
      report.completeness.isDummyExample++
      report.examples.dummy++
    } else if (!isMissing(w.exampleEn)) {
      report.examples.real++
    }

    // contextualDefinitions
    for (const cd of (w.contextualDefinitions || [])) {
      report.contextualDefs.totalRecords++
      report.contextualDefs.byTextbook[cd.textbook] = (report.contextualDefs.byTextbook[cd.textbook] || 0) + 1
    }
  }
  report.contextualDefs.distinctTextbooks = Object.keys(report.contextualDefs.byTextbook).length

  // 按 level 分组(按"主 level"分:一个词可能在多个 level 里,这里统计"包含该 level 的词数")
  for (const lv of LEVELS) {
    const subset = all.filter(w => (w.levels || []).includes(lv))
    const dummy = subset.filter(isDummyExample).length
    const withRealExample = subset.filter(w => !isDummyExample(w) && !isMissing(w.exampleEn)).length
    const withEmptyExample = subset.filter(w => isMissing(w.exampleEn)).length
    const withAudio = subset.filter(w => !isMissing(w.audioUrl)).length
    const withIpa = subset.filter(w => !isMissing(w.ipa)).length
    const withDefZh = subset.filter(w => !isMissing(w.definitionZh)).length

    report.byLevelDetails[lv] = {
      count: subset.length,
      dummyExample: dummy,
      realExample: withRealExample,
      emptyExample: withEmptyExample,
      hasAudioUrl: withAudio,
      hasIpa: withIpa,
      hasDefinitionZh: withDefZh,
      dummyExamplePct: pct(dummy, subset.length),
      realExamplePct: pct(withRealExample, subset.length)
    }
  }

  // ==================== 打印可读报告 ====================
  const lines: string[] = []
  const sep = '═'.repeat(70)
  const sub = '─'.repeat(70)

  lines.push('')
  lines.push(sep)
  lines.push('  📚  linguacraft 词库审计报告')
  lines.push(sep)
  lines.push(`  生成时间: ${report.generatedAt}`)
  lines.push(`  数据库:   ${mongoUrl}`)
  lines.push(`  总词数:   ${total}`)
  lines.push('')

  lines.push(sub)
  lines.push('  📊 全局分布')
  lines.push(sub)
  lines.push(`  Level 分布:`)
  const sortedLevels = (Object.entries(report.byLevel) as [string, number][]).sort((a, b) => b[1] - a[1])
  for (const [lv, n] of sortedLevels) {
    lines.push(`    ${(lv + '                    ').slice(0, 18)} ${String(n).padStart(5)}  ${pct(n, total)}`)
  }
  lines.push('')
  lines.push(`  CEFR 分布:`)
  const sortedCefr = (Object.entries(report.byCefr) as [string, number][]).sort((a, b) => b[1] - a[1])
  for (const [c, n] of sortedCefr) {
    lines.push(`    ${(c + '                    ').slice(0, 18)} ${String(n).padStart(5)}  ${pct(n, total)}`)
  }
  lines.push('')

  lines.push(sub)
  lines.push('  🩺 数据完整性 (缺失数 / 占比)')
  lines.push(sub)
  const c = report.completeness
  const checks = [
    ['缺中文释义 (definitionZh)', c.missingDefinitionZh],
    ['缺英文释义 (definitionEn)', c.missingDefinitionEn],
    ['缺例句 (exampleEn 空)', c.missingExampleEn],
    ['缺 IPA (音标)', c.missingIpa],
    ['缺音频 URL', c.missingAudioUrl],
    ['缺词频 (freqRank)', c.missingFreqRank],
    ['缺词性 (pos)', c.missingPos],
    ['占位例句 (isDummyExample)', c.isDummyExample]
  ]
  for (const [name, n] of checks) {
    const flag = n === 0 ? '✅' : n > total * 0.3 ? '🔴' : n > total * 0.05 ? '🟡' : '🟢'
    lines.push(`  ${flag}  ${(name + '                                  ').slice(0, 40)} ${String(n).padStart(5)}  ${pct(n, total)}`)
  }
  lines.push('')
  lines.push(`  例句构成:`)
  lines.push(`    真实例句: ${report.examples.real}  ${pct(report.examples.real, total)}`)
  lines.push(`    占位例句: ${report.examples.dummy}  ${pct(report.examples.dummy, total)}`)
  lines.push(`    完全空:   ${total - report.examples.real - report.examples.dummy}  ${pct(total - report.examples.real - report.examples.dummy, total)}`)
  lines.push('')

  lines.push(sub)
  lines.push('  📖 语境化释义 (contextualDefinitions)')
  lines.push(sub)
  lines.push(`  覆盖的教材数: ${report.contextualDefs.distinctTextbooks}`)
  lines.push(`  语境释义总条数: ${report.contextualDefs.totalRecords}`)
  if (report.contextualDefs.totalRecords > 0) {
    const topTextbooks = (Object.entries(report.contextualDefs.byTextbook) as [string, number][])
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
    lines.push(`  Top 5 教材覆盖 (词条数):`)
    for (const [tb, n] of topTextbooks) {
      lines.push(`    ${(tb + '                                                  ').slice(0, 50)} ${n}`)
    }
  }
  lines.push('')

  lines.push(sub)
  lines.push('  🎓 按 Level 分组审计 (重点看小学)')
  lines.push(sub)
  for (const lv of LEVELS) {
    const d = report.byLevelDetails[lv]
    if (!d || d.count === 0) continue
    const healthIcon = parseFloat(d.dummyExamplePct) > 50 ? '🔴'
      : parseFloat(d.dummyExamplePct) > 20 ? '🟡'
      : '🟢'
    lines.push(`  ${healthIcon}  ${lv}  (${d.count} 词)`)
    lines.push(`      占位例句: ${d.dummyExample} (${d.dummyExamplePct})`)
    lines.push(`      真实例句: ${d.realExample} (${d.realExamplePct})`)
    lines.push(`      完全空:   ${d.emptyExample}`)
    lines.push(`      有音频:   ${d.hasAudioUrl} (${pct(d.hasAudioUrl, d.count)})`)
    lines.push(`      有音标:   ${d.hasIpa} (${pct(d.hasIpa, d.count)})`)
    lines.push('')
  }

  lines.push(sep)
  lines.push('  ✅ / ⚠️  修复建议')
  lines.push(sep)
  const suggestions: string[] = []
  if (c.isDummyExample > 0) {
    const primaryDummy = report.byLevelDetails['Primary']?.dummyExample || 0
    suggestions.push(`  1. 占位例句 ${c.isDummyExample} 条,小学最多 (${primaryDummy} 条)`)
    suggestions.push(`     跑 scripts/generate-contextual-defs.ts 用 DeepSeek 补真实例句`)
  }
  if (c.missingAudioUrl > 0) {
    suggestions.push(`  2. 缺音频 ${c.missingAudioUrl} 条`)
    suggestions.push(`     检查 audio 字段是否被 AudioService 注入,或跑 update-audio-urls.ts`)
  }
  if (c.missingIpa > 0) {
    suggestions.push(`  3. 缺音标 ${c.missingIpa} 条 (${pct(c.missingIpa, total)})`)
    suggestions.push(`     用 DeepSeek 批量补 IPA,或查导入脚本是否漏字段`)
  }
  if (c.missingDefinitionZh > 0) {
    suggestions.push(`  4. 缺中文释义 ${c.missingDefinitionZh} 条,影响中国用户体验`)
    suggestions.push(`     跑 generate-contextual-defs.ts 补全`)
  }
  if (c.missingFreqRank > 0) {
    suggestions.push(`  5. 缺词频 ${c.missingFreqRank} 条 — 影响 pickWords 高频加权`)
  }
  if (suggestions.length === 0) {
    lines.push('  词库质量不错,无需紧急修复 🎉')
  } else {
    lines.push(...suggestions)
  }
  lines.push('')
  lines.push(sep)
  lines.push('')

  console.log(lines.join('\n'))

  // 写 JSON 详细数据
  const out = '/tmp/linguacraft-vocab-audit.json'
  fs.writeFileSync(out, JSON.stringify(report, null, 2), 'utf-8')
  console.log(`📄 详细 JSON: ${out}`)

  await mongoose.disconnect()
}

main().catch((e) => {
  console.error('audit failed:', e)
  process.exit(1)
})
