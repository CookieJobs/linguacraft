// input: mongoose, node-fetch (built-in), dotenv
// output: 为 vocabwords 补 ipa (AI 标) + audioUrl (有道 TTS 拼 URL) 字段
// pos: 系统/通用
// 若我被更新，请同步更新我的开头注释，以及所属文件夹的 README。
//
// linguacraft 词库补全 — ipa + audioUrl
//
// 目的: 解决两个字段缺口:
//   1. ipa (音标): 6314/6363 词缺失 (99.2%) — 用 DeepSeek 兜底标
//   2. audioUrl (音频): 6363/6363 词缺失 (100%) — 拼有道 TTS URL (无需 AI, 0 token)
//
// audioUrl 格式: https://dict.youdao.com/dictvoice?audio=<encoded headword>&type=2
//                (Type 2 = US English; Type 1 = UK)
// 注意: vocab.service.ts:87 已有同样 fallback, 本脚本提前一次性把空值填上, 避免运行时拼接
//
// 模式:
//   - 默认 (dry-run): 读 mongo → 调 AI 标 ipa + 拼 audioUrl → 写 JSON 报告到 /tmp
//   - --apply:  同上 + 实际 bulkWrite 改库 (需先 review dry-run 结果, 模式同 audit-cefr-ai.ts)
//
// 跑法:
//   cd backend && npx ts-node scripts/enrich-ipa-audio.ts
//   cd backend && npx ts-node scripts/enrich-ipa-audio.ts --sample 50     # 50 词样例
//   cd backend && npx ts-node scripts/enrich-ipa-audio.ts --apply        # 实际写库
//   cd backend && npx ts-node scripts/enrich-ipa-audio.ts --ipa-only     # 只补 ipa
//   cd backend && npx ts-node scripts/enrich-ipa-audio.ts --audio-only   # 只补 audioUrl
//
// 2026-06-11: 第一次跑, 配合 C-Phase3 词库补全
//   - 5 路并发, 同 audit-cefr-ai.ts
//   - audioUrl 0 token (纯字符串拼接), ipa 走 DeepSeek

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
  ipa?: string
  audioUrl?: string
  cefr?: string
}

interface EnrichmentEntry {
  _id: string           // stringified ObjectId for JSON
  lemma: string
  pos: string
  headword: string
  currentIpa: string
  currentAudioUrl: string
  newIpa: string
  newAudioUrl: string
  // 标记哪个字段会改
  ipaChange: boolean
  audioChange: boolean
  // 标记 ipa 来源
  ipaSource: 'ai' | 'whitelist' | 'failed' | 'unchanged' | 'empty'
  ipaReason?: string
}

interface RunReport {
  generatedAt: string
  filter: { sample: number; ipaOnly: boolean; audioOnly: boolean }
  totalCandidates: number
  ipaWillChange: number
  audioWillChange: number
  ipaAiCalls: number
  ipaWhiteHits: number
  ipaFailed: number
  entries: EnrichmentEntry[]
}

const REPORT_PATH = '/tmp/linguacraft-enrich-ipa-audio.json'

