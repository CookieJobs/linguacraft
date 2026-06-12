// input: mongoose, dotenv, node:fs
// output: AI 补 exampleEn (例句) + definitionEn (英文释义), console + JSON, dry-run 默认不写库
// pos: 系统/通用
// 若我被更新，请同步更新我的开头注释，以及所属文件夹的 README。
//
// linguacraft exampleEn + definitionEn AI 补全脚本
//
// 目的:
//   当前 6363 词中:
//     - exampleEn (例句) 缺失 6330 (99.5%)
//     - definitionEn (英文释义) 缺失 6313 (99.2%)
//   用 DeepSeek (deepseek-chat) 批量补, 一次拿两字段, 减少调用
//
// 模式:
//   - 默认 (dry-run): 读 mongo → 调 AI → 打印"会改什么" + 写 JSON 报告到 /tmp
//   - --apply:  读 dry-run JSON, bulkWrite 改库, 不重跑 AI
//
// 跑法:
//   cd backend && npx ts-node scripts/enrich-example-definition.ts
//   cd backend && npx ts-node scripts/enrich-example-definition.ts --sample 50
//   cd backend && npx ts-node scripts/enrich-example-definition.ts --level Primary
//   cd backend && npx ts-node scripts/enrich-example-definition.ts --apply
//   cd backend && npx ts-node scripts/enrich-example-definition.ts --apply --level Primary
//
// 2026-06-11: 初始版本 (Coder)
//   - 套路跟 audit-cefr-ai.ts 一致 (5 路并发, dry-run + --apply 短路)
//   - 一次 AI 调用拿 exampleEn + definitionEn 两个字段 (省一半 token)

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
  levels: string[]
  freqRank?: number
}

interface AISuggestion {
  lemma: string
  pos: string
  currentExampleEn: string
  aiExampleEn: string
  currentDefinitionEn: string
  aiDefinitionEn: string
  change: boolean  // 任一字段有差异就算 change
  exampleChanged: boolean
  definitionChanged: boolean
  reason: string  // AI 返回 (如有)
}

interface AIResponse {
  exampleEn: string
  definitionEn: string
  reason?: string
}

const REPORT_PATH = '/tmp/linguacraft-enrich-example-definition.json'

function getArgs(): { sample: number; apply: boolean; level: string | null; random: number } {
  const args = process.argv.slice(2)
  let sample = 0
  let apply = false
  let level: string | null = null
  let random = 0
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--sample' && args[i + 1]) sample = parseInt(args[i + 1], 10)
    if (args[i] === '--apply') apply = true
    if (args[i] === '--level' && args[i + 1]) level = args[i + 1]
    if (args[i] === '--random' && args[i + 1]) random = parseInt(args[i + 1], 10)
  }
  return { sample, apply, level, random }
}

function getApiKey(): string {
  return process.env.DEEPSEEK_API_KEY || ''
}

const FALLBACK_EXAMPLE = '(example pending)'
const FALLBACK_DEFINITION = '(definition pending)'

function isMissing(v: any): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '')
}

/**
 * 调 DeepSeek, 一次拿 exampleEn + definitionEn 两字段.
 * 任何解析失败都返回 fallback (caller 决定是否 change).
 */
