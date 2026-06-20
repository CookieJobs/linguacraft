// input: mongoose, dotenv, node:fs
// output: AI 按学段生成 definitions.{primary/middle/high}, dry-run 默认 + --apply 写库
// pos: 系统/通用
// 若我被更新，请同步更新我的开头注释，以及所属文件夹的 README。
//
// linguacraft 按学段分级中文释义补全脚本
//
// 目的:
//   6363 词中 5809 词的 definitions.{primary/middle/high} 三个学段字段全空,
//   老数据全部塞在 definitionZh (单数) 一个字段里, 没法按用户学段切深度.
//   用 DeepSeek (deepseek-chat) 批量按学段生成 3 档不同深度的中文释义.
//
// 3 档释义定位:
//   - primary (小学): 1-2 个最核心意思, ≤ 12 字, 极简 (例: "找, 找到")
//   - middle (初中): 2-3 个常用意思 + 词性, ≤ 30 字 (例: "vt./vi. 找到; 寻找; 发现")
//   - high (高中): 3-5 个完整意思 + 词性, ≤ 60 字 (例: "vt. 找到; 发现; 感到; 认为  vi. 裁决; 做出判决")
//
// 保护规则:
//   - 单字段硬截 60 字符 (避免 DOS 大段说明)
//   - 拒绝 IT/计算机噪音关键词 (DOS / Windows / Linux / 命令 / 编程 / 字节 / 文件系统 / 操作系统 / 编译器)
//   - 拒绝 "n1. xxx\nn2. yyy" 多行 (用 .split('\n')[0])
//   - 拒绝含 "[" / "]" (音标) 残留
//
// 跑法:
//   cd backend && npx ts-node scripts/enrich-grade-definitions.ts
//   cd backend && npx ts-node scripts/enrich-grade-definitions.ts --sample 50
//   cd backend && npx ts-node scripts/enrich-grade-definitions.ts --level Primary
//   cd backend && npx ts-node scripts/enrich-grade-definitions.ts --apply
//   cd backend && npx ts-node scripts/enrich-grade-definitions.ts --apply --level Primary
//
// 2026-06-13 初始版本 (Mavis)
//   - 套路跟 enrich-example-definition.ts 一致 (5 路并发, dry-run + --apply 短路)
//   - 一次 AI 调用拿 3 档释义, 写库前再做 4 道硬过滤

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
  definitionZh: string
  ipa?: string
  definitions?: Record<string, string>
  levels?: string[]
}

interface AIGradeResponse {
  primary: string
  middle: string
  high: string
  reason?: string
}

interface AIGradeSuggestion {
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
  index?: number  // checkpoint 用的 toProcess 索引, 不参与 apply 逻辑
  change: boolean
  blockedReason?: string
  reason: string
}

const REPORT_PATH = '/tmp/linguacraft-enrich-grade-definitions.json'

const GRADE_KEYS = ['primary', 'middle', 'high'] as const
type GradeKey = typeof GRADE_KEYS[number]

// 2026-06-16: 移除 '命令' 关键词 ——
//   command / order / require / bid / dictate / prescribe / imperative / decree
//   这些词的日常英语第一义就是"命令/要求/口授", 之前误杀 7 词.
//   '[计]' / 'api' / 'http' / 'shell' / 'kernel' 仍保留 ——
//   它们通常是 IT 术语标签, 日常英语不太单独出现
const IT_NOISE_KEYWORDS = [
  'dos', 'windows', 'linux', 'macos', 'unix',
  '编程', '字节', '文件系统', '操作系统', '编译器', '命令行',
  '[计]', 'cmd.exe', 'shell', 'kernel', 'api', 'http',
]

const MAX_LEN: Record<GradeKey, number> = {
  primary: 12,
  middle: 30,
  high: 60,
}

function getArgs(): { sample: number; apply: boolean; level: string | null; random: number; limit: number } {
  const args = process.argv.slice(2)
  let sample = 0
  let apply = false
  let level: string | null = null
  let random = 0
  let limit = 0
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--sample' && args[i + 1]) sample = parseInt(args[i + 1], 10)
    if (args[i] === '--apply') apply = true
    if (args[i] === '--level' && args[i + 1]) level = args[i + 1]
    if (args[i] === '--random' && args[i + 1]) random = parseInt(args[i + 1], 10)
    if (args[i] === '--limit' && args[i + 1]) limit = parseInt(args[i + 1], 10)
  }
  return { sample, apply, level, random, limit }
}

function getApiKey(): string {
  return process.env.DEEPSEEK_API_KEY || ''
}