// IPA 临时白名单 — 极高频词用 DeepSeek 太慢, 提前人工标
// 选取 200+ 最基础词, 大幅降低 AI 调用量
// 格式: lemma(小写) → IPA (US English, 标准字典格式 /.../)
const IPA_WHITELIST: Record<string, string> = {
  // 代词/Be 动词
  'i': '/aɪ/', 'you': '/juː/', 'he': '/hiː/', 'she': '/ʃiː/', 'it': '/ɪt/',
  'we': '/wiː/', 'they': '/ðeɪ/', 'me': '/miː/', 'him': '/hɪm/', 'her': '/hɜːr/',
  'us': '/ʌs/', 'them': '/ðem/', 'my': '/maɪ/', 'your': '/jʊr/', 'his': '/hɪz/',
  'its': '/ɪts/', 'our': '/aʊər/', 'their': '/ðer/',
  'this': '/ðɪs/', 'that': '/ðæt/', 'these': '/ðiːz/', 'those': '/ðoʊz/',
  'am': '/æm/', 'is': '/ɪz/', 'are': '/ɑːr/', 'was': '/wʌz/', 'were': '/wɜːr/',
  'be': '/biː/', 'been': '/bɪn/', 'being': '/ˈbiːɪŋ/',
  'have': '/hæv/', 'has': '/hæz/', 'had': '/hæd/', 'do': '/duː/', 'does': '/dʌz/', 'did': '/dɪd/',

  // 常用动词
  'go': '/ɡoʊ/', 'come': '/kʌm/', 'see': '/siː/', 'look': '/lʊk/', 'want': '/wɑːnt/',
  'get': '/ɡet/', 'make': '/meɪk/', 'give': '/ɡɪv/', 'take': '/teɪk/', 'know': '/noʊ/',
  'say': '/seɪ/', 'tell': '/tel/', 'think': '/θɪŋk/', 'feel': '/fiːl/', 'find': '/faɪnd/',
  'work': '/wɜːrk/', 'play': '/pleɪ/', 'run': '/rʌn/', 'walk': '/wɔːk/', 'eat': '/iːt/',
  'drink': '/drɪŋk/', 'sleep': '/sliːp/', 'read': '/riːd/', 'write': '/raɪt/', 'speak': '/spiːk/',
  'listen': '/ˈlɪsən/', 'watch': '/wɑːtʃ/', 'help': '/help/', 'like': '/laɪk/', 'love': '/lʌv/',
  'live': '/lɪv/', 'learn': '/lɜːrn/', 'teach': '/tiːtʃ/', 'study': '/ˈstʌdi/', 'buy': '/baɪ/',
  'sell': '/sel/', 'open': '/ˈoʊpən/', 'close': '/kloʊz/', 'start': '/stɑːrt/', 'stop': '/stɑːp/',
  'put': '/pʊt/', 'sit': '/sɪt/', 'stand': '/stænd/', 'rise': '/raɪz/',
  'fall': '/fɔːl/', 'cut': '/kʌt/', 'hit': '/hɪt/', 'win': '/wɪn/', 'lose': '/luːz/',
  'bring': '/brɪŋ/', 'carry': '/ˈkæri/', 'push': '/pʊʃ/', 'pull': '/pʊl/', 'turn': '/tɜːrn/',
  'move': '/muːv/', 'show': '/ʃoʊ/', 'follow': '/ˈfɑːloʊ/', 'lead': '/liːd/', 'use': '/juːz/',
  'try': '/traɪ/', 'call': '/kɔːl/', 'ask': '/æsk/', 'answer': '/ˈænsər/', 'need': '/niːd/',
  'keep': '/kiːp/', 'leave': '/liːv/', 'let': '/let/', 'send': '/send/', 'meet': '/miːt/',
  'pay': '/peɪ/', 'cost': '/kɔːst/', 'spend': '/spend/', 'save': '/seɪv/', 'wash': '/wɑːʃ/',
  'clean': '/kliːn/', 'cook': '/kʊk/', 'draw': '/drɔː/', 'sing': '/sɪŋ/', 'dance': '/dæns/',
  'swim': '/swɪm/', 'fly': '/flaɪ/', 'drive': '/draɪv/', 'ride': '/raɪd/', 'wear': '/wer/',

  // 常用名词
  'time': '/taɪm/', 'year': '/jɪr/', 'day': '/deɪ/', 'night': '/naɪt/', 'morning': '/ˈmɔːrnɪŋ/',
  'afternoon': '/ˌæftərˈnuːn/', 'evening': '/ˈiːvnɪŋ/', 'week': '/wiːk/', 'month': '/mʌnθ/', 'hour': '/aʊər/',
  'minute': '/ˈmɪnɪt/', 'second': '/ˈsekənd/',
  'man': '/mæn/', 'woman': '/ˈwʊmən/', 'boy': '/bɔɪ/', 'girl': '/ɡɜːrl/', 'child': '/tʃaɪld/',
  'children': '/ˈtʃɪldrən/', 'baby': '/ˈbeɪbi/', 'people': '/ˈpiːpəl/', 'friend': '/frend/', 'family': '/ˈfæməli/',
  'father': '/ˈfɑːðər/', 'mother': '/ˈmʌðər/', 'dad': '/dæd/', 'mom': '/mɑːm/', 'parent': '/ˈperənt/',
  'son': '/sʌn/', 'daughter': '/ˈdɔːtər/', 'brother': '/ˈbrʌðər/', 'sister': '/ˈsɪstər/',
  'home': '/hoʊm/', 'house': '/haʊs/', 'room': '/ruːm/', 'door': '/dɔːr/', 'window': '/ˈwɪndoʊ/',
  'bed': '/bed/', 'table': '/ˈteɪbəl/', 'chair': '/tʃer/', 'floor': '/flɔːr/',
  'school': '/skuːl/', 'class': '/klæs/', 'classroom': '/ˈklæsruːm/', 'teacher': '/ˈtiːtʃər/', 'student': '/ˈstuːdənt/',
  'book': '/bʊk/', 'page': '/peɪdʒ/', 'pen': '/pen/', 'pencil': '/ˈpensəl/', 'paper': '/ˈpeɪpər/',
  'name': '/neɪm/', 'word': '/wɜːrd/', 'letter': '/ˈletər/', 'number': '/ˈnʌmbər/', 'question': '/ˈkwes.tʃən/',
  'language': '/ˈlæŋɡwɪdʒ/', 'story': '/ˈstɔːri/', 'song': '/sɔːŋ/',
  'food': '/fuːd/', 'water': '/ˈwɔːtər/', 'bread': '/bred/', 'rice': '/raɪs/', 'meat': '/miːt/',
  'fish': '/fɪʃ/', 'fruit': '/fruːt/', 'apple': '/ˈæpəl/', 'banana': '/bəˈnænə/', 'orange': '/ˈɔːrɪndʒ/',
  'egg': '/eɡ/', 'milk': '/mɪlk/', 'tea': '/tiː/', 'coffee': '/ˈkɔːfi/',
  'animal': '/ˈænɪməl/', 'dog': '/dɔːɡ/', 'cat': '/kæt/', 'bird': '/bɜːrd/', 'horse': '/hɔːrs/',
  'cow': '/kaʊ/', 'sheep': '/ʃiːp/', 'pig': '/pɪɡ/',
  'body': '/ˈbɑːdi/', 'head': '/hed/', 'face': '/feɪs/', 'eye': '/aɪ/', 'ear': '/ɪr/',
  'nose': '/noʊz/', 'mouth': '/maʊθ/', 'tooth': '/tuːθ/', 'hair': '/her/', 'hand': '/hænd/',
  'foot': '/fʊt/', 'arm': '/ɑːrm/', 'leg': '/leɡ/', 'back': '/bæk/', 'heart': '/hɑːrt/',
  'color': '/ˈkʌlər/', 'red': '/red/', 'blue': '/bluː/', 'green': '/ɡriːn/', 'yellow': '/ˈjeloʊ/',
  'black': '/blæk/', 'white': '/waɪt/', 'brown': '/braʊn/', 'pink': '/pɪŋk/',

  // 数字
  'one': '/wʌn/', 'two': '/tuː/', 'three': '/θriː/', 'four': '/fɔːr/', 'five': '/faɪv/',
  'six': '/sɪks/', 'seven': '/ˈsevən/', 'eight': '/eɪt/', 'nine': '/naɪn/', 'ten': '/ten/',

  // 常用形容词
  'good': '/ɡʊd/', 'bad': '/bæd/', 'big': '/bɪɡ/', 'small': '/smɔːl/', 'long': '/lɔːŋ/',
  'short': '/ʃɔːrt/', 'tall': '/tɔːl/', 'old': '/oʊld/', 'new': '/nuː/', 'young': '/jʌŋ/',
  'hot': '/hɑːt/', 'cold': '/koʊld/', 'warm': '/wɔːrm/', 'cool': '/kuːl/', 'fast': '/fæst/',
  'slow': '/sloʊ/', 'easy': '/ˈiːzi/', 'hard': '/hɑːrd/', 'early': '/ˈɜːrli/', 'late': '/leɪt/',
  'right': '/raɪt/', 'left': '/left/', 'up': '/ʌp/', 'down': '/daʊn/', 'in': '/ɪn/',
  'out': '/aʊt/', 'on': '/ɑːn/', 'off': '/ɔːf/', 'over': '/ˈoʊvər/', 'under': '/ˈʌndər/',
  'high': '/haɪ/', 'low': '/loʊ/', 'full': '/fʊl/', 'empty': '/ˈempti/', 'happy': '/ˈhæpi/',
  'sad': '/sæd/', 'angry': '/ˈæŋɡri/', 'beautiful': '/ˈbjuːtɪfəl/', 'nice': '/naɪs/',

  // 常用副词/介词/连词
  'no': '/noʊ/', 'yes': '/jes/', 'not': '/nɑːt/', 'very': '/ˈveri/', 'also': '/ˈɔːlsoʊ/',
  'and': '/ænd/', 'but': '/bʌt/', 'or': '/ɔːr/', 'so': '/soʊ/', 'because': '/bɪˈkɔːz/',
  'if': '/ɪf/', 'when': '/wen/', 'where': '/wer/', 'what': '/wɑːt/', 'who': '/huː/',
  'how': '/haʊ/', 'why': '/waɪ/', 'which': '/wɪtʃ/',
  'at': '/æt/', 'by': '/baɪ/', 'for': '/fɔːr/', 'from': '/frʌm/', 'of': '/ʌv/',
  'to': '/tuː/', 'with': '/wɪð/', 'about': '/əˈbaʊt/', 'than': '/ðæn/', 'after': '/ˈæftər/',
  'before': '/bɪˈfɔːr/', 'between': '/bɪˈtwiːn/', 'during': '/ˈdʊrɪŋ/', 'until': '/ənˈtɪl/',
  'here': '/hɪr/', 'there': '/ðer/', 'now': '/naʊ/', 'then': '/ðen/', 'today': '/təˈdeɪ/',
  'tomorrow': '/təˈmɑːroʊ/', 'yesterday': '/ˈjestərdeɪ/', 'always': '/ˈɔːlweɪz/', 'never': '/ˈnevər/',
  'often': '/ˈɔːfən/', 'sometimes': '/ˈsʌmtaɪmz/', 'usually': '/ˈjuːʒuəli/',

  // 天气/自然
  'sun': '/sʌn/', 'moon': '/muːn/', 'star': '/stɑːr/', 'sky': '/skaɪ/', 'cloud': '/klaʊd/',
  'rain': '/reɪn/', 'snow': '/snoʊ/', 'wind': '/wɪnd/', 'weather': '/ˈweðər/', 'tree': '/triː/',
  'flower': '/ˈflaʊər/', 'grass': '/ɡræs/', 'leaf': '/liːf/', 'river': '/ˈrɪvər/', 'sea': '/siː/',
  'mountain': '/ˈmaʊntən/', 'road': '/roʊd/', 'park': '/pɑːrk/', 'garden': '/ˈɡɑːrdən/',

  // 学习/学校
  'computer': '/kəmˈpjuːtər/', 'phone': '/foʊn/', 'picture': '/ˈpɪktʃər/', 'map': '/mæp/',
  'game': '/ɡeɪm/', 'ball': '/bɔːl/', 'toy': '/tɔɪ/', 'doll': '/dɑːl/',

  // 衣物
  'shirt': '/ʃɜːrt/', 'shoe': '/ʃuː/', 'hat': '/hæt/', 'coat': '/koʊt/', 'dress': '/dres/',
  'sock': '/sɑːk/', 'socks': '/sɑːks/', 'trousers': '/ˈtraʊzərz/', 'jeans': '/dʒiːnz/',

  // 货币
  'money': '/ˈmʌni/', 'dollar': '/ˈdɑːlər/', 'cent': '/sent/',

  // 频度副词
  'much': '/mʌtʃ/', 'many': '/ˈmeni/', 'some': '/sʌm/', 'any': '/ˈeni/', 'all': '/ɔːl/',
  'every': '/ˈevri/', 'each': '/iːtʃ/', 'other': '/ˈʌðər/', 'another': '/əˈnʌðər/',

  // 球/运动
  'soccer': '/ˈsɑːkər/', 'football': '/ˈfʊtbɔːl/', 'basketball': '/ˈbæskɪtbɔːl/',

  // 指示/物主
  'mine': '/maɪn/', 'yours': '/jʊrz/', 'hers': '/hɜːrz/', 'ours': '/aʊərz/', 'theirs': '/ðerz/',

  // 短语用词
  'please': '/pliːz/', 'thank': '/θæŋk/', 'hello': '/həˈloʊ/', 'hi': '/haɪ/', 'bye': '/baɪ/',
  'sorry': '/ˈsɔːri/', 'excuse': '/ɪkˈskjuːz/', 'OK': '/ˌoʊˈkeɪ/',
}

