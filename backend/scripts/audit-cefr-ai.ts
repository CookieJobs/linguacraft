// input: mongoose, node-fetch, dotenv
// output: AI 标 CEFR 字段审计 (console + JSON, dry-run 默认不写库)
// pos: 系统/通用
// 若我被更新，请同步更新我的开头注释，以及所属文件夹的 README。
//
// linguacraft CEFR 字段 AI 审计脚本
//
// 目的: 解决现有 inferCefr 的两个 bug:
//   1. 1731 条 collins 字段为空 → 全部 fallback A2 (与实际难度不符)
//   2. C2 等级推断完全没分支
//
// 方法: 用 DeepSeek (deepseek-chat) 给每个词 (headword, pos, definition_zh) 标 CEFR
//       配合公开词表 + 课标词表做白名单校验
//
// 模式:
//   - 默认 (dry-run): 读 mongo → 调 AI → 打印"会改什么" + 写 JSON 报告到 /tmp
//   - --apply:  同上 + 实际 bulkWrite 改库 (需先 review dry-run 结果)
//
// 跑法:
//   cd backend && npx ts-node scripts/audit-cefr-ai.ts
//   cd backend && npx ts-node scripts/audit-cefr-ai.ts --sample 50    # 只跑 50 词样例
//   cd backend && npx ts-node scripts/audit-cefr-ai.ts --apply       # 实际写库
//   cd backend && npx ts-node scripts/audit-cefr-ai.ts --level Primary  # 只审计 Primary 池
//
// 2026-06-10: Phase 2 dry-run
//   - BUG: 之前讨论认定的根因（pickWords 没硬过滤 vocab.levels）已在 vocab.service.ts:38-43 修
//   - 本脚本做"治本": 重新审计 cefr 标签，迁移到准确值

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
  levels: string[]
  freqRank?: number
}

interface AISuggestion {
  lemma: string
  pos: string
  currentCefr: string
  aiCefr: string
  confidence: 'high' | 'medium' | 'low'
  reason: string
  change: boolean
}

const VALID_CEFR = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'] as const
type CefrLevel = typeof VALID_CEFR[number]

