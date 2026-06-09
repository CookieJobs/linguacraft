import { Module } from '@nestjs/common'
import { MongooseModule } from '@nestjs/mongoose'
import { AuthController } from './auth.controller'
import { AuthService } from './auth.service'
import { MailService } from './mail.service'
import { RefreshTokenSchema } from './refresh-token.schema'
import { UserSchema } from '../user/user.schema'
import { JwtGuard } from '../../common/jwt.guard'
import { PetModule } from '../pet/pet.module'
import { WalletModule } from '../wallet/wallet.module'

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: 'User', schema: UserSchema },
      { name: 'RefreshToken', schema: RefreshTokenSchema }
    ]),
    PetModule,
    WalletModule
  ],
  controllers: [AuthController],
  providers: [AuthService, MailService, JwtGuard]
})
export class AuthModule {}
