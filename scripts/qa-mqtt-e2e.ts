import 'dotenv/config';
import * as mqtt from 'mqtt';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';

const brokerUrl = process.env.HIVEMQ_URL;
const username = process.env.HIVEMQ_USERNAME;
const password = process.env.HIVEMQ_PASSWORD;
const resultsDir = process.env.QA_RESULTS_DIR || path.resolve(process.cwd(), 'qa-results');

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
const stamp = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
const seniorId = randomUUID();
const podId = randomUUID();
const wearableId = randomUUID();

interface Result {
  id: string;
  name: string;
  status: 'PASS' | 'FAIL';
  detail: string;
  latencyMs?: number;
}
const results: Result[] = [];

function delay(ms: number) { return new Promise((resolve) => setTimeout(resolve, ms)); }
function publish(client: mqtt.MqttClient, topic: string, payload: object): Promise<void> {
  return new Promise((resolve, reject) => {
    client.publish(topic, JSON.stringify(payload), { qos: 1 }, (error) => error ? reject(error) : resolve());
  });
}

async function setupFixtures() {
  await prisma.users.create({
    data: { id: seniorId, email: `qa-mqtt-${stamp}@example.com`, first_name: 'QA', last_name: 'MQTT', role: 'SENIOR' },
  });
  await prisma.devices.createMany({
    data: [
      { id: podId, serial_number: `QA-MQTT-POD-${stamp}`, type: 'POD', senior_id: seniorId, battery_level: 100 },
      { id: wearableId, serial_number: `QA-MQTT-WEAR-${stamp}`, type: 'WEARABLE', senior_id: seniorId, battery_level: 100 },
    ],
  });
}

async function cleanupFixtures() {
  try { await prisma.alerts.deleteMany({ where: { senior_id: seniorId } }); } catch {}
  try { await prisma.activity_events.deleteMany({ where: { device_id: wearableId } }); } catch {}
  try { await prisma.environmental_readings.deleteMany({ where: { device_id: podId } }); } catch {}
  try { await prisma.devices.deleteMany({ where: { id: { in: [podId, wearableId] } } }); } catch {}
  try { await prisma.users.deleteMany({ where: { id: seniorId } }); } catch {}
}

async function waitForPod(timestamp: Date, timeoutMs = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const row = await prisma.environmental_readings.findFirst({ where: { device_id: podId, recorded_at: timestamp } });
    if (row) return { row, latencyMs: Date.now() - started };
    await delay(400);
  }
  return null;
}

async function waitForWearable(eventType: any, timestamp: Date, timeoutMs = 25000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const row = await prisma.activity_events.findFirst({ where: { device_id: wearableId, type: eventType, recorded_at: timestamp } });
    if (row) return { row, latencyMs: Date.now() - started };
    await delay(400);
  }
  return null;
}

async function waitForAlert(title: string, timeoutMs = 10000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const row = await prisma.alerts.findFirst({
      where: { senior_id: seniorId, title, status: 'ACTIVE' },
    });
    if (row) return { row, latencyMs: Date.now() - started };
    await delay(250);
  }
  return null;
}

async function main() {
  await prisma.$connect();
  await cleanupFixtures();
  await setupFixtures();

  const client = mqtt.connect(brokerUrl!, {
    username,
    password,
    rejectUnauthorized: true,
    connectTimeout: 10000,
    reconnectPeriod: 0,
    clientId: `wellnest-qa-${stamp}`,
  });

  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('MQTT connection timeout')), 12000);
      client.once('connect', () => { clearTimeout(timeout); resolve(); });
      client.once('error', (error) => { clearTimeout(timeout); reject(error); });
    });

    const base = Date.now();
    const podTimestamp = new Date(base + 101);
    const movementTimestamp = new Date(base + 102);
    const fallTimestamp = new Date(base + 103);

    const podPublishedAt = Date.now();
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
    results.push(pod
      ? { id: 'MQTT-POD-001', name: 'Pod MQTT → backend → DB', status: 'PASS', detail: 'Pod MQTT payload persisted', latencyMs: Date.now() - podPublishedAt }
      : { id: 'MQTT-POD-001', name: 'Pod MQTT → backend → DB', status: 'FAIL', detail: 'Pod payload not found within timeout' });

    const movementPublishedAt = Date.now();
    await publish(client, 'wellnest/mvp/wearable', {
      deviceId: wearableId,
      timestamp: movementTimestamp.toISOString(),
      eventType: 'REGULAR_MOVEMENT',
    });
    const movement = await waitForWearable('REGULAR_MOVEMENT', movementTimestamp);
    results.push(movement
      ? { id: 'MQTT-WEAR-001', name: 'Wearable movement MQTT → backend → DB', status: 'PASS', detail: 'Movement event persisted', latencyMs: Date.now() - movementPublishedAt }
      : { id: 'MQTT-WEAR-001', name: 'Wearable movement MQTT → backend → DB', status: 'FAIL', detail: 'Movement event not found within timeout' });

    const fallPublishedAt = Date.now();
    await publish(client, 'wellnest/mvp/wearable', {
      deviceId: wearableId,
      timestamp: fallTimestamp.toISOString(),
      eventType: 'FALL',
    });
    const fall = await waitForWearable('FALL', fallTimestamp);
    // The activity event is inserted before triggerAlert() completes, so poll for
    // the alert separately instead of racing the backend immediately after the
    // event becomes visible in PostgreSQL.
    const fallAlert = await waitForAlert('🚨 CRITICAL: Fall Detected');
    results.push(fall && fallAlert
      ? { id: 'MQTT-WEAR-002', name: 'Wearable FALL MQTT → DB + alert', status: 'PASS', detail: 'FALL event and alert persisted', latencyMs: Date.now() - fallPublishedAt }
      : { id: 'MQTT-WEAR-002', name: 'Wearable FALL MQTT → DB + alert', status: 'FAIL', detail: `fall=${!!fall}, alert=${!!fallAlert}` });

    await publish(client, 'wellnest/mvp/pod', {
      deviceId: podId,
      timestamp: podTimestamp.toISOString(),
      temperature: 22.4,
      humidity: 47,
      gasResistance: 120000,
      airQualityScore: 75,
      occupancy: true,
    });
    await delay(1200);
    const duplicateCount = await prisma.environmental_readings.count({ where: { device_id: podId, recorded_at: podTimestamp } });
    results.push({
      id: 'MQTT-POD-002',
      name: 'Duplicate MQTT Pod payload deduplicated',
      status: duplicateCount === 1 ? 'PASS' : 'FAIL',
      detail: `database rows for exact timestamp: ${duplicateCount}`,
    });
  } finally {
    client.end(true);
    await cleanupFixtures();
    await prisma.$disconnect();
  }

  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.length - passed;
  const output = {
    runAt: new Date().toISOString(),
    brokerHost: new URL(brokerUrl!).host,
    summary: { total: results.length, passed, failed },
    results,
  };
  fs.writeFileSync(path.join(resultsDir, 'mqtt-e2e-results.json'), JSON.stringify(output, null, 2));
  const csv = ['id,name,status,latencyMs,detail']
    .concat(results.map((r) => [r.id, r.name, r.status, r.latencyMs ?? '', r.detail]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')))
    .join('\n');
  fs.writeFileSync(path.join(resultsDir, 'mqtt-e2e-results.csv'), csv);
  console.log(JSON.stringify(output, null, 2));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  try { await cleanupFixtures(); } catch {}
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
