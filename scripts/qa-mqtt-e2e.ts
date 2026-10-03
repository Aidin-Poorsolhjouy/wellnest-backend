import 'dotenv/config';
import * as mqtt from 'mqtt';
import fs from 'fs';
import path from 'path';
import { PrismaService } from '../src/prisma/prisma.service';

const podId = process.env.QA_POD_ID;
const wearableId = process.env.QA_WEARABLE_ID;
const brokerUrl = process.env.HIVEMQ_URL;
const username = process.env.HIVEMQ_USERNAME;
const password = process.env.HIVEMQ_PASSWORD;
const resultsDir = process.env.QA_RESULTS_DIR || path.resolve(process.cwd(), 'qa-results');

if (!podId || !wearableId) {
  console.error('QA_POD_ID and QA_WEARABLE_ID are required.');
  process.exit(2);
}
if (!brokerUrl || !username || !password) {
  console.error('HIVEMQ_URL, HIVEMQ_USERNAME and HIVEMQ_PASSWORD are required.');
  process.exit(2);
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is required for persistence verification.');
  process.exit(2);
}

fs.mkdirSync(resultsDir, { recursive: true });

const prisma = new PrismaService();

interface Result {
  id: string;
  status: 'PASS' | 'FAIL';
  detail: string;
  latencyMs?: number;
}

const results: Result[] = [];

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function publish(client: mqtt.MqttClient, topic: string, payload: object): Promise<void> {
  return new Promise((resolve, reject) => {
    client.publish(topic, JSON.stringify(payload), { qos: 1 }, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

async function waitForPod(timestamp: Date, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const row = await prisma.environmental_readings.findFirst({
      where: { device_id: podId, recorded_at: timestamp },
    });
    if (row) return { row, latencyMs: Date.now() - started };
    await delay(500);
  }
  return null;
}

async function waitForWearable(eventType: any, timestamp: Date, timeoutMs = 20000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const row = await prisma.activity_events.findFirst({
      where: { device_id: wearableId, type: eventType, recorded_at: timestamp },
    });
    if (row) return { row, latencyMs: Date.now() - started };
    await delay(500);
  }
  return null;
}

async function main() {
  await prisma.$connect();

  const client = mqtt.connect(brokerUrl, {
    username,
    password,
    rejectUnauthorized: true,
    connectTimeout: 10000,
    reconnectPeriod: 0,
  });

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('MQTT connection timeout')), 12000);
    client.once('connect', () => {
      clearTimeout(timeout);
      resolve();
    });
    client.once('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });

  const base = Date.now();
  const podTimestamp = new Date(base + 101);
  const movementTimestamp = new Date(base + 102);
  const fallTimestamp = new Date(base + 103);

  await publish(client, 'wellnest/mvp/pod', {
    deviceId: podId,
    timestamp: podTimestamp.toISOString(),
    temperature: 22.4,
    humidity: 47,
    gasResistance: 120000,
    airQualityScore: 75,
    occupancy: true,
  });
  const pod = await waitForPod(podTimestamp);
  results.push(
    pod
      ? { id: 'MQTT-POD-001', status: 'PASS', detail: 'Pod MQTT payload persisted', latencyMs: pod.latencyMs }
      : { id: 'MQTT-POD-001', status: 'FAIL', detail: 'Pod MQTT payload was not found in database within timeout' },
  );

  await publish(client, 'wellnest/mvp/wearable', {
    deviceId: wearableId,
    timestamp: movementTimestamp.toISOString(),
    eventType: 'REGULAR_MOVEMENT',
  });
  const movement = await waitForWearable('REGULAR_MOVEMENT', movementTimestamp);
  results.push(
    movement
      ? { id: 'MQTT-WEAR-001', status: 'PASS', detail: 'Regular movement MQTT event persisted', latencyMs: movement.latencyMs }
      : { id: 'MQTT-WEAR-001', status: 'FAIL', detail: 'Regular movement event was not found in database within timeout' },
  );

  await publish(client, 'wellnest/mvp/wearable', {
    deviceId: wearableId,
    timestamp: fallTimestamp.toISOString(),
    eventType: 'FALL',
  });
  const fall = await waitForWearable('FALL', fallTimestamp);
  results.push(
    fall
      ? { id: 'MQTT-WEAR-002', status: 'PASS', detail: 'FALL MQTT event persisted', latencyMs: fall.latencyMs }
      : { id: 'MQTT-WEAR-002', status: 'FAIL', detail: 'FALL event was not found in database within timeout' },
  );

  client.end(true);
  await prisma.$disconnect();

  const output = {
    runAt: new Date().toISOString(),
    brokerUrl,
    summary: {
      total: results.length,
      passed: results.filter((r) => r.status === 'PASS').length,
      failed: results.filter((r) => r.status === 'FAIL').length,
    },
    results,
  };

  const outputPath = path.join(resultsDir, 'mqtt-e2e-results.json');
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
  console.log(`MQTT E2E results written to ${outputPath}`);

  process.exit(output.summary.failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  try {
    await prisma.$disconnect();
  } catch {}
  process.exit(1);
});
