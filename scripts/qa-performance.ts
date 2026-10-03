import 'dotenv/config';
import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { PrismaService } from '../src/prisma/prisma.service';

const apiBase = (process.env.QA_API_BASE_URL || 'https://wellnest-backend-production-8e06.up.railway.app').replace(/\/+$/, '');
const resultsDir = process.env.QA_RESULTS_DIR || path.resolve(process.cwd(), 'qa-results');
const requestCount = Math.max(1, Number(process.env.QA_PERF_REQUESTS || 50));
const concurrency = Math.max(1, Number(process.env.QA_PERF_CONCURRENCY || 5));
fs.mkdirSync(resultsDir, { recursive: true });

const prisma = new PrismaService();
const deviceId = randomUUID();
const stamp = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;

interface Sample { index: number; status: 'PASS' | 'FAIL'; httpStatus?: number; latencyMs: number; error?: string; timestamp: string; }
const samples: Sample[] = [];

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

async function cleanup() {
  try { await prisma.environmental_readings.deleteMany({ where: { device_id: deviceId } }); } catch {}
  try { await prisma.devices.deleteMany({ where: { id: deviceId } }); } catch {}
}

async function worker(indices: number[]) {
  for (const i of indices) {
    const timestamp = new Date(Date.now() + i + 1000).toISOString();
    const started = performance.now();
    try {
      const response = await axios.post(`${apiBase}/telemetry/pod`, {
        deviceId,
        timestamp,
        temperature: 21 + (i % 10) / 10,
        humidity: 45 + (i % 5),
        gasResistance: 120000 + i,
        airQualityScore: 75,
        occupancy: i % 2 === 0,
      }, { timeout: 20000 });
      samples.push({ index: i, status: response.status === 201 ? 'PASS' : 'FAIL', httpStatus: response.status, latencyMs: Math.round(performance.now() - started), timestamp });
    } catch (error: any) {
      samples.push({ index: i, status: 'FAIL', httpStatus: error.response?.status, latencyMs: Math.round(performance.now() - started), error: error.message, timestamp });
    }
  }
}

async function main() {
  await prisma.$connect();
  await cleanup();
  await prisma.devices.create({
    data: { id: deviceId, serial_number: `QA-PERF-POD-${stamp}`, type: 'POD', battery_level: 100 },
  });

  const overallStarted = performance.now();
  try {
    const buckets: number[][] = Array.from({ length: concurrency }, () => []);
    for (let i = 0; i < requestCount; i++) buckets[i % concurrency].push(i);
    await Promise.all(buckets.map(worker));

    const dbCount = await prisma.environmental_readings.count({ where: { device_id: deviceId } });
    const latencies = samples.filter((s) => s.status === 'PASS').map((s) => s.latencyMs);
    const durationMs = Math.round(performance.now() - overallStarted);
    const passed = samples.filter((s) => s.status === 'PASS').length;
    const failed = requestCount - passed;
    const summary = {
      requestCount,
      concurrency,
      passed,
      failed,
      successRatePercent: Number(((passed / requestCount) * 100).toFixed(2)),
      dbRowsPersisted: dbCount,
      totalDurationMs: durationMs,
      throughputRequestsPerSecond: Number((requestCount / (durationMs / 1000)).toFixed(2)),
      latencyMs: {
        min: latencies.length ? Math.min(...latencies) : 0,
        average: latencies.length ? Number((latencies.reduce((a, b) => a + b, 0) / latencies.length).toFixed(2)) : 0,
        p50: percentile(latencies, 50),
        p95: percentile(latencies, 95),
        p99: percentile(latencies, 99),
        max: latencies.length ? Math.max(...latencies) : 0,
      },
      acceptance: {
        allRequestsSucceeded: failed === 0,
        allRowsPersisted: dbCount === requestCount,
      },
    };

    const output = { runAt: new Date().toISOString(), apiBase, summary, samples: samples.sort((a, b) => a.index - b.index) };
    fs.writeFileSync(path.join(resultsDir, 'performance-results.json'), JSON.stringify(output, null, 2));
    const csv = ['index,status,httpStatus,latencyMs,timestamp,error']
      .concat(output.samples.map((s) => [s.index, s.status, s.httpStatus ?? '', s.latencyMs, s.timestamp, s.error ?? '']
        .map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')))
      .join('\n');
    fs.writeFileSync(path.join(resultsDir, 'performance-samples.csv'), csv);
    console.log(JSON.stringify(output, null, 2));
    process.exitCode = failed === 0 && dbCount === requestCount ? 0 : 1;
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
