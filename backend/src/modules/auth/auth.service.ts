import { Injectable, UnauthorizedException, BadRequestException, Inject } from '@nestjs/common'
import { InjectModel } from '@nestjs/mongoose'
import { Model } from 'mongoose'
import * as argon2 from 'argon2'
import * as jwt from 'jsonwebtoken'
import * as crypto from 'crypto'
import Redis from 'ioredis'
import { RefreshTokenDocument } from './refresh-token.schema'
import { UserDocument } from '../user/user.schema'
import { PetService } from '../pet/pet.service'
import { WalletService } from '../wallet/wallet.service'
import { MailService } from './mail.service'
import { REDIS } from '../../common/redis.provider'

export interface Tokens { accessToken: string; refreshToken: string }

@Injectable()
export class AuthService {
  constructor(
    @InjectModel('User') private userModel: Model<UserDocument>,
    @InjectModel('RefreshToken') private refreshModel: Model<RefreshTokenDocument>,
    @Inject(REDIS) private redis: Redis,
    private petService: PetService,
    private walletService: WalletService,
    private mailService: MailService
  ) { }

  private signTokens(userId: string): Tokens {
    const secret = process.env.JWT_SECRET || 'dev_secret'
    const accessToken = jwt.sign({ sub: userId, jti: this.randomId() }, secret, { expiresIn: '24h' })
    const refreshToken = jwt.sign({ sub: userId, jti: this.randomId() }, secret, { expiresIn: '30d' })
    return { accessToken, refreshToken }
  }

  private randomId() { return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2) }

  async sendVerificationCode(email: string, ip: string) {
    const ipKey = `verify:ip:${ip}`
    if (await this.redis.exists(ipKey)) {
      throw new BadRequestException('code_cooldown')
    }

    const cooldownKey = `verify:cooldown:${email}`
    if (await this.redis.exists(cooldownKey)) {
      throw new BadRequestException('code_cooldown')
    }

    const code = String(crypto.randomInt(100000, 999999))
    await this.redis.set(`verify:code:${email}`, code, 'EX', 300)
    await this.redis.set(cooldownKey, '1', 'EX', 60)
    await this.redis.set(ipKey, '1', 'EX', 60)
    await this.mailService.sendVerificationCode(email, code)

    return { ok: true }
  }

  async register(email: string, password: string, code: string) {
    try {
      const storedCode = await this.redis.get(`verify:code:${email}`)
      if (!storedCode) throw new BadRequestException('code_expired')
      if (storedCode !== code) throw new BadRequestException('code_mismatch')

      const exist = await this.userModel.findOne({ email }).lean()
      if (exist) throw new BadRequestException('email_exists')

      await this.redis.del(`verify:code:${email}`)

      // 2026-06-12: ADMIN_EMAIL 已从 .env 移除, prod 没有这条旁路
      // dev 模式 (NODE_ENV !== 'production') 可通过临时环境变量启用, 不进 .env
      const isAdmin =
        process.env.NODE_ENV !== 'production' && process.env.ADMIN_EMAIL === email
      const hash = await argon2.hash(password)
      const user = await this.userModel.create({
        email,
        passwordHash: hash,
        isAdmin,
        emailVerified: true,
        emailVerifiedAt: new Date()
      })

      await this.petService.createDefault(String(user._id))
      await this.walletService.createDefault(String(user._id))

      const tokens = this.signTokens(String(user._id))
      await this.storeRefresh(String(user._id), tokens.refreshToken)
      return { userId: String(user._id), ...tokens }
    } catch (e: any) { throw new BadRequestException(e?.message || 'register_failed') }
  }

  async login(email: string, password: string) {
    const user = await this.userModel.findOne({ email })
    if (!user) throw new UnauthorizedException('invalid_credentials')
    const ok = await argon2.verify(user.passwordHash, password)
    if (!ok) throw new UnauthorizedException('invalid_credentials')
    // 2026-06-12: 同上, prod 永不走 ADMIN_EMAIL 提权
    if (
      process.env.NODE_ENV !== 'production' &&
      process.env.ADMIN_EMAIL === email &&
      !user.isAdmin
    ) {
      await this.userModel.findByIdAndUpdate(user._id, { $set: { isAdmin: true } })
      user.isAdmin = true
    }
    const userId = String(user._id)
    const tokens = this.signTokens(userId)
    await this.storeRefresh(userId, tokens.refreshToken)
    return { userId, ...tokens }
  }

  async refresh(refreshToken: string) {
    const secret = process.env.JWT_SECRET || 'dev_secret'
    let payload: any
    try { payload = jwt.verify(refreshToken, secret) } catch { throw new UnauthorizedException('invalid_refresh_token') }
    const found = await this.refreshModel.findOne({ userId: payload.sub }).sort({ expiresAt: -1 })
    if (!found) throw new UnauthorizedException('refresh_not_found')
    const ok = await argon2.verify(found.tokenHash, refreshToken)
    if (!ok) throw new UnauthorizedException('invalid_refresh_token')
    const tokens = this.signTokens(payload.sub)
    await this.storeRefresh(payload.sub, tokens.refreshToken)
    return tokens
  }

  async sendResetCode(email: string, ip: string) {
    const user = await this.userModel.findOne({ email }).lean()
    if (!user) return { ok: true }

    const ipKey = `reset:ip:${ip}`
    if (await this.redis.exists(ipKey)) {
      throw new BadRequestException('code_cooldown')
    }

    const cooldownKey = `reset:cooldown:${email}`
    if (await this.redis.exists(cooldownKey)) {
      throw new BadRequestException('code_cooldown')
    }

    const code = String(crypto.randomInt(100000, 999999))
    await this.redis.set(`reset:code:${email}`, code, 'EX', 600)
    await this.redis.set(cooldownKey, '1', 'EX', 60)
    await this.redis.set(ipKey, '1', 'EX', 60)
    await this.mailService.sendResetCode(email, code)

    return { ok: true }
  }

  async resetPassword(email: string, code: string, newPassword: string) {
    const storedCode = await this.redis.get(`reset:code:${email}`)
    if (!storedCode) throw new BadRequestException('code_expired')
    if (storedCode !== code) throw new BadRequestException('code_mismatch')

    const user = await this.userModel.findOne({ email })
    if (!user) throw new BadRequestException('code_expired')

    await this.redis.del(`reset:code:${email}`)

    const hash = await argon2.hash(newPassword)
    await this.userModel.findByIdAndUpdate(user._id, { $set: { passwordHash: hash } })

    const userId = String(user._id)
    await this.refreshModel.deleteMany({ userId })

    const tokens = this.signTokens(userId)
    await this.storeRefresh(userId, tokens.refreshToken)
    return { userId, ...tokens }
  }

  async logout(userId: string) { await this.refreshModel.deleteMany({ userId }); return { ok: true } }

  private async storeRefresh(userId: string, token: string) {
    const exp = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)
    const hash = await argon2.hash(token)
    await this.refreshModel.create({ userId, tokenHash: hash, expiresAt: exp })
  }
}
