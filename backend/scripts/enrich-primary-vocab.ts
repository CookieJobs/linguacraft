// input: mongoose, node-fetch, dotenv
// output: 补全小学 (Primary) 词的缺失字段
// pos: 系统/通用
// 若我被更新,请同步更新我的开头注释,以及所属的文件夹的 README。
//
// 为 Primary 学段(小学)词批量补全:
//   - 缺失的英文释义 (definitionEn)
//   - 缺失的例句 (exampleEn, 简单 A1 级别)
//   - 缺失的 CEFR 标签 (cefr 字段是 UNKNOWN 时)
//   - 缺失的 IPA 音标
//
// 用 DeepSeek 批量请求,带本地缓存避免重复调 API
// 跑法: DEEPSEEK_API_KEY=xxx npx ts-node scripts/enrich-primary-vocab.ts [limit=200]
//   limit 默认 200 (一次最多补 200 词,避免一次花太多 API 钱)
//
// 前置: 已配 DEEPSEEK_API_KEY 在 .env

import * as mongoose from 'mongoose'
import * as dotenv from 'dotenv'
import * as fs from 'fs'
import * as path from 'path'
import fetch from 'node-fetch'

dotenv.config({ path: path.resolve(__dirname, '../.env') })

const CACHE_FILE = path.resolve(__dirname, '../../data/processed/enrich_primary_cache.json')

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY
const DEEPSEEK_MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-chat'
const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017/linguacraft'
const LIMIT = parseInt(process.argv[2] || '200', 10)

interface VocabWord {
  _id: any
  headword: string
  lemma: string
  cefr: string
  definitionEn: string
  definitionZh: string
  exampleEn: string
  ipa?: string
  levels: string[]
}

function isMissing(s: any): boolean {
  return !s || (typeof s === 'string' && s.trim() === '')
}

async function callDeepSeek(messages: any[]): Promise<string | null> {
  if (!DEEPSEEK_API_KEY) {
    console.error('DEEPSEEK_API_KEY not set in .env')
    return null
  }
  const res = await fetch('https://api.deepseek.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`
    },
    body: JSON.stringify({
      model: DEEPSEEK_MODEL,
      messages,
      temperature: 0.4,
      max_tokens: 200
    })
  })
  if (!res.ok) {
    console.error(`DeepSeek error: ${res.status}`)
    return null
  }
  const data = (await res.json()) as any
  return data?.choices?.[0]?.message?.content?.trim() || null
}