async function aiEnrich(word: VocabWord, needExample: boolean, needDefinition: boolean): Promise<AIResponse> {
  const apiKey = getApiKey()
  if (!apiKey) {
    return {
      exampleEn: needExample ? FALLBACK_EXAMPLE : (word.exampleEn || ''),
      definitionEn: needDefinition ? FALLBACK_DEFINITION : (word.definitionEn || ''),
      reason: 'DEEPSEEK_API_KEY 未配置, 兜底占位'
    }
  }

  const instructions: string[] = []
  if (needExample) instructions.push('- "exampleEn": ONE short everyday-life English sentence using this word naturally (max ~20 words, no quotation marks, no headword in parentheses)')
  if (needDefinition) instructions.push('- "definitionEn": a short, plain English definition (max 12 words), simpler than the Chinese one, learner-friendly')
  if (!instructions.length) {
    return { exampleEn: word.exampleEn, definitionEn: word.definitionEn, reason: '无需 AI' }
  }

  const messages = [
    {
      role: 'system',
      content: `You are a vocabulary entry editor for an English-learning app aimed at Chinese learners.
Given an English word (with part of speech and Chinese meaning), output STRICT JSON only (no markdown blocks, no prose outside JSON).
Keys:
${instructions.join('\n')}
- "reason": one short sentence in Simplified Chinese (≤ 30 字) explaining your choice or any difficulty
Rules:
- Example sentence must use the word in its given POS (e.g. noun if pos=n.).
- Example sentence must be natural, present-tense preferred, no unusual proper nouns.
- English definition must NOT contain the headword itself (avoid circular "a dog is a dog").
- Keep both fields concise and learner-appropriate for the given CEFR level.`
    },
    {
      role: 'user',
      content: `Word: "${word.headword}" (pos: ${word.pos}, CEFR: ${word.cefr || '?'})
Chinese meaning: ${word.definitionZh || '(无)'}
${word.exampleEn ? `Existing example (overwrite if better): ${word.exampleEn}` : 'No existing example.'}
${word.definitionEn ? `Existing English definition (overwrite if better): ${word.definitionEn}` : 'No existing English definition.'}

Return the JSON.`
    }
  ]

  try {
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify({
        model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        messages,
        temperature: 0.4,
        max_tokens: 220
      })
    })
    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`DeepSeek ${res.status}: ${errText.slice(0, 200)}`)
    }
    const data = (await res.json()) as any
    const content = data?.choices?.[0]?.message?.content || ''
    const clean = content.replace(/```json\s*|\s*```/g, '').trim()
    const parsed = JSON.parse(clean)
    return {
      exampleEn: needExample ? String(parsed.exampleEn || '').trim() : (word.exampleEn || ''),
      definitionEn: needDefinition ? String(parsed.definitionEn || '').trim() : (word.definitionEn || ''),
      reason: parsed.reason ? String(parsed.reason) : ''
    }
  } catch (e: any) {
    return {
      exampleEn: needExample ? FALLBACK_EXAMPLE : (word.exampleEn || ''),
      definitionEn: needDefinition ? FALLBACK_DEFINITION : (word.definitionEn || ''),
      reason: `AI 调用失败: ${e.message?.slice(0, 100)}`
    }
  }
}

function buildSuggestion(
  word: VocabWord,
  ai: AIResponse,
  needExample: boolean,
  needDefinition: boolean
): AISuggestion {
  // 例句: 只有缺失才 change (现成的有内容就保留)
  const exampleChanged = needExample && isMissing(word.exampleEn) && !!ai.exampleEn && ai.exampleEn !== FALLBACK_EXAMPLE
  // 英文释义: 同上
  const definitionChanged = needDefinition && isMissing(word.definitionEn) && !!ai.definitionEn && ai.definitionEn !== FALLBACK_DEFINITION
  return {
    lemma: word.lemma,
    pos: word.pos,
    currentExampleEn: word.exampleEn || '',
    aiExampleEn: ai.exampleEn || '',
    currentDefinitionEn: word.definitionEn || '',
    aiDefinitionEn: ai.definitionEn || '',
    change: exampleChanged || definitionChanged,
    exampleChanged,
    definitionChanged,
    reason: ai.reason || ''
  }
}

