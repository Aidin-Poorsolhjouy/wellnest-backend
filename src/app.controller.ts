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

  @Get('mqtt-subscribe-test')
async testMqttSubscription() {
  return new Promise((resolve) => {
    const client = mqtt.connect(process.env.HIVEMQ_URL!, {
      username: process.env.HIVEMQ_USERNAME,
      password: process.env.HIVEMQ_PASSWORD,
      rejectUnauthorized: true,
      connectTimeout: 10000,
    });

    let finished = false;

    const finish = (result: any) => {
      if (finished) return;
      finished = true;

      clearTimeout(timeout);
      client.end(true);
      resolve(result);
    };

    const timeout = setTimeout(() => {
      finish({
        success: false,
        connected: client.connected,
        message: 'No MQTT message received within 30 seconds',
      });
    }, 30000);

    client.on('connect', () => {
      client.subscribe('wellnest/mvp/wearable', (err) => {
        if (err) {
          finish({
            success: false,
            connected: true,
            message: `Subscribe failed: ${err.message}`,
          });
        }
      });
    });

    client.on('message', (topic, payload) => {
      finish({
        success: true,
        connected: true,
        topic,
        payload: payload.toString(),
      });
    });

    client.on('error', (error) => {
      finish({
        success: false,
        connected: client.connected,
        message: error.message,
      });
    });

    client.on('close', () => {
      console.log('[MQTT TEST] connection closed');
    });
  });
}
}