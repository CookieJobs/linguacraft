// input: mongoose, dotenv, node-fetch
// output: 补全 vocabwords.freqRank 字段 (词频排名)
// pos: 系统/通用
// 若我被更新,请同步更新我的开头注释,以及所属的文件夹的 README。
//
// 为 vocabwords 批量补全 freqRank 字段:
//   - 数据源: Google Web Trillion Word Corpus Top 20000 (first20hours/google-10000-english repo, 20k.txt)
//   - 公开、CC 协议、业界常用 baseline (我们对比过 COCA, 20k 公共版本没有 COCA 那么纯,
//     但能匹配 84% 日常词, 投入产出比优于为多 5% 匹配率再拼 1-2 个源)
//   - 匹配策略: lemma (小写) 查表, 命中写 freqRank = rank (1=最常用)
//   - 不会动 lemma/headword, 只写 freqRank
//   - 不会覆盖已有 freqRank (>0), 只填空
//
// 跑法:
//   npx ts-node scripts/enrich-freqrank.ts                  # dry-run, 输出 /tmp/linguacraft-enrich-freqrank.json
//   npx ts-node scripts/enrich-freqrank.ts --apply           # 读 JSON 写库 (短路, 不会重新匹配)
//
// 前置: 已配 MONGO_URL 在 .env (默认 mongodb://localhost:27017/linguacraft)
// 缓存: /tmp/coca-freq.json (google-20k 拉过的会持久化, 重复跑不会重复下载)
// 输出: /tmp/linguacraft-enrich-freqrank.json (apply 模式下也会被回读)

import * as mongoose from 'mongoose'
import * as dotenv from 'dotenv'
import * as fs from 'fs'
import * as path from 'path'
import fetch from 'node-fetch'

dotenv.config({ path: path.resolve(__dirname, '../.env') })

const CACHE_FILE = '/tmp/coca-freq.json'
const OUTPUT_FILE = '/tmp/linguacraft-enrich-freqrank.json'
const SOURCE_URL = 'https://raw.githubusercontent.com/first20hours/google-10000-english/master/20k.txt'
const MONGO_URL = process.env.MONGO_URL || 'mongodb://localhost:27017/linguacraft'
const APPLY = process.argv.includes('--apply')

interface VocabWord {
  _id: any
  headword: string
  lemma: string
  freqRank?: number
}

interface Match {
  _id: string
  headword: string
  lemma: string
  freqRank: number
}

async function loadFreqMap(): Promise<Map<string, number>> {
  // 优先用本地缓存
  if (fs.existsSync(CACHE_FILE)) {
    const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8')) as Record<string, number>
    console.log(`loaded ${Object.keys(data).length} freq entries from cache ${CACHE_FILE}`)
    return new Map(Object.entries(data))
  }
  console.log(`fetching ${SOURCE_URL} ...`)
  const res = await fetch(SOURCE_URL)
  if (!res.ok) throw new Error(`fetch failed: ${res.status}`)
  const text = await res.text()
  const lines = text.split('\n').map(s => s.trim().toLowerCase()).filter(Boolean)
  const map = new Map<string, number>()
  lines.forEach((w, i) => { if (!map.has(w)) map.set(w, i + 1) }) // 1-based rank
  // 写缓存
  fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(map)))
  console.log(`fetched ${lines.length} entries, cached to ${CACHE_FILE}`)
  return map
}

function isMissing(rank: any): boolean {
  return rank == null || rank === 0
}