function getArgs(): { sample: number; apply: boolean; ipaOnly: boolean; audioOnly: boolean } {
  const args = process.argv.slice(2)
  let sample = 0
  let apply = false
  let ipaOnly = false
  let audioOnly = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--sample' && args[i + 1]) sample = parseInt(args[i + 1], 10)
    if (args[i] === '--apply') apply = true
    if (args[i] === '--ipa-only') ipaOnly = true
    if (args[i] === '--audio-only') audioOnly = true
  }
  // 互斥
  if (ipaOnly && audioOnly) {
    console.error('❌ --ipa-only 和 --audio-only 互斥')
    process.exit(1)
  }
  return { sample, apply, ipaOnly, audioOnly }
}

function getApiKey(): string {
  return process.env.DEEPSEEK_API_KEY || ''
}

function buildAudioUrl(headword: string): string {
  return `https://dict.youdao.com/dictvoice?audio=${encodeURIComponent(headword)}&type=2`
}

interface IpaResult {
  ipa: string
  source: 'whitelist' | 'ai' | 'failed'
  reason?: string
}

async function aiIpa(word: VocabWord): Promise<IpaResult> {
  // 1. 白名单
  const key = (word.lemma || word.headword).toLowerCase().trim()
  if (IPA_WHITELIST[key]) {
    return { ipa: IPA_WHITELIST[key], source: 'whitelist', reason: `白名单命中: ${key}` }
  }
  // 短语 (含空格) 也试一下用 headword 匹配
  const hwKey = (word.headword || '').toLowerCase().trim()
  if (IPA_WHITELIST[hwKey]) {
    return { ipa: IPA_WHITELIST[hwKey], source: 'whitelist', reason: `白名单命中 (headword): ${hwKey}` }
  }

  // 2. 调 DeepSeek
  const apiKey = getApiKey()
  if (!apiKey) {
    return { ipa: '', source: 'failed', reason: 'DEEPSEEK_API_KEY 未配置' }
  }

  const messages = [
    {
      role: 'system',
      content: `You are a pronunciation assistant for American English.
Given an English word/phrase, output its IPA (International Phonetic Alphabet) in US English, wrapped in slashes.
Rules:
- Output ONLY the IPA, e.g. "/əˈpɑːl/" for "apple"
- For multi-word phrases (e.g. "ice cream"), include spaces between word transcriptions: "/aɪs kriːm/"
- If the word has multiple common pronunciations, pick the most standard US one
- For proper nouns and rare words, still try; if truly unknown, output "UNKNOWN"
- No markdown, no explanation, just the IPA string`
    },
    {
      role: 'user',
      content: `Word/phrase: "${word.headword}"${word.pos ? ` (${word.pos})` : ''}

IPA (US English):`
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
        temperature: 0,
        max_tokens: 60
      })
    })
    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`DeepSeek ${res.status}: ${errText.slice(0, 200)}`)
    }
    const data = (await res.json()) as any
    const content = (data?.choices?.[0]?.message?.content || '').trim()
    // 提 IPA: 必须 /.../
    const match = content.match(/\/([^/]+)\//)
    if (!match) {
      return { ipa: '', source: 'failed', reason: `AI 输出无 IPA: "${content.slice(0, 80)}"` }
    }
    const ipa = `/${match[1]}/`
    // 基本校验: 至少 1 个音标字符
    if (ipa.length < 3) {
      return { ipa: '', source: 'failed', reason: `AI 输出 IPA 过短: ${ipa}` }
    }
    return { ipa, source: 'ai', reason: `DeepSeek: ${content.slice(0, 60)}` }
  } catch (e: any) {
    return { ipa: '', source: 'failed', reason: `AI 调用失败: ${e.message?.slice(0, 120)}` }
  }
}

