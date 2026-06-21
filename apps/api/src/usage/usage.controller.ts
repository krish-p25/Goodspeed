import { Controller, Get, Query, Request, UseGuards } from '@nestjs/common'
import { AuthGuard } from '../auth/auth.guard'
import { TokenUsageService } from './token-usage.service'
import type { TokenUsagePeriod } from '@kb/types'

@Controller('usage')
@UseGuards(AuthGuard)
export class UsageController {
  constructor(private readonly tokenUsage: TokenUsageService) {}

  @Get('summary')
  getSummary(
    @Query('period') period: string = 'month',
    @Request() req: any,
  ) {
    const validPeriods: TokenUsagePeriod[] = ['today', 'week', 'month']
    const safePeriod: TokenUsagePeriod = validPeriods.includes(
      period as TokenUsagePeriod,
    )
      ? (period as TokenUsagePeriod)
      : 'month'

    return this.tokenUsage.getSummary(req.user.id, safePeriod)
  }
}
