import 'dotenv/config';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import * as mqtt from 'mqtt';
import { PrismaService } from '../src/prisma/prisma.service';

const apiBase = (process.env.QA_API_BASE_URL || '').replace(/\/+$/, '');
const resultsDir = process.env.QA_RESULTS_DIR || path.resolve(process.cwd(), 'qa-results', 'reliability');
const brokerUrl = process.env.HIVEMQ_URL;
const username = process.env.HIVEMQ_USERNAME;
const password = process.env.HIVEMQ_PASSWORD;
const burstCount = Math.max(5, Number(process.env.QA_RELIABILITY_MESSAGES || 30));
fs.mkdirSync(resultsDir, { recursive: true });
if (!apiBase) throw new Error('QA_API_BASE_URL is required');
if (!brokerUrl || !username || !password) throw new Error('HiveMQ environment variables are required');

// Preserve the runtime validation above as concrete string types for strict
// TypeScript checks used by ts-node.
const mqttBrokerUrl: string = brokerUrl;
const mqttUsername: string = username;
const mqttPassword: string = password;

const prisma = new PrismaService();
const podId = randomUUID();
const wearableId = randomUUID();
const seniorId = randomUUID();
const stamp = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;

type Case = { id: string; name: string; status: 'PASS' | 'FAIL'; detail: string; durationMs?: number; expected?: number; actual?: number };
const results: Case[] = [];
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function cleanup() {
  try { await prisma.alerts.deleteMany({ where: { senior_id: seniorId } }); } catch {}
  try { await prisma.activity_events.deleteMany({ where: { device_id: wearableId } }); } catch {}
  try { await prisma.environmental_readings.deleteMany({ where: { device_id: podId } }); } catch {}
  try { await prisma.devices.deleteMany({ where: { id: { in: [podId, wearableId] } } }); } catch {}
  try { await prisma.users.deleteMany({ where: { id: seniorId } }); } catch {}
}

async function setup() {
  await prisma.users.create({ data: { id: seniorId, email: `qa-reliability-${stamp}@example.com`, first_name: 'QA', last_name: 'Reliability', role: 'SENIOR' } });
  await prisma.devices.createMany({ data: [
    { id: podId, serial_number: `QA-REL-POD-${stamp}`, type: 'POD', senior_id: seniorId, battery_level: 100 },
    { id: wearableId, serial_number: `QA-REL-WEAR-${stamp}`, type: 'WEARABLE', senior_id: seniorId, battery_level: 100 },
  ] });
}

async function publish(client: mqtt.MqttClient, topic: string, payload: unknown) {
  await new Promise<void>((resolve, reject) => client.publish(topic, typeof payload === 'string' ? payload : JSON.stringify(payload), { qos: 0 }, (err) => err ? reject(err) : resolve()));
}

async function waitForCount(expected: number, timeoutMs = 30000): Promise<number> {
  const started = Date.now();
  let count = 0;
  while (Date.now() - started < timeoutMs) {
    count = await prisma.environmental_readings.count({ where: { device_id: podId } });
    if (count >= expected) return count;
    await delay(350);
  }
  return count;
}