async function main() {
  console.log('=== linguacraft freqRank 补全 ===')
  console.log(`mode: ${APPLY ? 'APPLY (写库)' : 'DRY-RUN (只生成 JSON)'}`)
  console.log(`MONGO_URL = ${MONGO_URL}`)
  console.log('')

  const freq = await loadFreqMap()
  console.log(`freqMap size: ${freq.size}`)

  await mongoose.connect(MONGO_URL)
  const VocabWord = mongoose.model('VocabWord', new mongoose.Schema({}, { strict: false }))

  if (!APPLY) {
    // ===== DRY-RUN =====
    const t0 = Date.now()
    const all = await VocabWord.find({}, { headword: 1, lemma: 1, freqRank: 1 }).lean() as unknown as VocabWord[]
    console.log(`loaded ${all.length} vocab words in ${Date.now() - t0}ms`)

    const matches: Match[] = []
    const unmatched: { _id: string; headword: string; lemma: string }[] = []
    let needFill = 0
    let alreadyHas = 0

    for (const w of all) {
      if (!isMissing(w.freqRank)) { alreadyHas++; continue }
      needFill++
      const key = String(w.lemma || w.headword || '').toLowerCase().trim()
      const rank = freq.get(key)
      if (rank) {
        matches.push({ _id: String(w._id), headword: w.headword, lemma: w.lemma, freqRank: rank })
      } else {
        unmatched.push({ _id: String(w._id), headword: w.headword, lemma: w.lemma })
      }
    }

    fs.writeFileSync(OUTPUT_FILE, JSON.stringify({ matches, unmatched, summary: { total: all.length, alreadyHas, needFill, matched: matches.length, unmatched: unmatched.length, matchRate: matches.length / Math.max(1, needFill) } }, null, 2))

    const elapsed = ((Date.now() - t0) / 1000).toFixed(2)
    console.log('')
    console.log('--- dry-run summary ---')
    console.log(`total vocab words:        ${all.length}`)
    console.log(`already has freqRank (>0): ${alreadyHas}`)
    console.log(`need fill (null/0):       ${needFill}`)
    console.log(`matched:                  ${matches.length} (${(matches.length / needFill * 100).toFixed(1)}%)`)
    console.log(`unmatched:                ${unmatched.length} (${(unmatched.length / needFill * 100).toFixed(1)}%)`)
    console.log(`elapsed:                  ${elapsed}s`)
    console.log('')
    console.log(`output: ${OUTPUT_FILE}`)
    console.log(`unmatched 样例 (前 20):`)
    unmatched.slice(0, 20).forEach(u => console.log(`  ${u.headword} | ${u.lemma}`))
    console.log('')
    console.log('看完结果后,跑:')
    console.log('  npx ts-node scripts/enrich-freqrank.ts --apply')
    console.log('')
    console.log('数据 backup:')
    console.log('  /tmp/linguacraft-backups/vocabwords-pre-freqrank-*.json')
  } else {
    // ===== APPLY =====
    if (!fs.existsSync(OUTPUT_FILE)) {
      console.error(`找不到 ${OUTPUT_FILE}, 请先跑一次 dry-run 生成`)
      process.exit(1)
    }
    const data = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf-8')) as { matches: Match[]; summary: any }
    console.log(`loading ${data.matches.length} matches from ${OUTPUT_FILE}`)
    console.log(`summary: ${JSON.stringify(data.summary)}`)
    console.log('')

    const t0 = Date.now()
    const ops = data.matches.map(m => ({
      updateOne: {
        filter: { _id: new mongoose.Types.ObjectId(m._id) },
        update: { $set: { freqRank: m.freqRank } }
      }
    }))
    console.log(`prepared ${ops.length} bulkWrite ops`)

    // 拆 batch, 一次 500 防 OOM
    const BATCH = 500
    let totalModified = 0
    for (let i = 0; i < ops.length; i += BATCH) {
      const batch = ops.slice(i, i + BATCH)
      const res = await VocabWord.bulkWrite(batch, { ordered: false })
      totalModified += res.modifiedCount || 0
      console.log(`  [${i + batch.length}/${ops.length}] batch done, modified=${res.modifiedCount}`)
    }

    const elapsed = ((Date.now() - t0) / 1000).toFixed(2)
    console.log('')
    console.log('--- apply summary ---')
    console.log(`updated ${totalModified} of ${data.matches.length} words`)
    console.log(`elapsed: ${elapsed}s`)
    console.log('')
    console.log('验证:')
    console.log('  npx ts-node scripts/audit-vocab.ts')
  }

  await mongoose.disconnect()
}

main().catch(e => {
  console.error(e)
  process.exit(1)
})
