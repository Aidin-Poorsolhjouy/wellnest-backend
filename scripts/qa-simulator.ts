import axios from 'axios';
import fs from 'fs';
import path from 'path';

const apiBase = (process.env.QA_API_BASE_URL || 'http://localhost:3000').replace(/\/+$/, '');
const podId = process.env.QA_POD_ID;
const wearableId = process.env.QA_WEARABLE_ID;
const resultsDir = process.env.QA_RESULTS_DIR || path.resolve(process.cwd(), 'qa-results');

if (!podId || !wearableId) {
  console.error('QA_POD_ID and QA_WEARABLE_ID must be configured before running the simulator.');
  process.exit(2);
}

fs.mkdirSync(resultsDir, { recursive: true });

interface CaseResult {
  id: string;
  endpoint: string;
  payload: Record<string, unknown>;
  status: 'PASS' | 'FAIL';
  httpStatus?: number;
  response?: unknown;
  error?: string;
  durationMs: number;
}

const results: CaseResult[] = [];

async function runCase(
  id: string,
  endpoint: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const started = Date.now();
  try {
    const response = await axios.post(`${apiBase}${endpoint}`, payload, {
      timeout: 15000,
      headers: { 'Content-Type': 'application/json' },
    });
    results.push({
      id,
      endpoint,
      payload,
      status: response.status >= 200 && response.status < 300 ? 'PASS' : 'FAIL',
      httpStatus: response.status,
      response: response.data,
      durationMs: Date.now() - started,
    });
  } catch (error: any) {
    results.push({
      id,
      endpoint,
      payload,
      status: 'FAIL',
      httpStatus: error.response?.status,
      response: error.response?.data,
      error: error.message,
      durationMs: Date.now() - started,
    });
  }
}

async function main() {
  const runStamp = new Date().toISOString();

  await runCase('SIM-POD-001', '/telemetry/pod', {
    deviceId: podId,
    timestamp: new Date(Date.now() + 1).toISOString(),
    temperature: 22.2,
    humidity: 45,
    gasResistance: 120000,
    airQualityScore: 75,
    occupancy: true,
  });

  await runCase('SIM-POD-002', '/telemetry/pod', {
    deviceId: podId,
    timestamp: new Date(Date.now() + 2).toISOString(),
    temperature: 38.5,
    humidity: 45,
    gasResistance: 120000,
    airQualityScore: 75,
    occupancy: true,
  });

  await runCase('SIM-WEAR-001', '/telemetry/wearable', {
    deviceId: wearableId,
    timestamp: new Date(Date.now() + 3).toISOString(),
    eventType: 'REGULAR_MOVEMENT',
  });

  await runCase('SIM-WEAR-002', '/telemetry/wearable', {
    deviceId: wearableId,
    timestamp: new Date(Date.now() + 4).toISOString(),
    eventType: 'FALL',
  });

  const output = {
    startedAt: runStamp,
    apiBase,
    summary: {
      total: results.length,
      passed: results.filter((r) => r.status === 'PASS').length,
      failed: results.filter((r) => r.status === 'FAIL').length,
    },
    results,
  };

  const outputPath = path.join(resultsDir, 'simulator-results.json');
  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));
  console.log(JSON.stringify(output, null, 2));
  console.log(`Simulator results written to ${outputPath}`);

  process.exit(output.summary.failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