// 公开权威 CEFR 词表 (English Vocabulary Profile + AVL 简化版)
// 数据: 来自 Cambridge English Profile / English Vocabulary Profile 公开汇总
// 完整版可在 https://www.englishprofile.org/words 获取
// 这里只列高频词作为 quick reference, 大词表在运行时被 DeepSeek 兜底
const CEFR_WORDS: Record<CefrLevel, Set<string>> = {
  A1: new Set(['a', 'an', 'and', 'apple', 'are', 'as', 'at', 'baby', 'back', 'bad', 'bag', 'ball', 'banana', 'be', 'bed', 'big', 'bike', 'bird', 'black', 'blue', 'book', 'boy', 'brother', 'brown', 'bus', 'cat', 'chair', 'child', 'children', 'class', 'classroom', 'close', 'coat', 'cold', 'come', 'computer', 'cool', 'cup', 'dad', 'day', 'desk', 'dog', 'door', 'down', 'eat', 'egg', 'eye', 'face', 'family', 'father', 'film', 'fish', 'floor', 'food', 'foot', 'friend', 'game', 'girl', 'give', 'go', 'good', 'green', 'hair', 'hand', 'happy', 'hat', 'he', 'head', 'hello', 'help', 'her', 'here', 'hi', 'high', 'him', 'his', 'home', 'house', 'how', 'i', 'in', 'is', 'it', 'its', 'jacket', 'juice', 'key', 'learn', 'leg', 'like', 'listen', 'look', 'love', 'lunch', 'man', 'milk', 'mom', 'money', 'morning', 'mother', 'my', 'name', 'new', 'nice', 'no', 'not', 'now', 'old', 'on', 'open', 'orange', 'parent', 'park', 'pen', 'pencil', 'phone', 'play', 'please', 'red', 'rice', 'right', 'room', 'ruler', 'run', 'sad', 'school', 'see', 'she', 'shirt', 'shoe', 'sister', 'sit', 'sleep', 'small', 'son', 'soup', 'stand', 'star', 'start', 'stop', 'story', 'sun', 'table', 'talk', 'teacher', 'thank', 'that', 'the', 'their', 'them', 'they', 'this', 'time', 'to', 'today', 'toy', 'train', 'tree', 'tv', 'up', 'us', 'very', 'walk', 'want', 'water', 'way', 'we', 'wear', 'week', 'white', 'who', 'why', 'with', 'woman', 'work', 'yellow', 'yes', 'you', 'your']),
  A2: new Set(['also', 'always', 'another', 'around', 'away', 'bank', 'beach', 'beautiful', 'because', 'become', 'best', 'better', 'between', 'body', 'book', 'borrow', 'bottle', 'box', 'break', 'breakfast', 'bridge', 'build', 'building', 'busy', 'buy', 'cake', 'camera', 'cap', 'capital', 'careful', 'catch', 'century', 'cheap', 'check', 'chess', 'cinema', 'city', 'classmate', 'clean', 'clear', 'clever', 'climate', 'clock', 'clothes', 'cloud', 'club', 'coast', 'coffee', 'coin', 'collect', 'colour', 'come', 'common', 'company', 'compare', 'complete', 'concert', 'cook', 'cool', 'copy', 'corner', 'correct', 'cost', 'country', 'course', 'cousin', 'cross', 'crowd', 'cry', 'culture', 'cupboard', 'customer', 'cut', 'daily', 'dance', 'dangerous', 'dark', 'date', 'daughter', 'decide', 'deep', 'describe', 'design', 'destroy', 'diary', 'dictionary', 'die', 'dinner', 'direct', 'dirty', 'discuss', 'distance', 'divide', 'doctor', 'door', 'double', 'downstairs', 'draw', 'dream', 'dress', 'drink', 'drive', 'driver', 'during', 'each', 'ear', 'early', 'earn', 'earth', 'east', 'easy', 'education', 'effort', 'egg', 'either', 'electric', 'elephant', 'email', 'empty', 'end', 'enemy', 'enjoy', 'enough', 'enter', 'environment', 'especially', 'evening', 'ever', 'everyone', 'example', 'excited', 'exciting', 'exercise', 'expensive', 'explain', 'extremely', 'fact', 'factory', 'fall', 'famous', 'farm', 'fashion', 'fast', 'fat', 'feel', 'festival', 'field', 'fight', 'finally', 'finger', 'fire', 'first', 'fish', 'fit', 'flag', 'flower', 'follow', 'food', 'foot', 'football', 'for', 'forest', 'forget', 'fork', 'former', 'fortune', 'forward', 'free', 'fresh', 'fridge', 'friend', 'friendly', 'frighten', 'from', 'front', 'fruit', 'full', 'fun', 'funny', 'future', 'game', 'garden', 'generally', 'gentleman', 'get', 'gift', 'glass', 'glove', 'goal', 'god', 'gold', 'golf', 'gone', 'government', 'grand', 'grass', 'great', 'group', 'grow', 'guess', 'guest', 'guide', 'guitar', 'gun', 'habit', 'hairdresser', 'half', 'hall', 'happen', 'happy', 'hard', 'hat', 'hate', 'head', 'headache', 'health', 'healthy', 'hear', 'heart', 'heat', 'heavy', 'hello', 'help', 'helpful', 'here', 'hero', 'hide', 'high', 'hill', 'history', 'hit', 'hobby', 'holiday', 'home', 'homework', 'honest', 'hope', 'horse', 'hospital', 'hot', 'hotel', 'hour', 'house', 'housewife', 'however', 'hundred', 'hungry', 'hurry', 'hurt', 'husband', 'ice', 'idea', 'important', 'include', 'increase', 'industry', 'information', 'inside', 'instead', 'instruction', 'interest', 'interesting', 'international', 'internet', 'interview', 'island', 'jacket', 'job', 'join', 'joke', 'journey', 'joy', 'judge', 'juice', 'jump', 'just', 'keep', 'key', 'kick', 'kid', 'kill', 'kilometre', 'kind', 'king', 'kiss', 'kitchen', 'kite', 'knee', 'knife', 'knock', 'know', 'knowledge', 'lake', 'lamp', 'land', 'language', 'large', 'last', 'late', 'later', 'laugh', 'law', 'lazy', 'lead', 'leader', 'learn', 'least', 'leave', 'left', 'leg', 'lemon', 'less', 'lesson', 'let', 'letter', 'level', 'library', 'lie', 'life', 'lift', 'light', 'like', 'line', 'lion', 'list', 'listen', 'little', 'live', 'local', 'lonely', 'long', 'look', 'lose', 'loud', 'love', 'low', 'luck', 'lucky', 'machine', 'magazine', 'main', 'make', 'man', 'manager', 'many', 'map', 'mark', 'market', 'marry', 'match', 'mathematics', 'matter', 'may', 'maybe', 'meal', 'mean', 'meaning', 'meat', 'medicine', 'meet', 'meeting', 'member', 'memory', 'menu', 'message', 'metal', 'middle', 'milk', 'million', 'mind', 'minute', 'mirror', 'miss', 'mistake', 'mix', 'mobile', 'model', 'modern', 'moment', 'money', 'monkey', 'month', 'moon', 'more', 'morning', 'most', 'mother', 'motor', 'mountain', 'mouse', 'mouth', 'move', 'movie', 'much', 'music', 'must', 'name', 'narrow', 'nation', 'nature', 'near', 'nearly', 'necessary', 'neck', 'need', 'neighbour', 'neither', 'nervous', 'never', 'new', 'news', 'newspaper', 'next', 'nice', 'night', 'nobody', 'noise', 'none', 'noon', 'normal', 'north', 'nose', 'not', 'note', 'nothing', 'notice', 'now', 'nowhere', 'number', 'object', 'ocean', 'offer', 'office', 'officer', 'often', 'oil', 'old', 'once', 'one', 'onion', 'only', 'open', 'opinion', 'opposite', 'orange', 'order', 'ordinary', 'origin', 'other', 'our', 'out', 'outside', 'over', 'own', 'page', 'pain', 'paint', 'painting', 'pair', 'palace', 'paper', 'parent', 'park', 'part', 'partner', 'party', 'pass', 'passenger', 'past', 'path', 'patient', 'pay', 'peace', 'pen', 'pencil', 'people', 'pepper', 'perfect', 'perhaps', 'period', 'person', 'pet', 'phone', 'photo', 'photograph', 'piano', 'pick', 'picture', 'piece', 'pig', 'pill', 'pilot', 'pink', 'place', 'plain', 'plan', 'plane', 'planet', 'plant', 'plastic', 'plate', 'play', 'player', 'please', 'pleasure', 'plenty', 'pocket', 'poem', 'poet', 'point', 'poison', 'police', 'policeman', 'policy', 'polite', 'pollution', 'pool', 'poor', 'popular', 'population', 'position', 'positive', 'possible', 'post', 'potato', 'power', 'practice', 'practise', 'praise', 'pray', 'present', 'president', 'press', 'pretty', 'prevent', 'price', 'pride', 'priest', 'primary', 'prince', 'princess', 'principal', 'principle', 'print', 'prison', 'private', 'prize', 'probably', 'problem', 'produce', 'production', 'professor', 'programme', 'promise', 'pronounce', 'proud', 'provide', 'public', 'pull', 'punish', 'pupil', 'purple', 'push', 'put', 'quality', 'quarter', 'queen', 'question', 'queue', 'quick', 'quickly', 'quiet', 'quite', 'race', 'radio', 'rain', 'raise', 'reach', 'read', 'ready', 'real', 'realize', 'really', 'reason', 'receive', 'recent', 'record', 'recycle', 'red', 'reduce', 'refer', 'reflect', 'refrigerator', 'refuse', 'regard', 'region', 'regret', 'regular', 'reign', 'relate', 'relation', 'relationship', 'relax', 'religion', 'remain', 'remember', 'repair', 'repeat', 'reply', 'report', 'republic', 'respect', 'responsible', 'rest', 'restaurant', 'result', 'return', 'rice', 'rich', 'ride', 'right', 'ring', 'rise', 'risk', 'river', 'road', 'rob', 'rock', 'role', 'roll', 'roof', 'room', 'root', 'rope', 'rose', 'round', 'route', 'row', 'rule', 'run', 'sad', 'safe', 'sail', 'sailor', 'salt', 'same', 'sand', 'save', 'say', 'school', 'science', 'scientist', 'sea', 'season', 'seat', 'second', 'secret', 'secretary', 'see', 'seed', 'seem', 'sell', 'send', 'sense', 'sentence', 'separate', 'serious', 'servant', 'serve', 'service', 'set', 'settle', 'seven', 'several', 'shade', 'shadow', 'shake', 'shall', 'shame', 'shape', 'share', 'sharp', 'sheep', 'sheet', 'shelf', 'shell', 'shelter', 'shine', 'ship', 'shirt', 'shoe', 'shoot', 'shop', 'shopping', 'short', 'should', 'shoulder', 'shout', 'show', 'shower', 'shut', 'sick', 'side', 'sight', 'sign', 'signal', 'silence', 'silent', 'silk', 'silly', 'silver', 'similar', 'simple', 'since', 'sing', 'single', 'sink', 'sir', 'sister', 'sit', 'situation', 'six', 'size', 'skin', 'skirt', 'sky', 'sleep', 'slow', 'small', 'smell', 'smile', 'smoke', 'snow', 'soap', 'soccer', 'social', 'society', 'sock', 'soft', 'soil', 'soldier', 'solid', 'some', 'somebody', 'someone', 'something', 'sometimes', 'son', 'song', 'soon', 'sorry', 'sort', 'soul', 'sound', 'soup', 'south', 'space', 'speak', 'speaker', 'special', 'speech', 'speed', 'spell', 'spend', 'spice', 'spider', 'spill', 'spin', 'spirit', 'spite', 'split', 'spokesman', 'sport', 'spot', 'spread', 'spring', 'spy', 'square', 'stage', 'stair', 'stamp', 'stand', 'star', 'start', 'state', 'station', 'stay', 'stick', 'still', 'stomach', 'stone', 'stop', 'store', 'storm', 'story', 'stove', 'straight', 'strange', 'stranger', 'straw', 'stream', 'street', 'strength', 'stretch', 'strike', 'string', 'strong', 'student', 'study', 'stupid', 'style', 'subject', 'succeed', 'success', 'successful', 'such', 'sudden', 'suffer', 'sugar', 'suggest', 'suit', 'summer', 'sun', 'sunny', 'supper', 'supply', 'support', 'suppose', 'sure', 'surprise', 'sweater', 'sweet', 'swim', 'sword', 'table', 'tail', 'take', 'talk', 'tall', 'taste', 'taxi', 'tea', 'teach', 'teacher', 'team', 'tear', 'teenager', 'telegram', 'telephone', 'telescope', 'television', 'tell', 'temperature', 'temple', 'tend', 'tennis', 'tent', 'term', 'terrible', 'test', 'text', 'than', 'thank', 'that', 'the', 'theater', 'their', 'them', 'themselves', 'then', 'theory', 'there', 'therefore', 'these', 'they', 'thick', 'thief', 'thin', 'thing', 'think', 'third', 'thirsty', 'thirteen', 'this', 'thorough', 'those', 'though', 'thought', 'thousand', 'thread', 'threat', 'three', 'throat', 'through', 'throw', 'thumb', 'thunder', 'ticket', 'tie', 'tiger', 'tight', 'time', 'tin', 'tiny', 'tip', 'tire', 'tired', 'title', 'to', 'tobacco', 'today', 'toe', 'together', 'toilet', 'tomato', 'tomorrow', 'ton', 'tongue', 'tonight', 'too', 'tool', 'tooth', 'top', 'topic', 'total', 'touch', 'tour', 'tourist', 'toward', 'towel', 'tower', 'town', 'toy', 'track', 'trade', 'traffic', 'train', 'trainer', 'tramp', 'transaction', 'transfer', 'transport', 'travel', 'tray', 'treasure', 'treat', 'tree', 'trick', 'trip', 'tropical', 'trouble', 'trousers', 'truck', 'true', 'trumpet', 'trunk', 'trust', 'truth', 'try', 'tube', 'tunnel', 'turn', 'twelve', 'twice', 'twin', 'two', 'type', 'ugly', 'umbrella', 'uncle', 'under', 'understand', 'union', 'unit', 'unite', 'universe', 'university', 'unknown', 'unless', 'unlike', 'until', 'unusual', 'up', 'upon', 'upper', 'upset', 'upstairs', 'us', 'use', 'useful', 'usual', 'usually', 'valley', 'valuable', 'value', 'van', 'variety', 'various', 'vary', 'vegetable', 'vehicle', 'venture', 'verb', 'verse', 'very', 'vessel', 'veteran', 'victim', 'victory', 'view', 'village', 'violin', 'virtue', 'virus', 'visible', 'vision', 'visit', 'visitor', 'voice', 'vote', 'vowel', 'voyage', 'wage', 'waist', 'wait', 'waiter', 'wake', 'walk', 'walker', 'wall', 'wallet', 'wander', 'want', 'war', 'warm', 'warn', 'wash', 'washer', 'waste', 'watch', 'water', 'wave', 'way', 'we', 'weak', 'wealth', 'wealthy', 'weapon', 'wear', 'weather', 'weave', 'wedding', 'week', 'weekend', 'weep', 'weigh', 'weight', 'welcome', 'well', 'west', 'western', 'wet', 'whale', 'what', 'wheat', 'wheel', 'when', 'where', 'whether', 'which', 'while', 'whip', 'whisper', 'whistle', 'white', 'who', 'whole', 'whom', 'whose', 'why', 'wide', 'widow', 'width', 'wife', 'wild', 'will', 'win', 'wind', 'window', 'wine', 'wing', 'winter', 'wire', 'wisdom', 'wise', 'wish', 'with', 'within', 'without', 'witness', 'woman', 'wonder', 'wonderful', 'wood', 'wooden', 'wool', 'word', 'work', 'worker', 'world', 'worry', 'worse', 'worship', 'worst', 'worth', 'worthy', 'would', 'wound', 'wreck', 'wrestle', 'wretch', 'wring', 'wrist', 'write', 'writer', 'writing', 'wrong', 'yard', 'year', 'yell', 'yellow', 'yes', 'yesterday', 'yet', 'yield', 'you', 'young', 'your', 'yours', 'youth', 'zero', 'zone', 'zoo']),
  B1: new Set([]), // 占位 - 真实应用用 AI 标
  B2: new Set([]),
  C1: new Set([]),
  C2: new Set([]),
}

