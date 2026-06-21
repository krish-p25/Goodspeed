import {
  Controller,
  Get,
  Patch,
  Body,
  UseGuards,
} from '@nestjs/common'
import { AuthGuard } from '../auth/auth.guard'
import { SettingsService } from './settings.service'
import type { AiConfigSettings } from '@kb/types'

@Controller('settings')
@UseGuards(AuthGuard)
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

  @Get()
  getSettings() {
    return this.settingsService.read()
  }

  @Patch()
  updateSettings(@Body() body: AiConfigSettings) {
    this.settingsService.write(body)
    return { success: true, message: 'Settings saved. Changes take effect on the next request.' }
  }
}
