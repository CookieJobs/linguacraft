// input: @nestjs/common, ./admin.service, ../../common/admin.guard
// output: AdminController, route:admin
// pos: 后端/管理模块
// 若我被更新，请同步更新我的开头注释，以及所属文件夹的 README。
import { Controller, Get, Param, Put, Body, Req } from '@nestjs/common'
import { AdminService } from './admin.service'
import { AdminAuth } from '../../common/admin.guard'
import { IsBoolean } from 'class-validator'

class SetAdminDto { @IsBoolean() isAdmin!: boolean }

@Controller('admin')
@AdminAuth()
export class AdminController {
  constructor(private admin: AdminService) {}

  @Get('dashboard')
  async dashboard() {
    return this.admin.getDashboard()
  }

  @Get('vocab')
  async vocab() {
    return this.admin.getVocab()
  }

  // 2026-06-11: vocab-dev / audit-snapshot 移到独立 controller (admin-dev.controller.ts)
  // 原因: AdminController 类级别带 @AdminAuth(), 作用到所有方法, dev 旁路要"无 auth",
  //       必须独立类承载, 不能挂在 @AdminAuth() 下面

  @Get('users')
  async users() {
    return this.admin.getUsers()
  }

  @Get('users/:id')
  async userDetail(@Param('id') id: string) {
    const detail = await this.admin.getUserDetail(id)
    if (!detail) return { error: 'user_not_found' }
    return detail
  }

  @Put('users/:id/role')
  async setAdmin(@Param('id') id: string, @Body() body: SetAdminDto) {
    return this.admin.setAdmin(id, body.isAdmin)
  }
}