async function main() {
  await prisma.$connect();
  await cleanup();
  await setup();

  const client = mqtt.connect(mqttBrokerUrl, { username: mqttUsername, password: mqttPassword, rejectUnauthorized: true, reconnectPeriod: 0, connectTimeout: 10000, clientId: `wellnest-qa-rel-${stamp}` });
  try {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('MQTT connection timeout')), 12000);
      client.once('connect', () => { clearTimeout(timeout); resolve(); });
      client.once('error', (err) => { clearTimeout(timeout); reject(err); });
    });

    const malformedStarted = Date.now();
    await publish(client, 'wellnest/mvp/pod', '{not-json');
    await delay(900);
    const health = await axios.get(`${apiBase}/health`, { timeout: 15000 });
    results.push({
      id: 'REL-MQTT-001',
      name: 'Malformed MQTT payload does not crash backend',
      status: health.status === 200 && health.data?.status === 'ok' ? 'PASS' : 'FAIL',
      detail: `health HTTP ${health.status}`,
      durationMs: Date.now() - malformedStarted,
    });

    const base = Date.now() + 1000;
    const burstStarted = Date.now();
    for (let i = 0; i < burstCount; i++) {
      await publish(client, 'wellnest/mvp/pod', {
        deviceId: podId,
        timestamp: new Date(base + i).toISOString(),
        temperature: 21.5 + (i % 10) / 10,
        humidity: 44 + (i % 6),
        gasResistance: 115000 + i,
        airQualityScore: 74,
        occupancy: i % 2 === 0,
      });
    }
    const stored = await waitForCount(burstCount);
    results.push({
      id: 'REL-MQTT-002',
      name: 'MQTT burst delivery persists every message',
      status: stored === burstCount ? 'PASS' : 'FAIL',
      detail: `${stored}/${burstCount} rows persisted`,
      durationMs: Date.now() - burstStarted,
      expected: burstCount,
      actual: stored,
    });

    const dupTs = new Date(base + burstCount + 1000);
    const duplicatePayload = {
      deviceId: podId,
      timestamp: dupTs.toISOString(),
      temperature: 22,
      humidity: 45,
      gasResistance: 116000,
      airQualityScore: 75,
      occupancy: true,
    };
    await publish(client, 'wellnest/mvp/pod', duplicatePayload);
    await publish(client, 'wellnest/mvp/pod', duplicatePayload);
    await delay(1800);
    const duplicates = await prisma.environmental_readings.count({ where: { device_id: podId, recorded_at: dupTs } });
    results.push({
      id: 'REL-MQTT-003',
      name: 'Repeated MQTT delivery remains idempotent',
      status: duplicates === 1 ? 'PASS' : 'FAIL',
      detail: `rows for repeated timestamp: ${duplicates}`,
      expected: 1,
      actual: duplicates,
    });

    client.end(true);
    await delay(400);
    const reconnectStarted = Date.now();
    const second = mqtt.connect(mqttBrokerUrl, { username: mqttUsername, password: mqttPassword, rejectUnauthorized: true, reconnectPeriod: 0, connectTimeout: 10000, clientId: `wellnest-qa-rel2-${stamp}` });
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('MQTT reconnect timeout')), 12000);
      second.once('connect', () => { clearTimeout(timeout); resolve(); });
      second.once('error', (err) => { clearTimeout(timeout); reject(err); });
    });
    const reconnectTs = new Date(base + burstCount + 2000);
    await publish(second, 'wellnest/mvp/wearable', { deviceId: wearableId, timestamp: reconnectTs.toISOString(), eventType: 'REGULAR_MOVEMENT' });
    let eventFound = false;
    for (let i = 0; i < 40; i++) {
      const storedEvent = await prisma.activity_events.findFirst({
        where: { device_id: wearableId, type: 'REGULAR_MOVEMENT', recorded_at: reconnectTs },
      });
      if (storedEvent) {
        eventFound = true;
        break;
      }
      await delay(350);
    }
    second.end(true);
    results.push({
      id: 'REL-MQTT-004',
      name: 'Fresh MQTT client reconnect path still ingests telemetry',
      status: eventFound ? 'PASS' : 'FAIL',
      detail: eventFound ? 'movement event persisted after reconnect' : 'movement event missing',
      durationMs: Date.now() - reconnectStarted,
    });
  } finally {
    try { client.end(true); } catch {}
    await cleanup();
    await prisma.$disconnect();
  }

  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.length - passed;
  const output = { runAt: new Date().toISOString(), summary: { total: results.length, passed, failed, burstCount }, results };
  fs.writeFileSync(path.join(resultsDir, 'reliability-results.json'), JSON.stringify(output, null, 2));
  fs.writeFileSync(path.join(resultsDir, 'reliability-results.csv'), ['id,name,status,durationMs,expected,actual,detail']
    .concat(results.map((r) => [r.id, r.name, r.status, r.durationMs ?? '', r.expected ?? '', r.actual ?? '', r.detail].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')))
    .join('\n'));
  console.log(JSON.stringify(output, null, 2));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  try { await cleanup(); } catch {}
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
