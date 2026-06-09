// input: mongoose, ../src/modules/learning/user-word-progress.schema
// output: 无
// pos: 系统/通用
// 若我被更新,请同步更新我的开头注释,以及所属的文件夹的 README。
//
// 一次性迁移: 2026-06-08 给所有 UserWordProgress 文档补 SM-2 三个字段
//   - easeFactor (默认 2.5,下限 1.3)
//   - interval   (默认 0,实际会由 scheduler 在下次答题时覆盖)
//   - repetitions (默认 0)
//
// 已有数据(stage 0-3)怎么映射到 SM-2:
//   - stage 0: 全新,reps=0, EF=2.5, interval=0
//   - stage 1: reps=1, EF=2.5, interval=1
//   - stage 2: reps=2, EF=2.5, interval=6
//   - stage 3: reps=3, EF=2.6(刚掌握时 EF 略涨), interval=15 (近 2 周内巩固)
//
// 用 upsert + $set,只填缺失字段,不动已有值(如果未来想重置可以删了重跑)

import mongoose from 'mongoose'
import { UserWordProgressSchema } from '../src/modules/learning/user-word-progress.schema'

interface StageToSm2 {
  reps: number
  interval: number
  ef: number
}

function stageToSm2(stage: number): StageToSm2 {
  switch (stage) {
    case 0: return { reps: 0, interval: 0, ef: 2.5 }
    case 1: return { reps: 1, interval: 1, ef: 2.5 }
    case 2: return { reps: 2, interval: 6, ef: 2.5 }
    case 3: return { reps: 3, interval: 15, ef: 2.6 }
    default: return { reps: 0, interval: 0, ef: 2.5 }
  }
}

async function main() {
  const mongoUrl = process.env.MONGO_URL || 'mongodb://localhost:27017/linguacraft'
  await mongoose.connect(mongoUrl)
  const UserWordProgress = (mongoose.models.UserWordProgress ||
    mongoose.model('UserWordProgress', UserWordProgressSchema)) as mongoose.Model<any>

  const total = await UserWordProgress.countDocuments({})
  console.log(`[migrate-sm2] total UserWordProgress docs: ${total}`)

  const missingEf = await UserWordProgress.countDocuments({ easeFactor: { $exists: false } })
  const missingInterval = await UserWordProgress.countDocuments({ interval: { $exists: false } })
  const missingReps = await UserWordProgress.countDocuments({ repetitions: { $exists: false } })
  console.log(`[migrate-sm2] missing fields: easeFactor=${missingEf}, interval=${missingInterval}, repetitions=${missingReps}`)

  // 用 cursor 批量更新,避免一次性加载到内存
  const cursor = UserWordProgress.find({
    $or: [
      { easeFactor: { $exists: false } },
      { interval: { $exists: false } },
      { repetitions: { $exists: false } }
    ]
  } as any).cursor()

  let updated = 0
  for await (const doc of cursor as any) {
    const m = stageToSm2(doc.stage ?? 0)
    await UserWordProgress.updateOne(
      { _id: doc._id } as any,
      {
        $set: {
          easeFactor: m.ef,
          interval: m.interval,
          repetitions: m.reps
        }
      } as any
    )
    updated++
  }

  console.log(`[migrate-sm2] updated ${updated} docs`)
  await mongoose.disconnect()
}

main().catch((e) => {
  console.error('[migrate-sm2] failed:', e)
  process.exit(1)
})
