// input: @nestjs/testing, supertest, mongoose, argon2, ../modules/app.module
// output: jest test suite (6 tests)
// pos: 后端/通用层
//
// 上线前 smoke test, 跑通核心 endpoint + 一个 service unit test。
// 跑法: cd backend && npm test
//
// 设计原则:
// - 用本地 MongoDB (27017), 跑测试时连一个独立 DB (linguacraft_test_<ts>), 跑完 drop
// - redis 不可用时 RateLimitGuard 走 fail-open (rate-limit.guard.ts:85), 所以测试不需要 redis
// - 整 suite 共享一个 NestApplication (beforeAll 启动), 6 个 test 都用 supertest
// - 测试 6 (pickWords) 不走 HTTP, 直接 app.get(VocabService) 调
//   (跟其他 5 个共用 app instance, vocabModel 已经是 connected)
//
// 权衡: 用完整 AppModule 而不是手动拼, 多拉一些 module 但避免拼错依赖链
// - AppModule 会自动 import CommonModule (REDIS) / PetModule / WalletModule / UserModule / StatsModule ...
// - onModuleInit 副作用: VocabSeedService 会尝试 seed (data/processed/elementary_vocabulary.json, ~3500 词)
//   seed 只在 collection 为空时跑, test 库是新库所以会跑, 一次性 bulkWrite <2s, 可接受
// - MailService / Redis / DeepSeek 都不会真去连外网, 因为没有 SMTP_USER / DEEPSEEK_API_KEY
//
// 2026-06-12 新增
import { Test, TestingModule } from '@nestjs/testing'
import { INestApplication, ValidationPipe } from '@nestjs/common'
import { getModelToken } from '@nestjs/mongoose'
import { Model } from 'mongoose'
import request from 'supertest'
import * as argon2 from 'argon2'

// 测试用一个独立 db, 跑完删掉, 跟本地 dev db 不冲突
// 注意: static import 会 hoist 到文件顶部, 必须在 import 前 set MONGO_URL
// 这里用 require 形式 dynamic import 才能保证 env 在 AppModule 加载前就位
const TEST_DB = `linguacraft_test_${Date.now()}`
const TEST_MONGO_URL = process.env.TEST_MONGO_URL || `mongodb://localhost:27017/${TEST_DB}`

// 跑测试时把 MONGO_URL 指向 test db, 并强制 NODE_ENV=development (让 /api/admin/vocab-dev 开放)
process.env.MONGO_URL = TEST_MONGO_URL
process.env.NODE_ENV = 'development'
process.env.JWT_SECRET = 'test_jwt_secret'

const TEST_USER_EMAIL = `smoketest_${Date.now()}@linguacraft.test`
const TEST_USER_PASSWORD = 'CorrectHorseBatteryStaple1!'

// 必须放在最末的 static import, 此时 env 已经 set
// (TypeScript 会把 import 提到顶部, 但 require 不会 — 所以这里用 require 加载 AppModule
//  确保 module 顶层 const mongoUrl = process.env.MONGO_URL... 读到的是 test db)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { AppModule } = require('../modules/app.module') as typeof import('../modules/app.module')
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { VocabService } = require('../modules/learning/vocab.service') as typeof import('../modules/learning/vocab.service')