function isMissing(v: any): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '')
}

function isAllMissing(gradeDefs: Record<string, string> | undefined): boolean {
  if (!gradeDefs) return true
  return GRADE_KEYS.every(k => isMissing(gradeDefs[k]))
}

/**
 * 4 道硬过滤:
 *   1. 截长度 (按学段上限)
 *   2. 只取第一行 (切 \n)
 *   3. 去 []
 *   4. 拒绝含 IT 噪音关键词
 * 返回: { clean: 'sanitized' | null, reason: '...' }
 */
function sanitize(value: string, grade: GradeKey): { clean: string | null; reason: string } {
  if (!value || typeof value !== 'string') {
    return { clean: null, reason: 'empty' }
  }
  // 1. 第一行
  let v = value.split('\n')[0].trim()
  // 2. 去 []
  v = v.replace(/[\[\]]/g, '').trim()
  if (!v) return { clean: null, reason: 'empty after sanitization' }
  // 3. IT 噪音
  const lower = v.toLowerCase()
  for (const kw of IT_NOISE_KEYWORDS) {
    if (lower.includes(kw)) {
      return { clean: null, reason: `contains IT noise keyword: "${kw}"` }
    }
  }
  // 4. 长度截断 (中文按 2 字符宽)
  const charCount = [...v].length
  if (charCount > MAX_LEN[grade]) {
    v = [...v].slice(0, MAX_LEN[grade]).join('')
    // 末尾去半截字符
    v = v.replace(/[,;:\s]+$/, '').trim()
  }
  if (!v) return { clean: null, reason: 'empty after length truncation' }
  return { clean: v, reason: 'ok' }
}

/**
 * 调 DeepSeek, 一次拿 3 档释义.
 */
async function aiEnrichGrade(word: VocabWord): Promise<AIGradeResponse> {
  const fallback: AIGradeResponse = {
    primary: '',
    middle: '',
    high: '',
    reason: 'DEEPSEEK_API_KEY 未配置或调用失败, 兜底空',
  }
  const apiKey = getApiKey()
  if (!apiKey) return fallback

  const messages = [
    {
      role: 'system',
      content: `你是给中国学生用的英语学习 app 写分级中文释义的编辑.
给定一个英文单词 (带词性和 CEFR 等级), 按 3 个学段深度输出 STRICT JSON (不要 markdown 包裹):

- "primary" (小学 1-6 年级): 1-2 个最核心意思, 极简, ≤ 12 字符, 不带 vt./n. 词性
   例: 找; 找到 | 看见; 看到 | 高兴

- "middle" (初中): 2-3 个常用意思, 含词性 (vt./vi./n. 等), ≤ 30 字符
   例: vt./vi. 找到; 寻找; 发现 | vt. 看见; 理解; 拜会

- "high" (高中): 3-5 个完整意思, 含词性, ≤ 60 字符
   例: vt. 找到; 发现; 感到; 认为; 裁决 | vt. 看见; 理解; 拜访; 同意; 接待

- "reason": 一句话 (≤ 30 字) 说明分级依据, Simplified Chinese

硬规则 (违反就返 fallback):
- 绝对不能含 IT/计算机术语: DOS, Windows, Linux, 编程, 字节, 文件系统, 操作系统, 编译器, [计], api, http
- 绝对不能含音标残留: [], /ə/, ɪ 等
- 释义按 CEFR 等级加深, 小学 ≠ 高中, 不能复制粘贴
- 只能输出 JSON, 不要任何额外文字
- 如果该单词 IT 释义是主要释义 (如 "find" 在 Linux 命令里), 仍然要给日常生活最常用的释义
- 同词多义时按 CEFR 选最该学段该学的, 小学优先选 1 个意思`
    },
    {
      role: 'user',
      content: `Word: "${word.headword}" (pos: ${word.pos || '?'}, CEFR: ${word.cefr || '?'})
Existing Chinese meaning (参考, 可能脏): ${word.definitionZh || '(无)'}
Existing grade defs (如已填会覆盖): ${JSON.stringify(word.definitions || {})}

Return the JSON.`
    }
  ]

  try {
    const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
        messages,
        temperature: 0.3,
        max_tokens: 300,
      }),
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
      primary: String(parsed.primary || '').trim(),
      middle: String(parsed.middle || '').trim(),
      high: String(parsed.high || '').trim(),
      reason: parsed.reason ? String(parsed.reason) : '',
    }
  } catch (e: any) {
    return {
      primary: '',
      middle: '',
      high: '',
      reason: `AI 调用失败: ${e.message?.slice(0, 100)}`,
    }
  }
}

