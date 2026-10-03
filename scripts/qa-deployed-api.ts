import 'dotenv/config';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';

const apiBase = (process.env.QA_API_BASE_URL || 'https://wellnest-backend-production-8e06.up.railway.app').replace(/\/+$/, '');
const resultsDir = process.env.QA_RESULTS_DIR || path.resolve(process.cwd(), 'qa-results');
fs.mkdirSync(resultsDir, { recursive: true });

const prisma = new PrismaService();

type Status = 'PASS' | 'FAIL';
interface CaseResult {
  id: string;
  name: string;
  status: Status;
  expected: string;
  actual: string;
  durationMs: number;
  httpStatus?: number;
}

const results: CaseResult[] = [];
const stamp = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
const seniorId = randomUUID();
const podId = randomUUID();
const wearableId = randomUUID();

function addResult(result: CaseResult) {
  results.push(result);
  const mark = result.status === 'PASS' ? 'PASS' : 'FAIL';
  console.log(`[${mark}] ${result.id} ${result.name} (${result.durationMs} ms)`);
}

async function httpCase(
  id: string,
  name: string,
  expected: string,
  fn: () => Promise<{ status?: number; actual: string; ok: boolean }>,
) {
  const started = Date.now();
  try {
    const out = await fn();
    addResult({
      id,
      name,
      status: out.ok ? 'PASS' : 'FAIL',
      expected,
      actual: out.actual,
      durationMs: Date.now() - started,
      httpStatus: out.status,
    });
  } catch (error: any) {
    addResult({
      id,
      name,
      status: 'FAIL',
      expected,
      actual: error?.response ? `HTTP ${error.response.status}: ${JSON.stringify(error.response.data)}` : error.message,
      durationMs: Date.now() - started,
      httpStatus: error?.response?.status,
    });
  }
}

async function setupFixtures() {
  await prisma.users.create({
    data: {
      id: seniorId,
      email: `qa-senior-${stamp}@example.com`,
      first_name: 'QA',
      last_name: 'Senior',
      role: 'SENIOR',
    },
  });

  await prisma.devices.createMany({
    data: [
      {
        id: podId,
        serial_number: `QA-POD-${stamp}`,
        type: 'POD',
        senior_id: seniorId,
        battery_level: 100,
      },
      {
        id: wearableId,
        serial_number: `QA-WEAR-${stamp}`,
        type: 'WEARABLE',
        senior_id: seniorId,
        battery_level: 100,
      },
    ],
  });

  await prisma.thresholds.create({
    data: {
      metric: 'TEMPERATURE',
      min_value: 15,
      max_value: 30,
      senior_id: seniorId,
    },
  });
}

async function cleanupFixtures() {
  try { await prisma.alerts.deleteMany({ where: { senior_id: seniorId } }); } catch {}
  try { await prisma.thresholds.deleteMany({ where: { senior_id: seniorId } }); } catch {}
  try { await prisma.activity_events.deleteMany({ where: { device_id: wearableId } }); } catch {}
  try { await prisma.environmental_readings.deleteMany({ where: { device_id: podId } }); } catch {}
  try { await prisma.devices.deleteMany({ where: { id: { in: [podId, wearableId] } } }); } catch {}
  try { await prisma.users.deleteMany({ where: { id: seniorId } }); } catch {}
}