async function main() {
  const { sample, apply, ipaOnly, audioOnly } = getArgs()
  if (apply) {
    console.log('⚠️  --apply 模式: 将会写库. 5 秒后继续, Ctrl+C 取消')
    await new Promise(r => setTimeout(r, 5000))
  } else {
    console.log('🔍 dry-run 模式: 不写库. 加 --apply 才会写.\n')
  }
  if (ipaOnly) console.log('🎯 仅补 ipa\n')
  if (audioOnly) console.log('🎯 仅补 audioUrl\n')

  const mongoUrl = process.env.MONGO_URL || 'mongodb://localhost:27017/linguacraft'
  console.log(`连接 mongo: ${mongoUrl}`)
  await mongoose.connect(mongoUrl)
  const VocabWord = mongoose.model('VocabWord', new mongoose.Schema({}, { strict: false }))

  // 拉缺 ipa 或 audioUrl 的词
  const filter: any = {
    $or: [
      { ipa: { $exists: false } },
      { ipa: null },
      { ipa: '' },
      { audioUrl: { $exists: false } },
      { audioUrl: null },
      { audioUrl: '' }
    ]
  }
  const all = (await VocabWord.find(filter).lean()) as unknown as VocabWord[]
  console.log(`候选词: ${all.length} 词 (缺 ipa 或 audioUrl)`)

  const toProcess = sample > 0 ? all.slice(0, sample) : all
  console.log(`本次处理: ${toProcess.length} 词${sample > 0 ? ' (sample 模式)' : ''}\n`)

  // --apply 模式: 短路读 dry-run JSON
  if (apply) {
    if (!fs.existsSync(REPORT_PATH)) {
      console.error(`❌ --apply 模式需要 dry-run 报告: ${REPORT_PATH}`)
      console.error(`   先跑: npx ts-node scripts/enrich-ipa-audio.ts${sample ? ` --sample ${sample}` : ''}`)
      await mongoose.disconnect()
      process.exit(1)
    }
    const saved = JSON.parse(fs.readFileSync(REPORT_PATH, 'utf-8')) as RunReport
    const entries = (saved.entries || []).filter(e => e.ipaChange || e.audioChange)
    console.log(`✏️  --apply 模式: 读 dry-run 报告 (${saved.generatedAt})`)
    console.log(`   将改 ipa: ${entries.filter(e => e.ipaChange).length} 词`)
    console.log(`   将改 audioUrl: ${entries.filter(e => e.audioChange).length} 词`)

    const ops = entries.map(e => {
      const set: any = {}
      if (e.ipaChange) set.ipa = e.newIpa
      if (e.audioChange) set.audioUrl = e.newAudioUrl
      return { updateOne: { filter: { _id: new mongoose.Types.ObjectId(e._id) }, update: { $set: set } } }
    })
    let written = 0
    const batchSize = 500
    for (let i = 0; i < ops.length; i += batchSize) {
      const chunk = ops.slice(i, i + batchSize)
      const res = await VocabWord.bulkWrite(chunk, { ordered: false })
      written += (res.modifiedCount || 0)
      console.log(`   [${Math.min(i + batchSize, ops.length)}/${ops.length}] modified ${res.modifiedCount}`)
    }
    console.log(`✅ 写库完成: ${written} 字段更新`)
    console.log(`💾 Backup: /tmp/linguacraft-backups/vocabwords-pre-ipa-audio-*.json`)
    await mongoose.disconnect()
    return
  }

  if (!ipaOnly && !getApiKey()) {
    console.log('⚠️  DEEPSEEK_API_KEY 未配置, ipa AI 标注会全部失败 (仅白名单命中有效)')
    console.log('   跑前请确认 backend/.env 里有 DEEPSEEK_API_KEY\n')
  }

  const entries: EnrichmentEntry[] = new Array(toProcess.length)
  let aiCalls = 0
  let whiteHits = 0
  let ipaFailed = 0
  const startTime = Date.now()

  // 5 路并发
  const CONCURRENCY = 5
  let cursor = 0
  async function worker() {
    while (cursor < toProcess.length) {
      const i = cursor++
      const w = toProcess[i]
      const currentIpa = (w.ipa || '').toString().trim()
      const currentAudio = (w.audioUrl || '').toString().trim()
      const newAudio = buildAudioUrl(w.headword)

      let newIpa = currentIpa
      let ipaSource: EnrichmentEntry['ipaSource'] = 'unchanged'
      let ipaReason: string | undefined
      let ipaChange = false

      if (!ipaOnly) {
        if (currentIpa) {
          ipaSource = 'unchanged'
          ipaReason = '已有 ipa, 跳过'
        } else {
          const r = await aiIpa(w)
          if (r.source === 'whitelist') {
            whiteHits++
            ipaSource = 'whitelist'
          } else if (r.source === 'ai') {
            aiCalls++
            ipaSource = 'ai'
          } else {
            ipaFailed++
            ipaSource = 'failed'
          }
          ipaReason = r.reason
          if (r.ipa && r.ipa !== currentIpa) {
            newIpa = r.ipa
            ipaChange = true
          } else if (currentIpa) {
            ipaSource = 'unchanged'
          }
        }
      }

      entries[i] = {
        _id: String(w._id),
        lemma: w.lemma,
        pos: w.pos,
        headword: w.headword,
        currentIpa,
        currentAudioUrl: currentAudio,
        newIpa,
        newAudioUrl: newAudio,
        ipaChange,
        audioChange: newAudio !== currentAudio,
        ipaSource,
        ipaReason
      }
    }
  }
  const workers = Array.from({ length: CONCURRENCY }, () => worker())

  // 进度
  const progressInterval = setInterval(() => {
    const done = entries.filter(Boolean).length
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    const rate = (done / parseFloat(elapsed)).toFixed(1)
    process.stdout.write(`\r[${done}/${toProcess.length}] 进度 ${(done / toProcess.length * 100).toFixed(1)}% (${elapsed}s, ${rate} 词/s)  AI ${aiCalls} 白名单 ${whiteHits} 失败 ${ipaFailed}`)
  }, 1000)

  await Promise.all(workers)
  clearInterval(progressInterval)
  const done = entries.filter(Boolean).length
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  process.stdout.write(`\r[${done}/${toProcess.length}] 进度 100.0% (${elapsed}s)\n\n`)

  // ==================== 报告 ====================
  const sep = '═'.repeat(70)
  console.log(sep)
  console.log(`📊 ipa + audioUrl 补全报告 — ${entries.length} 词`)
  console.log(sep)
  console.log()

  const ipaChangeCount = entries.filter(e => e.ipaChange).length
  const audioChangeCount = entries.filter(e => e.audioChange).length
  const ipaSkipCount = entries.filter(e => e.ipaSource === 'unchanged' && !e.ipaChange).length
  const ipaFailedCount = entries.filter(e => e.ipaSource === 'failed').length
  const ipaWhiteCount = entries.filter(e => e.ipaSource === 'whitelist').length
  const ipaAiCount = entries.filter(e => e.ipaSource === 'ai').length

  console.log('--- 改动统计 ---')
  console.log(`  ipa 改:    ${ipaChangeCount} 词`)
  console.log(`    └ AI:    ${ipaAiCount}`)
  console.log(`    └ 白名单: ${ipaWhiteCount}`)
  console.log(`    └ 失败:  ${ipaFailedCount} (会保留空值, --apply 时不写)`)
  console.log(`  ipa 跳过:  ${ipaSkipCount} 词 (已有 ipa)`)
  console.log(`  audioUrl 改: ${audioChangeCount} 词`)
  console.log()

  // 来源分布
  const sourceDist: Record<string, number> = {}
  for (const e of entries) {
    sourceDist[e.ipaSource] = (sourceDist[e.ipaSource] || 0) + 1
  }
  console.log('--- ipa 来源分布 ---')
  for (const [k, v] of Object.entries(sourceDist)) {
    console.log(`  ${k.padEnd(10)} ${v}`)
  }
  console.log()

  // 失败样本 (前 20)
  const failedSamples = entries.filter(e => e.ipaSource === 'failed').slice(0, 20)
  if (failedSamples.length > 0) {
    console.log(`--- ipa 失败样本 (前 20) ---`)
    for (const e of failedSamples) {
      console.log(`  ${e.headword.padEnd(20)} [${e.pos}] ${e.ipaReason || '(no reason)'}`)
    }
    console.log()
  }

  // ipa 改的样本 (前 20)
  const ipaChangedSamples = entries.filter(e => e.ipaChange).slice(0, 20)
  if (ipaChangedSamples.length > 0) {
    console.log(`--- ipa 改的样本 (前 20) ---`)
    for (const e of ipaChangedSamples) {
      console.log(`  ${e.headword.padEnd(20)} [${e.pos}] ${e.currentIpa || '(空)'} → ${e.newIpa}  [${e.ipaSource}]`)
    }
    console.log()
  }

  // 写 JSON
  const report: RunReport = {
    generatedAt: new Date().toISOString(),
    filter: { sample: sample || 0, ipaOnly, audioOnly },
    totalCandidates: toProcess.length,
    ipaWillChange: ipaChangeCount,
    audioWillChange: audioChangeCount,
    ipaAiCalls: aiCalls,
    ipaWhiteHits: whiteHits,
    ipaFailed: ipaFailed,
    entries
  }
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2))
  console.log(`📄 详细报告: ${REPORT_PATH}`)
  console.log(`💾 Backup: /tmp/linguacraft-backups/vocabwords-pre-ipa-audio-*.json`)
  console.log()

  if (ipaChangeCount > 0 || audioChangeCount > 0) {
    console.log(`💡 加 --apply 才会实际写库. 看完上面报告后决定:`)
    console.log(`   cd backend && npx ts-node scripts/enrich-ipa-audio.ts --apply`)
    if (sample) console.log(`   (注意: --apply 会用 sample 范围之外的完整报告, 或重新跑无 sample)`)
  } else {
    console.log(`✨ 无需改动, ipa 和 audioUrl 都已对齐`)
  }

  await mongoose.disconnect()
}

main().catch(e => {
  console.error('❌ 脚本失败:', e)
  process.exit(1)
})