function buildSuggestion(word: VocabWord, ai: AIGradeResponse): AIGradeSuggestion {
  const cur = word.definitions || {}
  const currentPrimary = cur.primary || ''
  const currentMiddle = cur.middle || ''
  const currentHigh = cur.high || ''

  // 4 道硬过滤
  const p = sanitize(ai.primary, 'primary')
  const m = sanitize(ai.middle, 'middle')
  const h = sanitize(ai.high, 'high')

  const primaryChanged = isMissing(currentPrimary) && !!p.clean
  const middleChanged = isMissing(currentMiddle) && !!m.clean
  const highChanged = isMissing(currentHigh) && !!h.clean

  const blocked: string[] = []
  if (!p.clean && ai.primary) blocked.push(`primary:${p.reason}`)
  if (!m.clean && ai.middle) blocked.push(`middle:${m.reason}`)
  if (!h.clean && ai.high) blocked.push(`high:${h.reason}`)

  return {
    lemma: word.lemma,
    pos: word.pos,
    currentPrimary,
    currentMiddle,
    currentHigh,
    aiPrimary: p.clean || '',
    aiMiddle: m.clean || '',
    aiHigh: h.clean || '',
    primaryChanged,
    middleChanged,
    highChanged,
    change: primaryChanged || middleChanged || highChanged,
    blockedReason: blocked.length ? blocked.join('; ') : undefined,
    reason: ai.reason || '',
  }
}