async function main() {
  await prisma.$connect();
  await cleanupFixtures();
  await setupFixtures();

  try {
    await httpCase('DEP-API-001', 'Deployed health endpoint', 'HTTP 200 with WellNest health payload', async () => {
      const response = await axios.get(`${apiBase}/health`, { timeout: 15000 });
      const ok = response.status === 200 && response.data?.status === 'ok' && response.data?.service === 'wellnest-backend';
      return { status: response.status, actual: JSON.stringify(response.data), ok };
    });

    await httpCase('DEP-API-002', 'Swagger UI reachable', 'HTTP 200', async () => {
      const response = await axios.get(`${apiBase}/api/docs`, { timeout: 15000, responseType: 'text' });
      return { status: response.status, actual: `HTTP ${response.status}`, ok: response.status === 200 };
    });

    await httpCase('DEP-POD-VAL-001', 'Pod rejects invalid UUID', 'HTTP 400', async () => {
      try {
        await axios.post(`${apiBase}/telemetry/pod`, { deviceId: 'not-a-uuid', temperature: 22, humidity: 45 }, { timeout: 15000 });
        return { actual: 'Request unexpectedly accepted', ok: false };
      } catch (error: any) {
        return { status: error.response?.status, actual: `HTTP ${error.response?.status}`, ok: error.response?.status === 400 };
      }
    });

    await httpCase('DEP-POD-VAL-002', 'Pod rejects unexpected property', 'HTTP 400', async () => {
      try {
        await axios.post(`${apiBase}/telemetry/pod`, {
          deviceId: podId,
          temperature: 22,
          humidity: 45,
          unexpectedField: 'should-fail',
        }, { timeout: 15000 });
        return { actual: 'Request unexpectedly accepted', ok: false };
      } catch (error: any) {
        return { status: error.response?.status, actual: `HTTP ${error.response?.status}`, ok: error.response?.status === 400 };
      }
    });

    await httpCase('DEP-POD-VAL-003', 'Pod rejects unknown device', 'HTTP 404', async () => {
      try {
        await axios.post(`${apiBase}/telemetry/pod`, {
          deviceId: randomUUID(),
          temperature: 22,
          humidity: 45,
        }, { timeout: 15000 });
        return { actual: 'Request unexpectedly accepted', ok: false };
      } catch (error: any) {
        return { status: error.response?.status, actual: `HTTP ${error.response?.status}`, ok: error.response?.status === 404 };
      }
    });

    const podTs = new Date(Date.now() + 101).toISOString();
    await httpCase('DEP-POD-001', 'Valid Pod telemetry persists to database', 'HTTP 201 and matching DB row', async () => {
      const response = await axios.post(`${apiBase}/telemetry/pod`, {
        deviceId: podId,
        timestamp: podTs,
        temperature: 22.6,
        humidity: 48.5,
        gasResistance: 111000,
        airQualityScore: 74,
        occupancy: true,
      }, { timeout: 15000 });
      const row = await prisma.environmental_readings.findFirst({ where: { device_id: podId, recorded_at: new Date(podTs) } });
      const ok = response.status === 201 && !!row && Number(row.temperature) === 22.6 && row.occupancy === true;
      return { status: response.status, actual: row ? `stored ${row.id}` : 'DB row missing', ok };
    });

    await httpCase('DEP-POD-002', 'Duplicate Pod telemetry is deduplicated', 'Second request accepted as duplicate and only one DB row exists', async () => {
      const response = await axios.post(`${apiBase}/telemetry/pod`, {
        deviceId: podId,
        timestamp: podTs,
        temperature: 22.6,
        humidity: 48.5,
        gasResistance: 111000,
        airQualityScore: 74,
        occupancy: true,
      }, { timeout: 15000 });
      const count = await prisma.environmental_readings.count({ where: { device_id: podId, recorded_at: new Date(podTs) } });
      const ok = response.status === 201 && response.data?.duplicate === true && count === 1;
      return { status: response.status, actual: `duplicate=${response.data?.duplicate}, dbCount=${count}`, ok };
    });

    const highTempTs = new Date(Date.now() + 102).toISOString();
    await httpCase('DEP-ALERT-001', 'High temperature generates alert', 'High Temperature Alert stored for QA senior', async () => {
      const response = await axios.post(`${apiBase}/telemetry/pod`, {
        deviceId: podId,
        timestamp: highTempTs,
        temperature: 38.2,
        humidity: 45,
        gasResistance: 110000,
        airQualityScore: 70,
        occupancy: true,
      }, { timeout: 15000 });
      const alert = await prisma.alerts.findFirst({ where: { senior_id: seniorId, title: 'High Temperature Alert', status: 'ACTIVE' } });
      return { status: response.status, actual: alert ? `alert ${alert.id}` : 'alert missing', ok: response.status === 201 && !!alert };
    });

    await httpCase('DEP-WEAR-VAL-001', 'Wearable rejects invalid event type', 'HTTP 400', async () => {
      try {
        await axios.post(`${apiBase}/telemetry/wearable`, { deviceId: wearableId, eventType: 'JUMP' }, { timeout: 15000 });
        return { actual: 'Request unexpectedly accepted', ok: false };
      } catch (error: any) {
        return { status: error.response?.status, actual: `HTTP ${error.response?.status}`, ok: error.response?.status === 400 };
      }
    });

    const movementTs = new Date(Date.now() + 103).toISOString();
    await httpCase('DEP-WEAR-001', 'Regular movement persists to database', 'HTTP 201 and REGULAR_MOVEMENT DB event', async () => {
      const response = await axios.post(`${apiBase}/telemetry/wearable`, {
        deviceId: wearableId,
        timestamp: movementTs,
        eventType: 'REGULAR_MOVEMENT',
      }, { timeout: 15000 });
      const event = await prisma.activity_events.findFirst({ where: { device_id: wearableId, type: 'REGULAR_MOVEMENT', recorded_at: new Date(movementTs) } });
      return { status: response.status, actual: event ? `event ${event.id}` : 'event missing', ok: response.status === 201 && !!event };
    });

    const fallTs = new Date(Date.now() + 104).toISOString();
    await httpCase('DEP-WEAR-002', 'FALL event persists and generates alert', 'HTTP 201, FALL event and fall alert stored', async () => {
      const response = await axios.post(`${apiBase}/telemetry/wearable`, {
        deviceId: wearableId,
        timestamp: fallTs,
        eventType: 'FALL',
      }, { timeout: 15000 });
      const [event, alert] = await Promise.all([
        prisma.activity_events.findFirst({ where: { device_id: wearableId, type: 'FALL', recorded_at: new Date(fallTs) } }),
        prisma.alerts.findFirst({ where: { senior_id: seniorId, title: '🚨 CRITICAL: Fall Detected', status: 'ACTIVE' } }),
      ]);
      return { status: response.status, actual: `event=${!!event}, alert=${!!alert}`, ok: response.status === 201 && !!event && !!alert };
    });
  } finally {
    await cleanupFixtures();
    await prisma.$disconnect();
  }

  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.length - passed;
  const output = {
    runAt: new Date().toISOString(),
    apiBase,
    fixturePrefix: `QA-*-${stamp}`,
    summary: { total: results.length, passed, failed },
    results,
  };

  const outputPath = path.join(resultsDir, 'deployed-api-results.json');
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  const csv = ['id,name,status,httpStatus,durationMs,expected,actual']
    .concat(results.map((r) => [r.id, r.name, r.status, r.httpStatus ?? '', r.durationMs, r.expected, r.actual]
      .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')))
    .join('\n');
  fs.writeFileSync(path.join(resultsDir, 'deployed-api-results.csv'), csv);
  console.log(JSON.stringify(output, null, 2));
  process.exit(failed === 0 ? 0 : 1);
}

main().catch(async (error) => {
  console.error(error);
  try { await cleanupFixtures(); } catch {}
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