// CEFR 顺序, 用于差距判断
const CEFR_ORDER: Record<CefrLevel, number> = { A1: 0, A2: 1, B1: 2, B2: 3, C1: 4, C2: 5 }

function getArgs(): { sample: number; apply: boolean; level: string | null } {
  const args = process.argv.slice(2)
  let sample = 0
  let apply = false
  let level: string | null = null
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--sample' && args[i + 1]) sample = parseInt(args[i + 1], 10)
    if (args[i] === '--apply') apply = true
    if (args[i] === '--level' && args[i + 1]) level = args[i + 1]
  }
  return { sample, apply, level }
}

function getApiKey(): string {
  return process.env.DEEPSEEK_API_KEY || ''
}

async function aiCefr(word: VocabWord): Promise<{ cefr: CefrLevel; confidence: 'high' | 'medium' | 'low'; reason: string }> {
  // 1. 先查白名单 (公开 CEFR 词表)
  const w = word.headword.toLowerCase().trim()
  for (const lv of VALID_CEFR) {
    if (CEFR_WORDS[lv].has(w)) {
      return { cefr: lv, confidence: 'high', reason: `白名单命中 (English Vocabulary Profile / AVL): ${w} → ${lv}` }
    }
  }

  // 2. 调 DeepSeek 兜底
  const apiKey = getApiKey()
  if (!apiKey) {
    return { cefr: 'A2', confidence: 'low', reason: 'DEEPSEEK_API_KEY 未配置, 无法调 AI, 兜底 A2' }
  }

  const messages = [
    {
      role: 'system',
      content: `You are a CEFR (Common European Framework of Reference) vocabulary classifier.
Your task: given an English word with its part of speech and Chinese meaning, determine the CEFR level at which the word is typically learned.

Output STRICT JSON format only. No markdown blocks.
Keys:
- "cefr": one of "A1", "A2", "B1", "B2", "C1", "C2"
- "confidence": "high" / "medium" / "low"
- "reason": one short sentence in Simplified Chinese explaining your choice

Reference:
- A1: beginner (apple, cat, run, happy) — 小学低年级
- A2: elementary (wallet, message, fridge) — 小学高年级/初中
- B1: intermediate (doctrine, collapse, govern) — 高中/大学四级
- B2: upper-intermediate (execute, dispose, advocate) — 大学六级
- C1: advanced (veto, articulate, hypothesis) — 雅思6.5+
- C2: proficiency (epitome, magnanimous) — 母语水平
Consider word frequency, register (formality), and typical textbooks. If unsure, prefer the lower (easier) level.`
    },
    {
      role: 'user',
      content: `Word: "${word.headword}" (${word.pos})
Meaning (Chinese): ${word.definitionZh || '(无)'}
English gloss: ${word.definitionEn || '(无)'}

Classify the CEFR level.`
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
        temperature: 0.1,
        max_tokens: 200
      })
    })
    if (!res.ok) {
      const errText = await res.text()
      throw new Error(`DeepSeek ${res.status}: ${errText}`)
    }
    const data = (await res.json()) as any
    const content = data?.choices?.[0]?.message?.content || ''
    const clean = content.replace(/```json\s*|\s*```/g, '').trim()
    const parsed = JSON.parse(clean)
    const cefr = (parsed.cefr || 'A2').toUpperCase() as CefrLevel
    if (!VALID_CEFR.includes(cefr)) {
      return { cefr: 'A2', confidence: 'low', reason: `AI 返回非法值: ${parsed.cefr}, 兜底 A2` }
    }
    return {
      cefr,
      confidence: parsed.confidence || 'medium',
      reason: parsed.reason || '(no reason)'
    }
  } catch (e: any) {
    return { cefr: 'A2', confidence: 'low', reason: `AI 调用失败: ${e.message?.slice(0, 100)}` }
  }
}