async function enrichOne(word: VocabWord): Promise<Partial<VocabWord>> {
  // 让 DeepSeek 输出结构化 JSON
  const messages = [
    {
      role: 'system',
      content: `You are an English vocabulary assistant for Chinese primary school students.
Given a word, output STRICT JSON with these fields:
- "definitionEn" (string, simple English definition, A1 level)
- "exampleEn" (string, ONE simple A1-level example sentence using the word)
- "cefr" (string, CEFR level: A1/A2/B1)
- "ipa" (string, IPA pronunciation in /.../ form)

Output ONLY valid JSON. No markdown blocks, no extra text.`
    },
    {
      role: 'user',
      content: `Word: "${word.headword}"
Chinese definition: "${word.definitionZh || '(unknown)'}"
Existing English definition: "${word.definitionEn || '(empty)'}"
Existing example: "${word.exampleEn || '(empty)'}"
Existing IPA: "${word.ipa || '(empty)'}"
Existing CEFR: "${word.cefr || 'UNKNOWN'}"

Fill in any missing or empty fields. If a field is already valid, keep it.`
    }
  ]
  const raw = await callDeepSeek(messages)
  if (!raw) return {}
  try {
    // 清理可能包裹的 ```json ... ```
    let clean = raw.replace(/```json\s*|\s*```/g, '').trim()
    // 修复裸 IPA: /bluː/ 这种以 / 开头结尾的如果没加引号,JSON.parse 会挂
    // 简单策略: 找到形如 /.../ 的裸 token,加引号
    clean = clean.replace(/(?<![\[\{\"\w])\/([^\/\n]{1,40})\/(?![\]\}\"\w])/g, '"/$1/"')
    const parsed = JSON.parse(clean)
    return parsed
  } catch (e) {
    console.error(`  parse failed for ${word.headword}: ${(e as Error).message}`)
    return {}
  }
}

async function main() {
  console.log('=== linguacraft 小学词补全 (Primary) ===')
  console.log(`DEEPSEEK_MODEL = ${DEEPSEEK_MODEL}`)
  console.log(`limit = ${LIMIT}`)
  if (!DEEPSEEK_API_KEY) {
    console.error('请先在 .env 配 DEEPSEEK_API_KEY')
    process.exit(1)
  }

  // 加载缓存
  let cache: Record<string, Partial<VocabWord>> = {}
  if (fs.existsSync(CACHE_FILE)) {
    cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'))
    console.log(`loaded ${Object.keys(cache).length} cached enrichments`)
  }

  await mongoose.connect(MONGO_URL)
  const VocabWord = mongoose.model('VocabWord', new mongoose.Schema({}, { strict: false }))

  // 找出 Primary 词中"有缺失字段"的,按缺失严重度排序
  const all = await VocabWord.find({ levels: 'Primary' }).lean() as unknown as VocabWord[]
  const needsEnrich = all.filter(w => {
    return isMissing(w.definitionEn) || isMissing(w.exampleEn) || isMissing(w.ipa) || !w.cefr || w.cefr === 'UNKNOWN'
  })
  // 按缺失字段数排序(优先补缺得多的)
  needsEnrich.sort((a, b) => {
    const aMiss = (isMissing(a.definitionEn) ? 1 : 0) + (isMissing(a.exampleEn) ? 1 : 0) + (isMissing(a.ipa) ? 1 : 0) + (!a.cefr || a.cefr === 'UNKNOWN' ? 1 : 0)
    const bMiss = (isMissing(b.definitionEn) ? 1 : 0) + (isMissing(b.exampleEn) ? 1 : 0) + (isMissing(b.ipa) ? 1 : 0) + (!b.cefr || b.cefr === 'UNKNOWN' ? 1 : 0)
    return bMiss - aMiss
  })

  console.log(`primary 词总数: ${all.length}`)
  console.log(`需要补全: ${needsEnrich.length}`)
  console.log(`本次处理: ${Math.min(LIMIT, needsEnrich.length)}`)

  const toProcess = needsEnrich.slice(0, LIMIT)
  let updated = 0
  let apiCalls = 0
  let cached = 0

  for (let i = 0; i < toProcess.length; i++) {
    const w = toProcess[i]
    const cacheKey = `${w.lemma}`

    let enriched: Partial<VocabWord>
    if (cache[cacheKey]) {
      enriched = cache[cacheKey]
      cached++
    } else {
      // 限流:每 10 个 sleep 1s
      if (apiCalls > 0 && apiCalls % 10 === 0) {
        await new Promise(r => setTimeout(r, 1000))
      }
      enriched = await enrichOne(w)
      apiCalls++
      cache[cacheKey] = enriched
    }

    if (Object.keys(enriched).length === 0) continue

    // 只更新有变化的字段
    const $set: any = {}
    if (isMissing(w.definitionEn) && enriched.definitionEn) $set.definitionEn = enriched.definitionEn
    if (isMissing(w.exampleEn) && enriched.exampleEn) $set.exampleEn = enriched.exampleEn
    if (isMissing(w.ipa) && enriched.ipa) $set.ipa = enriched.ipa
    if ((!w.cefr || w.cefr === 'UNKNOWN') && enriched.cefr) $set.cefr = enriched.cefr

    if (Object.keys($set).length > 0) {
      await VocabWord.updateOne({ _id: w._id }, { $set })
      updated++
    }

    if ((i + 1) % 20 === 0) {
      console.log(`  [${i + 1}/${toProcess.length}] ${w.headword} → ${Object.keys($set).join(', ') || '(no change)'}`)
    }

    // 每 50 词保存一次缓存
    if ((i + 1) % 50 === 0) {
      fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2))
    }
  }

  // 最后保存缓存
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2))

  console.log('---')
  console.log(`Done. updated ${updated} of ${toProcess.length}`)
  console.log(`  API calls: ${apiCalls}, cache hits: ${cached}`)
  console.log(`  cache saved to ${CACHE_FILE}`)
  console.log('')
  console.log('重跑 audit-vocab.ts 看效果:')
  console.log('  npx ts-node scripts/audit-vocab.ts')

  await mongoose.disconnect()
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
