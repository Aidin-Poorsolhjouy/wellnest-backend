import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { AppModule } from './app.module';

process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

async function bootstrap() {
  try {
    const app = await NestFactory.create(AppModule);

    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );

    const configuredOrigins = (
      process.env.CORS_ORIGINS || 'https://app.wellnest.one'
    )
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);

    if (process.env.NODE_ENV !== 'production') {
      configuredOrigins.push(
        'http://localhost:3000',
        'http://127.0.0.1:3000',
      );
    }

    const allowedOrigins = new Set(configuredOrigins);

    app.enableCors({
      origin: (origin, callback) => {
        // Non-browser callers such as server-to-server tests have no Origin header.
        if (!origin || allowedOrigins.has(origin)) {
          callback(null, true);
          return;
        }

        // Return the response without authorizing the browser origin.
        callback(null, false);
      },
      credentials: true,
      methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-WellNest-Telemetry-Key',
      ],
    });

    const config = new DocumentBuilder()
      .setTitle('WellNest API')
      .setDescription('The core backend engine for the WellNest ecosystem')
      .setVersion('1.0')
      .addBearerAuth()
      .addApiKey(
        { type: 'apiKey', in: 'header', name: 'X-WellNest-Telemetry-Key' },
        'telemetry-key',
      )
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);

    app.connectMicroservice<MicroserviceOptions>({
      transport: Transport.MQTT,
      options: {
        url: process.env.HIVEMQ_URL,
        username: process.env.HIVEMQ_USERNAME,
        password: process.env.HIVEMQ_PASSWORD,
        rejectUnauthorized: true,
      },
    });

    const port = Number(process.env.PORT) || 3000;
    await app.listen(port, '0.0.0.0');

    try {
      await app.startAllMicroservices();
      console.log('[MQTT] Connected successfully to HiveMQ');
    } catch (err) {
      console.error('[MQTT] Could not connect to HiveMQ', err);
      // REST API remains available even if MQTT is temporarily unavailable.
    }

    console.log(`[WellNest] HTTP server listening on ${port}`);
    console.log('[WellNest] Swagger available at /api/docs');
  } catch (err) {
    console.error('[FATAL BOOT ERROR]', err);
    process.exit(1);
  }
}

bootstrap();