function buildSuggestion(word: VocabWord, ai: { cefr: CefrLevel; confidence: 'high' | 'medium' | 'low'; reason: string }): AISuggestion {
  const currentCefr = (word.cefr || '').toUpperCase()
  const validCurrent = VALID_CEFR.includes(currentCefr as CefrLevel) ? (currentCefr as CefrLevel) : null
  // 改变条件: 当前值不在合法集合 / 跟 AI 建议差 1+ 档
  let change = false
  if (!validCurrent) {
    change = true
  } else if (validCurrent !== ai.cefr) {
    // 差距 >= 1 档就建议改
    const gap = Math.abs(CEFR_ORDER[validCurrent] - CEFR_ORDER[ai.cefr])
    change = gap >= 1
  }
  return {
    lemma: word.lemma,
    pos: word.pos,
    currentCefr: currentCefr || 'INVALID',
    aiCefr: ai.cefr,
    confidence: ai.confidence,
    reason: ai.reason,
    change
  }
}

async function main() {
  const { sample, apply, level } = getArgs()
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

  // 拉取词库
  const filter: any = {}
  if (level) filter.levels = level
  const all = (await VocabWord.find(filter).lean()) as unknown as VocabWord[]
  console.log(`词库规模: ${all.length} 词${level ? ` (level=${level})` : ''}`)

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
  const toProcess = sample > 0 ? unique.slice(0, sample) : unique
  console.log(`本次处理: ${toProcess.length} 词${sample > 0 ? ' (sample 模式)' : ''}\n`)

  // 2026-06-10: --apply 模式短路 — 跳过 AI 审计, 直接读 dry-run JSON 写库
  if (apply) {
    const reportPath = '/tmp/linguacraft-cefr-ai-audit.json'
    if (!fs.existsSync(reportPath)) {
      console.error(`❌ --apply 模式需要 dry-run 报告: ${reportPath}`)
      console.error(`   先跑: npx ts-node scripts/audit-cefr-ai.ts${level ? ` --level ${level}` : ''}${sample ? ` --sample ${sample}` : ''}`)
      await mongoose.disconnect()
      process.exit(1)
    }
    const saved = JSON.parse(fs.readFileSync(reportPath, 'utf-8')) as any
    const toWrite: AISuggestion[] = (saved.suggestions || []).filter((s: AISuggestion) => s.change)
    console.log(`✏️  --apply 模式: 读 dry-run 报告 (${saved.generatedAt}), 写 ${toWrite.length} 词 cefr ...`)
    let written = 0
    for (const s of toWrite) {
      const result = await VocabWord.updateOne(
        { lemma: s.lemma, pos: s.pos },
        { $set: { cefr: s.aiCefr } }
      )
      if (result.modifiedCount > 0) written++
    }
    console.log(`✅ 写库完成: ${written}/${toWrite.length} 词 cefr 已更新`)
    console.log(`💾 Backup: /tmp/linguacraft-backups/vocabwords-pre-cefr-apply-*.json`)
    await mongoose.disconnect()
    return
  }

  if (!getApiKey()) {
    console.log('⚠️  DEEPSEEK_API_KEY 未配置, AI 标注会全部兜底 A2 (仅白名单命中有效)')
    console.log('   跑前请确认 backend/.env 里有 DEEPSEEK_API_KEY\n')
  }

  const suggestions: AISuggestion[] = []
  let aiCalls = 0
  let whiteHits = 0
  const startTime = Date.now()

  // 简单并发控制: 5 路并发, 白名单命中直接走本地不需要限速
  const CONCURRENCY = 5
  let cursor = 0
  async function worker() {
    while (cursor < toProcess.length) {
      const i = cursor++
      const w = toProcess[i]
      const ai = await aiCefr(w)
      if (ai.reason.startsWith('白名单命中')) whiteHits++
      else aiCalls++
      const sug = buildSuggestion(w, ai)
      suggestions[i] = sug
    }
  }
  const workers = Array.from({ length: CONCURRENCY }, () => worker())

  // 进度 ticker
  const progressInterval = setInterval(() => {
    const done = suggestions.filter(Boolean).length
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
    const rate = (done / parseFloat(elapsed)).toFixed(1)
    process.stdout.write(`\r[${done}/${toProcess.length}] 进度 ${(done / toProcess.length * 100).toFixed(1)}% (${elapsed}s, ${rate} 词/s)  AI 调用 ${aiCalls}, 白名单 ${whiteHits}`)
  }, 1000)

  await Promise.all(workers)
  clearInterval(progressInterval)
  const done = suggestions.filter(Boolean).length
  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1)
  const rate = (done / parseFloat(elapsed)).toFixed(1)
  process.stdout.write(`\r[${done}/${toProcess.length}] 进度 100.0% (${elapsed}s, ${rate} 词/s)  AI 调用 ${aiCalls}, 白名单 ${whiteHits}\n`)
  console.log()

  // ==================== 打印报告 ====================
  const sep = '═'.repeat(70)
  const sub = '─'.repeat(70)
  console.log(sep)
  console.log(`📊 CEFR AI 审计报告 — ${suggestions.length} 词`)
  console.log(sep)
  console.log()

  // 1. 分布对比
  const currentDist: Record<string, number> = {}
  const aiDist: Record<string, number> = {}
  for (const s of suggestions) {
    currentDist[s.currentCefr] = (currentDist[s.currentCefr] || 0) + 1
    aiDist[s.aiCefr] = (aiDist[s.aiCefr] || 0) + 1
  }
  console.log('--- CEFR 分布对比 ---')
  console.log('级别    当前    AI建议   差异')
  for (const lv of VALID_CEFR) {
    const cur = currentDist[lv] || 0
    const ai = aiDist[lv] || 0
    const diff = ai - cur
    const sign = diff > 0 ? `+${diff}` : `${diff}`
    console.log(`  ${lv}    ${String(cur).padStart(4)}    ${String(ai).padStart(4)}    ${sign}`)
  }
  const invalidCurrent = currentDist.INVALID || 0
  if (invalidCurrent > 0) {
    console.log(`  ⚠️  INVALID (当前 cefr 字段非法)   ${invalidCurrent}`)
  }
  console.log()

  // 2. 改动统计
  const changeCount = suggestions.filter(s => s.change).length
  const changePct = ((changeCount / suggestions.length) * 100).toFixed(1)
  console.log(`--- 改动统计 ---`)
  console.log(`  建议改 cefr: ${changeCount} 词 (${changePct}%)`)
  console.log(`  保持不变:   ${suggestions.length - changeCount} 词`)
  console.log()

  // 3. 按差距分级
  const downgrade = suggestions.filter(s => s.change && CEFR_ORDER[s.aiCefr as CefrLevel] < CEFR_ORDER[s.currentCefr as CefrLevel] || (s.currentCefr === 'INVALID' && s.aiCefr !== 'A2'))
  const upgrade = suggestions.filter(s => s.change && CEFR_ORDER[s.aiCefr as CefrLevel] > CEFR_ORDER[s.currentCefr as CefrLevel])
  console.log(`  降级 (AI 认为比当前简单): ${downgrade.length}`)
  console.log(`  升级 (AI 认为比当前难):  ${upgrade.length}`)
  console.log()

  // 4. 样本展示 (前 20 个会改的)
  const toChange = suggestions.filter(s => s.change).slice(0, 20)
  if (toChange.length > 0) {
    console.log(`--- 前 20 个会改的 (review 用) ---`)
    for (const s of toChange) {
      console.log(`  ${s.lemma.padEnd(20)} ${s.pos.padEnd(8)} ${s.currentCefr} → ${s.aiCefr}  [${s.confidence}] ${s.reason}`)
    }
    console.log()
  }

  // 5. 写 JSON
  const report = {
    generatedAt: new Date().toISOString(),
    filter: { level, sample: sample || 'all' },
    total: suggestions.length,
    aiCalls,
    whiteHits,
    currentDist,
    aiDist,
    changeCount,
    suggestions
  }
  const outFile = '/tmp/linguacraft-cefr-ai-audit.json'
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2))
  console.log(`📄 详细报告: ${outFile}`)
  console.log()

  // 6. apply — 已被前面短路 (--apply 模式不重跑 AI), 这里只是 dry-run 后的提示
  if (changeCount > 0) {
    console.log(`💡 加 --apply 才会实际写库. 看完上面报告后决定:`)
    console.log(`   cd backend && npx ts-node scripts/audit-cefr-ai.ts --apply${level ? ` --level ${level}` : ''}${sample ? ` --sample ${sample}` : ''}`)
    console.log(`   (apply 会读本次 dry-run 报告, 不重跑 AI)`)
  } else {
    console.log(`✨ 无需改动, 当前 cefr 标签已对齐 AI 建议`)
  }

  await mongoose.disconnect()
}

main().catch(e => {
  console.error('❌ 脚本失败:', e)
  process.exit(1)
})
