import 'dotenv/config';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';

const apiBase = (process.env.QA_API_BASE_URL || '').replace(/\/+$/, '');
const resultsDir = process.env.QA_RESULTS_DIR || path.resolve(process.cwd(), 'qa-results', 'performance-matrix');
const levels = (process.env.QA_PERF_LEVELS || '1,5,10,20').split(',').map(Number).filter((n) => Number.isFinite(n) && n > 0);
const requestsPerLevel = Math.max(10, Number(process.env.QA_PERF_REQUESTS_PER_LEVEL || 25));
fs.mkdirSync(resultsDir, { recursive: true });
if (!apiBase) throw new Error('QA_API_BASE_URL is required');

const prisma = new PrismaService();
const deviceId = randomUUID();
const stamp = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;

type Sample = { stage: string; concurrency: number; index: number; status: 'PASS' | 'FAIL'; httpStatus?: number; latencyMs: number; error?: string; timestamp: string };
type Stage = {
  concurrency: number;
  requestCount: number;
  passed: number;
  failed: number;
  dbRowsPersisted: number;
  totalDurationMs: number;
  throughputRequestsPerSecond: number;
  latencyMs: { min: number; average: number; p50: number; p95: number; p99: number; max: number };
};

const samples: Sample[] = [];
function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}
async function cleanup() {
  try { await prisma.environmental_readings.deleteMany({ where: { device_id: deviceId } }); } catch {}
  try { await prisma.devices.deleteMany({ where: { id: deviceId } }); } catch {}
}
async function sendOne(stage: string, concurrency: number, index: number, timestamp: string): Promise<Sample> {
  const started = performance.now();
  try {
    const response = await axios.post(`${apiBase}/telemetry/pod`, {
      deviceId,
      timestamp,
      temperature: 21.4 + (index % 10) / 10,
      humidity: 44 + (index % 8),
      gasResistance: 117000 + index,
      airQualityScore: 76,
      occupancy: index % 2 === 0,
    }, { timeout: 25000 });
    return { stage, concurrency, index, status: response.status === 201 ? 'PASS' : 'FAIL', httpStatus: response.status, latencyMs: Math.round(performance.now() - started), timestamp };
  } catch (error: any) {
    return { stage, concurrency, index, status: 'FAIL', httpStatus: error.response?.status, latencyMs: Math.round(performance.now() - started), error: error.message, timestamp };
  }
}
async function runStage(concurrency: number, stageIndex: number): Promise<Stage> {
  const stage = `C${concurrency}`;
  const base = Date.now() + stageIndex * 100000;
  const indices = Array.from({ length: requestsPerLevel }, (_, i) => i);
  const buckets: number[][] = Array.from({ length: concurrency }, () => []);
  for (const i of indices) buckets[i % concurrency].push(i);
  const started = performance.now();
  const before = await prisma.environmental_readings.count({ where: { device_id: deviceId } });
  await Promise.all(buckets.map(async (bucket) => {
    for (const i of bucket) {
      const timestamp = new Date(base + i).toISOString();
      const result = await sendOne(stage, concurrency, i, timestamp);
      samples.push(result);
    }
  }));
  const durationMs = Math.round(performance.now() - started);
  const after = await prisma.environmental_readings.count({ where: { device_id: deviceId } });
  const persisted = after - before;
  const stageSamples = samples.filter((s) => s.stage === stage);
  const latencies = stageSamples.filter((s) => s.status === 'PASS').map((s) => s.latencyMs);
  const passed = stageSamples.filter((s) => s.status === 'PASS').length;
  const failed = requestsPerLevel - passed;
  return {
    concurrency,
    requestCount: requestsPerLevel,
    passed,
    failed,
    dbRowsPersisted: persisted,
    totalDurationMs: durationMs,
    throughputRequestsPerSecond: Number((requestsPerLevel / (durationMs / 1000)).toFixed(2)),
    latencyMs: {
      min: latencies.length ? Math.min(...latencies) : 0,
      average: latencies.length ? Number((latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2)) : 0,
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: latencies.length ? Math.max(...latencies) : 0,
    },
  };
}

async function main() {
  await prisma.$connect();
  await cleanup();
  await prisma.devices.create({ data: { id: deviceId, serial_number: `QA-PERF-MATRIX-${stamp}`, type: 'POD', battery_level: 100 } });

  try {
    const coldTimestamp = new Date(Date.now() + 500).toISOString();
    const cold = await sendOne('COLD', 1, -1, coldTimestamp);
    const stages: Stage[] = [];
    for (let i = 0; i < levels.length; i++) stages.push(await runStage(levels[i], i + 1));

    const expectedRows = 1 + stages.reduce((sum, s) => sum + s.requestCount, 0);
    const actualRows = await prisma.environmental_readings.count({ where: { device_id: deviceId } });
    const allRequestsSucceeded = cold.status === 'PASS' && stages.every((s) => s.failed === 0);
    const allRowsPersisted = actualRows === expectedRows;
    const output = {
      runAt: new Date().toISOString(),
      apiBase,
      coldStart: cold,
      matrix: stages,
      summary: {
        levels,
        requestsPerLevel,
        totalRequests: expectedRows,
        allRequestsSucceeded,
        expectedRows,
        actualRows,
        allRowsPersisted,
      },
      samples,
    };
    fs.writeFileSync(path.join(resultsDir, 'performance-matrix-results.json'), JSON.stringify(output, null, 2));
    fs.writeFileSync(path.join(resultsDir, 'performance-matrix.csv'), ['concurrency,requestCount,passed,failed,dbRowsPersisted,totalDurationMs,throughputReqPerSec,minMs,avgMs,p50Ms,p95Ms,p99Ms,maxMs']
      .concat(stages.map((s) => [s.concurrency, s.requestCount, s.passed, s.failed, s.dbRowsPersisted, s.totalDurationMs, s.throughputRequestsPerSecond, s.latencyMs.min, s.latencyMs.average, s.latencyMs.p50, s.latencyMs.p95, s.latencyMs.p99, s.latencyMs.max].join(',')))
      .join('\n'));
    fs.writeFileSync(path.join(resultsDir, 'performance-matrix-samples.csv'), ['stage,concurrency,index,status,httpStatus,latencyMs,timestamp,error']
      .concat(samples.map((s) => [s.stage, s.concurrency, s.index, s.status, s.httpStatus ?? '', s.latencyMs, s.timestamp, s.error ?? ''].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')))
      .join('\n'));
    console.log(JSON.stringify(output, null, 2));
    process.exitCode = allRequestsSucceeded && allRowsPersisted ? 0 : 1;
  } finally {
    await cleanup();
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(error);
  try { await cleanup(); } catch {}
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
