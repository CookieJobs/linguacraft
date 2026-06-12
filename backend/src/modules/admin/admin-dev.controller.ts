// input: @nestjs/common, express, fs, ./admin.service
// output: AdminDevController, route:admin
// pos: 后端/管理模块
// 若我被更新，请同步更新我的开头注释，以及所属文件夹的 README。
//
// 2026-06-11: dev-only 旁路 controller
// - 不带 @AdminAuth() 装饰器 (类级别没有 guard), 方法本身也无需 token
// - 仅在 NODE_ENV !== 'production' 时开放, prod 调用直接 403
// - 用途: 体检页 (vocab-inspector.html) 在 dev 环境不需要粘贴 admin token
// - 安全约束: 每个方法内部必须做 NODE_ENV === 'production' 短路, 避免 prod 误暴露
//
// 为什么独立 controller: AdminController 有 @Controller('admin') + @AdminAuth() 类装饰器,
//   这些是 class-level, 作用到所有方法。vocab-dev / audit-snapshot 要"无 auth 调",
//   跟其他 admin endpoint 互斥, 必须放独立类。

import { Controller, Get, ForbiddenException, OnModuleInit, Res } from '@nestjs/common'
import type { Response } from 'express'
import * as fs from 'fs'
import { AdminService } from './admin.service'

@Controller('admin')
export class AdminDevController implements OnModuleInit {
  constructor(private admin: AdminService) {}

  /**
   * 2026-06-12: 启动时 dev 旁路 warn, 方便从日志快速识别
   * "该 prod 环境的日志里出现这行, 说明 NODE_ENV 没设 / 拼错了 — 立刻排查"
   */
  onModuleInit(): void {
    if (process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.warn(
        `[AdminDev] vocab-dev + audit-snapshot endpoints ENABLED (NODE_ENV=${process.env.NODE_ENV || 'undefined'})`,
      )
    }
  }

  /**
   * 体检页实时数据 (dev-only, 无需 token)
   * - 跟 /api/admin/vocab 数据完全一致
   * - 给本地 dev 体检页省去粘贴 admin token
   */
  @Get('vocab-dev')
  async vocabDev() {
    if (process.env.NODE_ENV === 'production') {
      throw new ForbiddenException('dev-only endpoint, disabled in production')
    }
    return this.admin.getVocab()
  }

  /**
   * 体检页本地快照源 (dev-only)
   * - 直接 serve /tmp/linguacraft-vocab-audit.json (audit-vocab.ts 脚本产物)
   * - 用法: backend dir 跑 `npx ts-node scripts/audit-vocab.ts` 生成快照
   * - 离线/无 admin token 时的最后兜底
   */
  @Get('audit-snapshot')
  async auditSnapshot(@Res() res: Response) {
    if (process.env.NODE_ENV === 'production') {
      throw new ForbiddenException('dev-only endpoint, disabled in production')
    }
    const snapshotPath = '/tmp/linguacraft-vocab-audit.json'
    if (!fs.existsSync(snapshotPath)) {
      res.status(404).json({
        error: 'snapshot_not_found',
        message: `${snapshotPath} 不存在, 请在 backend dir 跑: npx ts-node scripts/audit-vocab.ts`
      })
      return
    }
    res.setHeader('Content-Type', 'application/json')
    res.send(fs.readFileSync(snapshotPath))
  }
}
