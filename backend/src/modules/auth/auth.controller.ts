import { Body, Controller, Post, UseGuards, Req } from '@nestjs/common'
import { AuthService } from './auth.service'
import { JwtGuard } from '../../common/jwt.guard'
import { RateLimit, RateLimitGuard } from '../../common/rate-limit.guard'
import { IsEmail, IsString, MinLength } from 'class-validator'
import { Request } from 'express'

class SendCodeDto { @IsEmail() email!: string }
class RegisterDto { @IsEmail() email!: string; @IsString() password!: string; @IsString() code!: string }
class LoginDto { @IsEmail() email!: string; @IsString() password!: string }
class RefreshDto { @IsString() refreshToken!: string }
class ForgotPasswordDto { @IsEmail() email!: string }
class ResetPasswordDto { @IsEmail() email!: string; @IsString() code!: string; @IsString() @MinLength(6) newPassword!: string }

@Controller('auth')
@UseGuards(RateLimitGuard)
export class AuthController {
  constructor(private auth: AuthService) {}

  // 验证码:每 IP/小时 10 次,每 IP/分钟 1 次(已有 Redis cooldown,这里再兜一层)
  @Post('send-code')
  @RateLimit({ namespace: 'auth-send-code', limit: 10, windowSec: 3600, identity: 'ip' })
  sendCode(@Body() body: SendCodeDto, @Req() req: Request) {
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      || req.socket.remoteAddress
      || '0.0.0.0'
    return this.auth.sendVerificationCode(body.email, ip)
  }

  // 注册:每 IP/小时 10 次(防脚本批量注册)
  @Post('register')
  @RateLimit({ namespace: 'auth-register', limit: 10, windowSec: 3600, identity: 'ip' })
  register(@Body() body: RegisterDto) { return this.auth.register(body.email, body.password, body.code) }

  // 登录:每 IP/小时 30 次,每 IP/分钟 8 次(防爆破)
  @Post('login')
  @RateLimit({ namespace: 'auth-login', limit: 8, windowSec: 60, identity: 'ip' })
  login(@Body() body: LoginDto) { return this.auth.login(body.email, body.password) }

  // refresh token:每 IP/小时 60 次
  @Post('refresh')
  @RateLimit({ namespace: 'auth-refresh', limit: 60, windowSec: 3600, identity: 'ip' })
  refresh(@Body() body: RefreshDto) { return this.auth.refresh(body.refreshToken) }

  // 登出:已登录用户,每小时 20 次
  @Post('logout') @UseGuards(JwtGuard) logout(@Req() req: any) { return this.auth.logout(req.user.id) }

  // 找回密码:每 IP/小时 5 次(严,避免邮件骚扰)
  @Post('forgot-password')
  @RateLimit({ namespace: 'auth-forgot', limit: 5, windowSec: 3600, identity: 'ip' })
  forgotPassword(@Body() body: ForgotPasswordDto, @Req() req: Request) {
    const ip = (req.headers['x-forwarded-for'] as string)?.split(',')[0]?.trim()
      || req.socket.remoteAddress
      || '0.0.0.0'
    return this.auth.sendResetCode(body.email, ip)
  }

  // 重置密码:每 IP/小时 10 次
  @Post('reset-password')
  @RateLimit({ namespace: 'auth-reset', limit: 10, windowSec: 3600, identity: 'ip' })
  resetPassword(@Body() body: ResetPasswordDto) {
    return this.auth.resetPassword(body.email, body.code, body.newPassword)
  }
}