describe('Smoke (上线前 6 个 P0 测试)', () => {
  let app: INestApplication
  let server: any
  let vocabModel: Model<any>
  let userModel: Model<any>

  beforeAll(async () => {
    // 1) 用完整 AppModule, 避免手拼 module 漏依赖
    const moduleRef: TestingModule = await Test.createTestingModule({
      imports: [AppModule]
    }).compile()

    app = moduleRef.createNestApplication()
    app.setGlobalPrefix('api')
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true }))
    await app.init()
    server = app.getHttpServer()

    vocabModel = moduleRef.get(getModelToken('VocabWord'))
    userModel = moduleRef.get(getModelToken('User'))

    // 2) 准备 user fixture (login 测试用)
    const hash = await argon2.hash(TEST_USER_PASSWORD)
    await userModel.create({
      email: TEST_USER_EMAIL,
      passwordHash: hash,
      isAdmin: false,
      emailVerified: true,
      emailVerifiedAt: new Date()
    })

    // 3) 准备 vocab fixture: 15 个 Primary + A1/A2 词 (pickWords(limit=10) 才能返回 10 个)
    //    不依赖 VocabSeedService 实际跑没跑, 直接 insertMore 一次保险
    const fixtures: any[] = []
    for (let i = 0; i < 15; i++) {
      const cefr = i % 2 === 0 ? 'A1' : 'A2'
      fixtures.push({
        headword: `smokeword${i}`,
        lemma: `smokeword${i}`,
        pos: 'noun',
        cefr,
        freqRank: i + 1,
        definitionEn: `smoke test word ${i}`,
        definitionZh: `烟雾测试词 ${i}`,
        exampleEn: `Example for smokeword${i}.`,
        ipa: `/sməʊk${i}/`,
        levels: ['Primary'],
        topics: ['test']
      })
    }
    await vocabModel.insertMany(fixtures)
  }, 120000)  // beforeAll timeout: AppModule 初始化 + VocabSeed bulkWrite

  afterAll(async () => {
    // 删 test db, 不污染本地 dev
    try {
      const conn = vocabModel.db
      await conn.dropDatabase()
    } catch (e) { /* ignore */ }
    await app?.close()
  })

  // ================== test 1 ==================
  it('GET /api/health → 200, body { ok: true }', async () => {
    const res = await request(server).get('/api/health')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
  })

  // ================== test 2 ==================
  it('GET /api/admin/vocab 无 token → 401', async () => {
    // 旁路: 不带 Authorization header, 触发 AdminAuth() = JwtGuard + AdminGuard
    // 顺序: JwtGuard 先 throw 401 (没 token)
    const res = await request(server).get('/api/admin/vocab')
    expect(res.status).toBe(401)
  })

  // ================== test 3 ==================
  it('GET /api/admin/vocab-dev 无 token, NODE_ENV=development → 200', async () => {
    // NODE_ENV 已经设了 'development', 这个 controller 不带 @AdminAuth(), 应该 200
    const res = await request(server).get('/api/admin/vocab-dev')
    expect(res.status).toBe(200)
    // body 应该是 admin.getVocab() 的返回: { total, summary, words: [...] }
    expect(Array.isArray(res.body?.words)).toBe(true)
    expect(res.body.words.length).toBeGreaterThan(0)
  })

  // ================== test 4 ==================
  it('POST /api/auth/login 缺 password → 400', async () => {
    // ValidationPipe + IsString password 缺字段应该 throw 400
    const res = await request(server)
      .post('/api/auth/login')
      .send({ email: TEST_USER_EMAIL })
    expect(res.status).toBe(400)
  })

  // ================== test 5 ==================
  it('POST /api/auth/login 错误密码 → 401', async () => {
    const res = await request(server)
      .post('/api/auth/login')
      .send({ email: TEST_USER_EMAIL, password: 'wrong-password-123' })
    expect(res.status).toBe(401)
  })

  // ================== test 6 ==================
  it('vocab.service.ts pickWords(Primary) 返 10 词, 全部 levels 含 Primary, 全部 cefr A1/A2', async () => {
    // 走 NestJS TestingModule 直接拿 VocabService (同 app instance, vocabModel 已连)
    const vocabService = app.get(VocabService)
    const picked = await vocabService.pickWords('Primary', [], 10, 'test-seed-001')
    expect(picked).toHaveLength(10)
    for (const w of picked) {
      expect(w.levels).toContain('Primary')
      expect(['A1', 'A2']).toContain(w.cefr)
    }
  })
})
