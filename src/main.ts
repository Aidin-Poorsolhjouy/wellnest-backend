import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import 'dotenv/config';

// Catch unexpected Node-level failures
process.on('uncaughtException', (err) => {
  console.error('[UNCAUGHT EXCEPTION]', err);
});

process.on('unhandledRejection', (reason) => {
  console.error('[UNHANDLED REJECTION]', reason);
});

async function bootstrap() {
  try {
    console.log('[BOOT 1] Starting WellNest backend...');

    console.log('[ENV] PORT:', process.env.PORT || 'not set - using 3000');
    console.log('[ENV] DATABASE_URL exists:', !!process.env.DATABASE_URL);
    console.log('[ENV] SUPABASE_URL exists:', !!process.env.SUPABASE_URL);
    console.log(
      '[ENV] SUPABASE_SERVICE_ROLE_KEY exists:',
      !!process.env.SUPABASE_SERVICE_ROLE_KEY,
    );
    console.log('[ENV] HIVEMQ_URL exists:', !!process.env.HIVEMQ_URL);
    console.log(
      '[ENV] HIVEMQ_USERNAME exists:',
      !!process.env.HIVEMQ_USERNAME,
    );
    console.log(
      '[ENV] HIVEMQ_PASSWORD exists:',
      !!process.env.HIVEMQ_PASSWORD,
    );

    console.log('[BOOT 2] Creating Nest application...');

    const app = await NestFactory.create(AppModule);

    console.log('[BOOT 3] Nest application created');

    // Global validation
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
      }),
    );

    console.log('[BOOT 4] Validation configured');

    // CORS
    app.enableCors();

    console.log('[BOOT 5] CORS enabled');

    // Swagger
    const config = new DocumentBuilder()
      .setTitle('WellNest API')
      .setDescription('The core backend engine for the WellNest ecosystem')
      .setVersion('1.0')
      .addBearerAuth()
      .build();

    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);

    console.log('[BOOT 6] Swagger configured at /api/docs');

    // MQTT
    app.connectMicroservice<MicroserviceOptions>({
      transport: Transport.MQTT,
      options: {
        url: process.env.HIVEMQ_URL,
        username: process.env.HIVEMQ_USERNAME,
        password: process.env.HIVEMQ_PASSWORD,
        rejectUnauthorized: true,
      },
    });

    console.log('[BOOT 7] MQTT microservice configured');

    // Start HTTP server FIRST
    const port = Number(process.env.PORT) || 3000;

    console.log(`[BOOT 8] Attempting HTTP listen on port ${port}...`);

    await app.listen(port, '0.0.0.0');

    console.log(`[BOOT 9] HTTP server successfully listening on port ${port}`);
    console.log(`[BOOT 9] Swagger available at /api/docs`);

    // Start MQTT after HTTP is already available
    try {
      console.log('[MQTT 1] Attempting HiveMQ connection...');

      await app.startAllMicroservices();

      console.log('[MQTT 2] Connected successfully to HiveMQ');
    } catch (err) {
      console.error('[MQTT ERROR] Could not connect to HiveMQ');
      console.error(err);

      // Do NOT exit:
      // REST API can still run if MQTT fails.
    }

    console.log('[BOOT 10] WellNest bootstrap complete');
  } catch (err) {
    console.error('======================================');
    console.error('[FATAL BOOT ERROR]');
    console.error(err);

    if (err instanceof Error) {
      console.error('Message:', err.message);
      console.error('Stack:', err.stack);
    }

    console.error('======================================');

    process.exit(1);
  }
}

bootstrap();

// import { NestFactory } from '@nestjs/core';
// import { AppModule } from './app.module';
// import { ValidationPipe } from '@nestjs/common';
// import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
// import { MicroserviceOptions, Transport } from '@nestjs/microservices';
// import 'dotenv/config';

// async function bootstrap() {
//   const app = await NestFactory.create(AppModule);

//   // 1. Enable strict validation globally
//   app.useGlobalPipes(
//     new ValidationPipe({
//       whitelist: true, // Strips away any extra data not defined in the DTO
//       forbidNonWhitelisted: true, // Throws an error if extra data is sent
//       transform: true, // Automatically transforms payloads to DTO instances
//     }),
//   );

//   // 2. Enable CORS for our Next.js frontend
//   app.enableCors();

//   // 3. Set up Swagger API Documentation
//   const config = new DocumentBuilder()
//     .setTitle('WellNest API')
//     .setDescription('The core backend engine for the WellNest ecosystem')
//     .setVersion('1.0')
//     .addBearerAuth() // For Supabase JWTs later
//     .build();
//   const document = SwaggerModule.createDocument(app, config);
//   SwaggerModule.setup('api/docs', app, document);

//   // 4. CONNECT THE MQTT MICROSERVICE
//   // --- UPDATED: Connect to your Private HiveMQ Cloud ---
//   app.connectMicroservice<MicroserviceOptions>({
//     transport: Transport.MQTT,
//     options: {
//       // Use mqtts:// for TLS encryption on port 8883
//       url: 'mqtts://a028e3b476d84c00bea041679552f1da.s1.eu.hivemq.cloud:8883',
//       username: 'wellnest_pod',
//       password: 'Bubble@iot@2025!',
//       // This mimics the tls_insecure_set(True) from your Python script
//       rejectUnauthorized: false, 
//     },
//   });

//   // 1. LISTEN TO HTTP FIRST so Nginx gets an immediate response
//   const port = process.env.PORT || 3000;
//   await app.listen(port);
//   console.log(`🚀 HTTP Server running on port: ${port}`);
//   console.log(`Swagger Docs available at: /api/docs`);

//   // 2. Start MQTT in the background without blocking the HTTP server
//   try {
//     await app.startAllMicroservices();
//     console.log(`📡 MQTT Microservice connected to HiveMQ`);
//   } catch (err) {
//     console.error(`⚠️ MQTT connection failed or port blocked:`);
//   }
  
//   console.log(`Application is running on: http://localhost:3000`);
//   console.log(`Swagger Docs available at: http://localhost:3000/api/docs`);
// }
// bootstrap();
