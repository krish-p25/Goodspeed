import 'reflect-metadata';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

// Walk up from dist/ to the monorepo root to load the shared .env
dotenv.config({ path: path.join(__dirname, '../../../.env') });

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  app.enableCors({
    origin: process.env.CORS_ORIGIN,
  });
  const port = process.env.PORT ?? 3010;
  await app.listen(port);
}

bootstrap();
