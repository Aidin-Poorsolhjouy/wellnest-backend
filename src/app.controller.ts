import { Controller, Get } from '@nestjs/common';
import * as mqtt from 'mqtt';

@Controller()
export class AppController {

  @Get('mqtt-test')
  async testMqtt() {
    return new Promise((resolve) => {
      const client = mqtt.connect(process.env.HIVEMQ_URL!, {
        username: process.env.HIVEMQ_USERNAME,
        password: process.env.HIVEMQ_PASSWORD,
        rejectUnauthorized: true,
        connectTimeout: 10000,
      });

      const timer = setTimeout(() => {
        client.end(true);
        resolve({
          success: false,
          message: 'MQTT connection timeout',
        });
      }, 12000);

      client.on('connect', () => {
        clearTimeout(timer);
        client.end(true);

        resolve({
          success: true,
          message: 'Connected successfully to HiveMQ',
        });
      });

      client.on('error', (error) => {
        clearTimeout(timer);
        client.end(true);

        resolve({
          success: false,
          message: error.message,
        });
      });
    });
  }

  @Get('mqtt-env-check')
  checkMqttEnv() {
    return {
      url: process.env.HIVEMQ_URL,
      username: process.env.HIVEMQ_USERNAME,
      passwordSet: !!process.env.HIVEMQ_PASSWORD,
      passwordLength: process.env.HIVEMQ_PASSWORD?.length ?? 0,
    };
  }
}