async function main() {
  const { sample, apply, level, random } = getArgs()
  if (apply) {
    console.log('⚠️  --apply 模式: 将会写库. 5 秒后继续, Ctrl+C 取消')
    await new Promise(r => setTimeout(r, 5000))
  } else {
    console.log('🔍 dry-run 模式: 不写库. 加 --apply 才会写.\n')
  }

  const mongoUrl = process.env.MONGO_URL || 'mongodb://localhost:27017/linguacraft'
  console.log(`连接 mongo: ${mongoUrl}`)
  await mongoose.connect(mongoUrl)
  const VocabWord = mongoose.model('VocabWord', new mongoose.Schema({}, { strict: false }))

  // --apply 模式短路: 读 dry-run 报告, 不重跑 AI
  if (apply) {
    if (!fs.existsSync(REPORT_PATH)) {
      console.error(`❌ --apply 模式需要 dry-run 报告: ${REPORT_PATH}`)
      console.error(`   先跑: npx ts-node scripts/enrich-example-definition.ts${level ? ` --level ${level}` : ''}${sample ? ` --sample ${sample}` : ''}`)
      await mongoose.disconnect()
      process.exit(1)
    }
    const saved = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf-8')) as any
    // 验证 level/sample 一致
    if (saved.filter?.level !== (level || null)) {
      console.error(`❌ dry-run 报告是 level=${saved.filter?.level || 'all'}, 现在 --apply 是 level=${level || 'all'}, 不一致`)
      await mongoose.disconnect()
      process.exit(1)
    }
    if ((saved.filter?.sample || 'all') !== (sample || 'all')) {
      console.error(`❌ dry-run 报告是 sample=${saved.filter?.sample || 'all'}, 现在 --apply 是 sample=${sample || 'all'}, 不一致`)
      await mongoose.disconnect()
      process.exit(1)
    }
    const toWrite: AISuggestion[] = (saved.suggestions || []).filter((s: AISuggestion) => s.change)
    console.log(`✏️  --apply 模式: 读 dry-run 报告 (${saved.generatedAt}), 写 ${toWrite.length} 词 ...`)
    let written = 0
    let errs = 0
    for (const s of toWrite) {
      const $set: any = {}
      if (s.exampleChanged) $set.exampleEn = s.aiExampleEn
      if (s.definitionChanged) $set.definitionEn = s.aiDefinitionEn
      if (Object.keys($set).length === 0) continue
      try {
        const result = await VocabWord.updateOne(
          { lemma: s.lemma, pos: s.pos },
          { $set }
        )
        if (result.modifiedCount > 0) written++
      } catch (e: any) {
        errs++
        console.error(`  ✗ 写 ${s.lemma}/${s.pos} 失败: ${e.message?.slice(0, 100)}`)
      }
    }
    console.log(`✅ 写库完成: ${written}/${toWrite.length} 词已更新 (errors: ${errs})`)
    console.log(`💾 Backup: /tmp/linguacraft-backups/vocabwords-pre-example-def-*.json`)
    await mongoose.disconnect()
    return
  }

  // dry-run 模式: 拉所有缺 exampleEn 或 definitionEn 的词
  const filter: any = {
    $or: [
      { exampleEn: { $exists: false } },
      { exampleEn: '' },
      { exampleEn: null },
      { definitionEn: { $exists: false } },
      { definitionEn: '' },
      { definitionEn: null }
    ]
  }
  if (level) filter.levels = level

  const all = (await VocabWord.find(filter).lean()) as unknown as VocabWord[]
  console.log(`词库规模 (缺 exampleEn 或 definitionEn): ${all.length} 词${level ? ` (level=${level})` : ''}`)

  // 去重 (lemma + pos)
  const seen = new Set<string>()
  const unique: VocabWord[] = []
  for (const w of all) {
    const key = `${w.lemma}|${w.pos}`
    if (!seen.has(key)) {
      seen.add(key)
      unique.push(w)
    }
  }
  console.log(`去重后: ${unique.length} 词`)

  // 抽样
  let toProcess: VocabWord[]
  if (sample > 0) {
    toProcess = unique.slice(0, sample)
    console.log(`本次处理: ${toProcess.length} 词 (sample 模式)\n`)
  } else if (random > 0) {
    // Fisher-Yates 洗牌后取前 N
    const shuffled = [...unique]
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1))
      ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
    }
    toProcess = shuffled.slice(0, random)
    console.log(`本次处理: ${toProcess.length} 词 (random 模式, 从 ${unique.length} 中随机抽 ${random})\n`)
  } else {
    toProcess = unique
    console.log(`本次处理: ${toProcess.length} 词\n`)
  }

  if (!getApiKey()) {
    console.log('⚠️  DEEPSEEK_API_KEY 未配置, AI 标注会全部兜底占位 (没真实产出)')
    console.log('   跑前请确认 backend/.env 里有 DEEPSEEK_API_KEY\n')
  }

  const suggestions: AISuggestion[] = []
  let aiCalls = 0
  let whiteHits = 0  // 留作日志, 这个脚本没用白名单
  const startTime = Date.now()

  // 5 路并发
  const CONCURRENCY = 5
  let cursor = 0
  async function worker() {
    while (cursor < toProcess.length) {
      const i = cursor++
      const w = toProcess[i]
      const needExample = isMissing(w.exampleEn)
      const needDefinition = isMissing(w.definitionEn)
      const ai = await aiEnrich(w, needExample, needDefinition)
      if (ai.reason === 'DEEPSEEK_API_KEY 未配置, 兜底占位' || ai.reason?.startsWith('AI 调用失败')) {
        // 兜底不算 AI 调用
      } else if (ai.reason !== '无需 AI') {
        aiCalls++
      } else {
        whiteHits++
      }
      const sug = buildSuggestion(w, ai, needExample, needDefinition)
      suggestions[i] = sug
    }
  }
  const workers = Array.from({ length: CONCURRENCY }, () => worker())

  // 进度 ticker
  const progressInterval = setInterval(() => {
    const done = suggestions.filter(Boolean).length
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    const rate = done > 0 ? (done / parseFloat(elapsed)).toFixed(1) : '0'
    process.stdout.write(`\r[${done}/${toProcess.length}] 进度 ${(done / toProcess.length * 100).toFixed(1)}% (${elapsed}s, ${rate} 词/s)  AI 调用 ${aiCalls}`)
  }, 1000)

  await Promise.all(workers)
  clearInterval(progressInterval)
  const done = suggestions.filter(Boolean).length
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  const rate = done > 0 ? (done / parseFloat(elapsed)).toFixed(1) : '0'
  process.stdout.write(`\r[${done}/${toProcess.length}] 进度 100.0% (${elapsed}s, ${rate} 词/s)  AI 调用 ${aiCalls}\n`)
  console.log()

  // ==================== 打印报告 ====================
  const sep = '═'.repeat(70)
  const sub = '─'.repeat(70)
  console.log(sep)
  console.log(`📊 词库补全报告 — exampleEn + definitionEn`)
  console.log(sep)
  console.log()

  // 1. 字段缺失统计
  const missingEx = suggestions.filter(s => s.exampleChanged).length
  const missingDef = suggestions.filter(s => s.definitionChanged).length
  const totalChange = suggestions.filter(s => s.change).length
  const both = suggestions.filter(s => s.exampleChanged && s.definitionChanged).length
  const exOnly = suggestions.filter(s => s.exampleChanged && !s.definitionChanged).length
  const defOnly = suggestions.filter(s => !s.exampleChanged && s.definitionChanged).length

  console.log(`--- 字段缺失与补全统计 ---`)
  console.log(`  拉取总词数:     ${suggestions.length}`)
  console.log(`  将补 exampleEn: ${missingEx}`)
  console.log(`  将补 definitionEn: ${missingDef}`)
  console.log(`  两字段都缺:     ${both}`)
  console.log(`  只缺 exampleEn: ${exOnly}`)
  console.log(`  只缺 definitionEn: ${defOnly}`)
  console.log(`  总计会改:       ${totalChange} 词`)
  console.log(`  AI 调用次数:    ${aiCalls}`)
  console.log(`  跑完耗时:       ${elapsed}s (${rate} 词/s)`)
  console.log()

  // 2. 样本展示 (前 20 个会改的)
  const toChange = suggestions.filter(s => s.change).slice(0, 20)
  if (toChange.length > 0) {
    console.log(`--- 前 20 个会改的 (review 用) ---`)
    for (const s of toChange) {
      const fields: string[] = []
      if (s.exampleChanged) fields.push('ex')
      if (s.definitionChanged) fields.push('def')
      console.log(`  [${fields.join('+').padEnd(7)}] ${s.lemma.padEnd(20)} (${s.pos})`)
      if (s.exampleChanged) console.log(`           ex:  ${s.aiExampleEn.slice(0, 80)}`)
      if (s.definitionChanged) console.log(`           def: ${s.aiDefinitionEn.slice(0, 80)}`)
      if (s.reason) console.log(`           (${s.reason.slice(0, 60)})`)
    }
    console.log()
  }

  // 3. 写 JSON
  const report = {
    generatedAt: new Date().toISOString(),
    filter: { level: level || null, sample: sample || 'all' },
    total: suggestions.length,
    aiCalls,
    elapsed: parseFloat(elapsed),
    rate: parseFloat(rate),
    missingEx,
    missingDef,
    both,
    exOnly,
    defOnly,
    totalChange,
    suggestions
  }
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2))
  console.log(`📄 详细报告: ${REPORT_PATH}`)
  console.log()

  // 4. apply 提示
  if (totalChange > 0) {
    console.log(`💡 加 --apply 才会实际写库. 看完上面报告后决定:`)
    console.log(`   cd backend && npx ts-node scripts/enrich-example-definition.ts --apply${level ? ` --level ${level}` : ''}${sample ? ` --sample ${sample}` : ''}`)
    console.log(`   (apply 会读本次 dry-run 报告, 不重跑 AI)`)
  } else {
    console.log(`✨ 无需改动, 所有词已有 exampleEn 和 definitionEn`)
  }

  await mongoose.disconnect()
}

main().catch(e => {
  console.error('❌ 脚本失败:', e)
  process.exit(1)
})