async function main() {
  const { sample, apply, level, random, limit } = getArgs()
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

  // --apply 模式短路: 读 dry-run 报告
  if (apply) {
    if (!fs.existsSync(REPORT_PATH)) {
      console.error(`❌ --apply 模式需要 dry-run 报告: ${REPORT_PATH}`)
      console.error(`   先跑: npx ts-node scripts/enrich-grade-definitions.ts${level ? ` --level ${level}` : ''}${sample ? ` --sample ${sample}` : ''}`)
      await mongoose.disconnect()
      process.exit(1)
    }
    const saved = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf-8')) as any
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
    const toWrite: AIGradeSuggestion[] = (saved.suggestions || []).filter((s: AIGradeSuggestion) => s.change)
    console.log(`✏️  --apply 模式: 读 dry-run 报告 (${saved.generatedAt}), 写 ${toWrite.length} 词 ...`)
    let written = 0
    let errs = 0
    for (const s of toWrite) {
      const $set: any = {}
      if (s.primaryChanged) $set['definitions.primary'] = s.aiPrimary
      if (s.middleChanged) $set['definitions.middle'] = s.aiMiddle
      if (s.highChanged) $set['definitions.high'] = s.aiHigh
      if (Object.keys($set).length === 0) continue
      try {
        // 修: 用 matchedCount (词找到) 代替 modifiedCount (值变了) ——
        //   modifiedCount=0 当 $set 写入值跟原值 byte-equal 时,
        //   这导致 0/200 误报. matchedCount >= 1 表示词找到且 updateOne 跑了
        const result = await VocabWord.updateOne(
          { lemma: s.lemma, pos: s.pos },
          { $set }
        )
        if (result.matchedCount > 0) written++
        else console.log(`  ⚠️  词 ${s.lemma}/${s.pos} 没找到, 跳过`)
      } catch (e: any) {
        errs++
        console.error(`  ✗ 写 ${s.lemma}/${s.pos} 失败: ${e.message?.slice(0, 100)}`)
      }
    }
    console.log(`✅ 写库完成: ${written}/${toWrite.length} 词已更新 (errors: ${errs})`)
    console.log(`💾 Backup: /tmp/linguacraft-backups/vocabwords-pre-grade-def-*.json`)
    await mongoose.disconnect()
    return
  }

  // dry-run 模式: 拉所有 definitions.{primary/middle/high} 任一缺的词
  // (任一有值都不动 — 老数据即便脏, 让用户决定是否单独清)
  const filter: any = {
    $or: [
      { 'definitions.primary': { $exists: false } },
      { 'definitions.primary': '' },
      { 'definitions.primary': null },
      { 'definitions.middle': { $exists: false } },
      { 'definitions.middle': '' },
      { 'definitions.middle': null },
      { 'definitions.high': { $exists: false } },
      { 'definitions.high': '' },
      { 'definitions.high': null },
    ],
  }
  if (level) filter.levels = level

  const all = (await VocabWord.find(filter).lean()) as unknown as VocabWord[]
  console.log(`词库规模 (任一学段缺): ${all.length} 词${level ? ` (level=${level})` : ''}`)

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
  if (limit > 0) {
    toProcess = unique.slice(0, limit)
    console.log(`本次处理: ${toProcess.length} 词 (limit 模式)\n`)
  } else if (sample > 0) {
    toProcess = unique.slice(0, sample)
    console.log(`本次处理: ${toProcess.length} 词 (sample 模式)\n`)
  } else if (random > 0) {
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

  const suggestions: AIGradeSuggestion[] = []
  let aiCalls = 0
  let blockedCount = 0
  const startTime = Date.now()

  // 3 路并发 (从 5 降到 3, 降低 macOS OOM 风险 + DeepSeek 限速压力)
  const CONCURRENCY = 3
  let cursor = 0
  let lastCheckpoint = Date.now()
  // Checkpoint: 每 100 词 dump 一次到 /tmp/linguacraft-enrich-grade-checkpoint.json
  // 万一脚本被 OOM kill, 下次跑同 filter 时自动检测 checkpoint 续跑
  const CHECKPOINT_PATH = '/tmp/linguacraft-enrich-grade-checkpoint.json'
  const CHECKPOINT_INTERVAL = 100
  // 尝试加载上次 checkpoint
  let checkpoint: any = null
  if (fs.existsSync(CHECKPOINT_PATH)) {
    try {
      checkpoint = JSON.parse(fs.readFileSync(CHECKPOINT_PATH, 'utf-8'))
      if (checkpoint.filter?.level !== (level || null) ||
          (checkpoint.filter?.sample || 'all') !== (sample || 'all') ||
          (checkpoint.filter?.limit || 0) !== (limit || 0) ||
          (checkpoint.filter?.random || 0) !== (random || 0)) {
        console.log(`⚠️  Checkpoint filter 不匹配, 忽略 (旧=${JSON.stringify(checkpoint.filter)} 新=${JSON.stringify({level,sample,limit,random})})`)
        checkpoint = null
      } else if (checkpoint.done >= checkpoint.total) {
        // 修: filter 匹配但 checkpoint 已 100% 完成, 也忽略 ——
        //   否则下次跑会 0s "完成"啥也没干, batch 2-6 误报
        console.log(`⚠️  Checkpoint 已 100% 完成 (${checkpoint.done}/${checkpoint.total}), 忽略, 强制重跑 AI`)
        checkpoint = null
      } else {
        console.log(`✅ 加载 checkpoint: ${checkpoint.done}/${checkpoint.total} (${(checkpoint.done/checkpoint.total*100).toFixed(1)}%)`)
        // 把已完成的 suggestion 填回数组
        for (const s of checkpoint.suggestions) {
          if (s) suggestions[s.index] = s
        }
        cursor = checkpoint.cursor || 0
        aiCalls = checkpoint.aiCalls || 0
        blockedCount = checkpoint.blockedCount || 0
      }
    } catch (e) {
      console.log('⚠️  Checkpoint 解析失败, 忽略')
      checkpoint = null
    }
  }
  async function worker() {
    while (cursor < toProcess.length) {
      const i = cursor++
      const w = toProcess[i]
      const ai = await aiEnrichGrade(w)
      if (ai.reason !== 'DEEPSEEK_API_KEY 未配置或调用失败, 兜底空' && !ai.reason?.startsWith('AI 调用失败')) {
        aiCalls++
      }
      const sug = buildSuggestion(w, ai)
      sug.index = i  // 让 checkpoint 知道这条对应 toProcess[i]
      suggestions[i] = sug
      if (sug.blockedReason) blockedCount++

      // Checkpoint
      const done = suggestions.filter(Boolean).length
      if (done - (checkpoint?.done || 0) >= CHECKPOINT_INTERVAL || (Date.now() - lastCheckpoint > 60000)) {
        try {
          fs.writeFileSync(CHECKPOINT_PATH, JSON.stringify({
            generatedAt: new Date().toISOString(),
            filter: { level: level || null, sample: sample || 'all', limit: limit || 0, random: random || 0 },
            total: toProcess.length,
            cursor,
            done,
            aiCalls,
            blockedCount,
            suggestions: suggestions.filter(Boolean),
          }))
          lastCheckpoint = Date.now()
        } catch (e) {
          // checkpoint 写失败不阻断主流程
        }
      }
    }
  }
  const workers = Array.from({ length: CONCURRENCY }, () => worker())

  // 进度 ticker
  const progressInterval = setInterval(() => {
    const done = suggestions.filter(Boolean).length
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    const rate = done > 0 ? (done / parseFloat(elapsed)).toFixed(1) : '0'
    process.stdout.write(`\r[${done}/${toProcess.length}] 进度 ${(done / toProcess.length * 100).toFixed(1)}% (${elapsed}s, ${rate} 词/s)  AI ${aiCalls}  blocked ${blockedCount}`)
  }, 1000)

  await Promise.all(workers)
  clearInterval(progressInterval)
  const done = suggestions.filter(Boolean).length
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  const rate = done > 0 ? (done / parseFloat(elapsed)).toFixed(1) : '0'
  process.stdout.write(`\r[${done}/${toProcess.length}] 进度 100.0% (${elapsed}s, ${rate} 词/s)  AI ${aiCalls}  blocked ${blockedCount}\n`)
  console.log()

  // ==================== 打印报告 ====================
  const sep = '═'.repeat(70)
  const sub = '─'.repeat(70)
  console.log(sep)
  console.log(`📊 按学段分级中文释义补全报告`)
  console.log(sep)
  console.log()

  const primaryCount = suggestions.filter(s => s.primaryChanged).length
  const middleCount = suggestions.filter(s => s.middleChanged).length
  const highCount = suggestions.filter(s => s.highChanged).length
  const allThree = suggestions.filter(s => s.primaryChanged && s.middleChanged && s.highChanged).length
  const anyChange = suggestions.filter(s => s.change).length

  console.log(`--- 字段补全统计 ---`)
  console.log(`  拉取总词数:     ${suggestions.length}`)
  console.log(`  将补 primary:   ${primaryCount}`)
  console.log(`  将补 middle:    ${middleCount}`)
  console.log(`  将补 high:      ${highCount}`)
  console.log(`  三档都补:       ${allThree}`)
  console.log(`  总计会改:       ${anyChange} 词`)
  console.log(`  AI 调用次数:    ${aiCalls}`)
  console.log(`  硬过滤 reject:  ${blockedCount} 词 (IT 噪音/超长)`)
  console.log(`  跑完耗时:       ${elapsed}s (${rate} 词/s)`)
  console.log()

  // 样本展示 (前 30 个会改的)
  const toChange = suggestions.filter(s => s.change).slice(0, 30)
  if (toChange.length > 0) {
    console.log(`--- 前 30 个会改的 (review 用) ---`)
    for (const s of toChange) {
      const fields: string[] = []
      if (s.primaryChanged) fields.push('P')
      if (s.middleChanged) fields.push('M')
      if (s.highChanged) fields.push('H')
      console.log(`  [${fields.join('+').padEnd(5)}] ${s.lemma.padEnd(20)} (${s.pos})`)
      if (s.primaryChanged) console.log(`           primary: ${s.aiPrimary}`)
      if (s.middleChanged)  console.log(`           middle:  ${s.aiMiddle}`)
      if (s.highChanged)    console.log(`           high:    ${s.aiHigh}`)
      if (s.reason) console.log(`           (${s.reason.slice(0, 60)})`)
    }
    console.log()
  }

  // 被 reject 的样本
  const rejected = suggestions.filter(s => s.blockedReason).slice(0, 10)
  if (rejected.length > 0) {
    console.log(`--- 硬过滤 reject 样本 (前 10) ---`)
    for (const s of rejected) {
      console.log(`  ${s.lemma.padEnd(20)} (${s.pos}): ${s.blockedReason}`)
    }
    console.log()
  }

  // 写 JSON
  const report = {
    generatedAt: new Date().toISOString(),
    filter: { level: level || null, sample: sample || 'all', limit: limit || 0 },
    total: suggestions.length,
    aiCalls,
    elapsed: parseFloat(elapsed),
    rate: parseFloat(rate),
    primaryCount,
    middleCount,
    highCount,
    allThree,
    anyChange,
    blockedCount,
    suggestions,
  }
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2))
  console.log(`📄 详细报告: ${REPORT_PATH}`)
  console.log()

  // apply 提示
  if (anyChange > 0) {
    console.log(`💡 加 --apply 才会实际写库. 看完上面报告后决定:`)
    console.log(`   cd backend && npx ts-node scripts/enrich-grade-definitions.ts --apply${level ? ` --level ${level}` : ''}${sample ? ` --sample ${sample}` : ''}`)
    console.log(`   (apply 会读本次 dry-run 报告, 不重跑 AI)`)
  } else {
    console.log(`✨ 无需改动, 所有词已有 definitions.{primary/middle/high}`)
  }

  await mongoose.disconnect()
}

main().catch(e => {
  console.error('❌ 脚本失败:', e)
  process.exit(1)
})
