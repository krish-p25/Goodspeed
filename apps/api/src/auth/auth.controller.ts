import { Controller, Get, Request, UseGuards } from '@nestjs/common'
import { AuthGuard } from './auth.guard'

@Controller('auth')
export class AuthController {
  @Get('me')
  @UseGuards(AuthGuard)
  getMe(@Request() req: any) {
    return {
      userId: req.user.id,
      email: req.user.email,
    }
  }
}
