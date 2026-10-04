import 'dotenv/config';
import axios, { AxiosResponse } from 'axios';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import { PrismaService } from '../src/prisma/prisma.service';

type Status = 'PASS' | 'FAIL';
type Result = {
  id: string;
  name: string;
  method: string;
  endpoint: string;
  status: Status;
  durationMs: number;
  httpStatus?: number;
  expected?: string;
  observed?: string;
  details?: Record<string, unknown>;
};

const apiBase = (process.env.QA_API_BASE_URL || 'https://wellnest-backend-production-8e06.up.railway.app').replace(/\/+$/, '');
const resultsDir = process.env.QA_RESULTS_DIR || path.resolve(process.cwd(), 'qa-results', 'users-api');
fs.mkdirSync(resultsDir, { recursive: true });

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');

const supabaseAdmin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
const prisma = new PrismaService();
const http = axios.create({ baseURL: apiBase, timeout: 25_000, validateStatus: () => true });
const results: Result[] = [];
const stamp = `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
const emailPrefix = `qa-users-api-${stamp}`;
const devicePrefix = `QA-USERS-API-${stamp}`;

function csvEscape(v: unknown) { return `"${String(v ?? '').replace(/"/g, '""')}"`; }
function bodyText(resp: AxiosResponse) {
  try { return JSON.stringify(resp.data); } catch { return String(resp.data); }
}
function is2xx(status: number) { return status >= 200 && status < 300; }
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function measured(
  id: string,
  name: string,
  method: string,
  endpoint: string,
  expected: string,
  fn: () => Promise<{ httpStatus?: number; observed?: string; details?: Record<string, unknown> }>,
) {
  const started = Date.now();
  try {
    const data = await fn();
    results.push({ id, name, method, endpoint, expected, status: 'PASS', durationMs: Date.now() - started, ...data });
  } catch (error: any) {
    results.push({ id, name, method, endpoint, expected, status: 'FAIL', durationMs: Date.now() - started, observed: error?.message || String(error) });
  }
}

async function directUser(role: 'ADMIN' | 'CAREGIVER' | 'SENIOR', suffix: string) {
  const email = `${emailPrefix}-${suffix}@example.com`;
  const password = `Qa!${stamp.slice(-6)}Aa9`;
  const firstName = `QA${role.slice(0, 3)}`;
  const lastName = suffix.replace(/[^a-zA-Z0-9]/g, '').slice(0, 20) || 'Fixture';
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { role },
  });
  if (error || !data.user) throw new Error(`Unable to create direct ${role} fixture: ${error?.message || 'unknown'}`);
  await prisma.users.create({ data: { id: data.user.id, email, first_name: firstName, last_name: lastName, role } });
  return { id: data.user.id, email, password, firstName, lastName, role };
}

async function cleanupPrefix() {
  const dbUsers = await prisma.users.findMany({ where: { email: { startsWith: 'qa-users-api-' } }, select: { id: true } });
  const ids = dbUsers.map((u) => u.id);
  const devices = await prisma.devices.findMany({
    where: { OR: [{ serial_number: { startsWith: 'QA-USERS-API-' } }, ...(ids.length ? [{ senior_id: { in: ids } }] : [])] },
    select: { id: true },
  });
  const deviceIds = devices.map((d) => d.id);
  if (ids.length) {
    await prisma.medication_schedules.deleteMany({ where: { senior_id: { in: ids } } }).catch(() => undefined);
    await prisma.caregiver_journal.deleteMany({ where: { OR: [{ senior_id: { in: ids } }, { author_id: { in: ids } }] } }).catch(() => undefined);
    await prisma.daily_checkins.deleteMany({ where: { senior_id: { in: ids } } }).catch(() => undefined);
    await prisma.alerts.deleteMany({ where: { OR: [{ senior_id: { in: ids } }, { resolved_by: { in: ids } }] } }).catch(() => undefined);
    await prisma.thresholds.deleteMany({ where: { senior_id: { in: ids } } }).catch(() => undefined);
    await prisma.messages.deleteMany({ where: { OR: [{ sender_id: { in: ids } }, { receiver_id: { in: ids } }] } }).catch(() => undefined);
    await prisma.caregiver_senior.deleteMany({ where: { OR: [{ caregiver_id: { in: ids } }, { senior_id: { in: ids } }] } }).catch(() => undefined);
  }
  if (deviceIds.length) {
    await prisma.activity_events.deleteMany({ where: { device_id: { in: deviceIds } } }).catch(() => undefined);
    await prisma.environmental_readings.deleteMany({ where: { device_id: { in: deviceIds } } }).catch(() => undefined);
  }
  await prisma.devices.deleteMany({ where: { serial_number: { startsWith: 'QA-USERS-API-' } } }).catch(() => undefined);
  if (ids.length) await prisma.users.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);

  // Also remove Auth users that may have been created before a failed DB step.
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) break;
    const matching = data.users.filter((u) => u.email?.startsWith('qa-users-api-'));
    for (const u of matching) await supabaseAdmin.auth.admin.deleteUser(u.id).catch(() => undefined);
    if (data.users.length < 1000) break;
  }
}

async function main() {
  await prisma.$connect();
  await cleanupPrefix();

  let anchorCaregiver: Awaited<ReturnType<typeof directUser>> | undefined;
  let secondCaregiver: Awaited<ReturnType<typeof directUser>> | undefined;
  let standaloneSenior: Awaited<ReturnType<typeof directUser>> | undefined;
  let createdCaregiverId = '';
  let createdCaregiverEmail = '';
  let mainSeniorId = '';
  let mainSeniorEmail = '';

  try {
    anchorCaregiver = await directUser('CAREGIVER', 'anchor-caregiver');
    secondCaregiver = await directUser('CAREGIVER', 'second-caregiver');
    standaloneSenior = await directUser('SENIOR', 'standalone-senior');

    const pod1 = await prisma.devices.create({ data: { serial_number: `${devicePrefix}-POD-1`, type: 'POD', battery_level: 100 } });
    const wear1 = await prisma.devices.create({ data: { serial_number: `${devicePrefix}-WEAR-1`, type: 'WEARABLE', battery_level: 100 } });
    const pod2 = await prisma.devices.create({ data: { serial_number: `${devicePrefix}-POD-2`, type: 'POD', battery_level: 100 } });
    const wear2 = await prisma.devices.create({ data: { serial_number: `${devicePrefix}-WEAR-2`, type: 'WEARABLE', battery_level: 100 } });

    await measured('USR-API-001', 'Admin create user succeeds and persists', 'POST', '/users/admin-create', '201 and matching Auth/DB user', async () => {
      createdCaregiverEmail = `${emailPrefix}-created-caregiver@example.com`;
      const resp = await http.post('/users/admin-create', { email: createdCaregiverEmail, password: 'Qa!Create123A', firstName: 'Created', lastName: 'Caregiver', role: 'CAREGIVER' });
      assert(resp.status === 201 && resp.data?.success === true && resp.data?.userId, `Expected 201 success, got ${resp.status}: ${bodyText(resp)}`);
      createdCaregiverId = resp.data.userId;
      const db = await prisma.users.findUnique({ where: { id: createdCaregiverId } });
      assert(db?.email === createdCaregiverEmail && db.role === 'CAREGIVER', 'Created user not persisted correctly in users table');
      const { data: auth, error } = await supabaseAdmin.auth.admin.getUserById(createdCaregiverId);
      assert(!error && auth.user?.email === createdCaregiverEmail, 'Created user not present in Supabase Auth');
      return { httpStatus: resp.status, observed: 'Created caregiver in Auth + DB', details: { userId: createdCaregiverId } };
    });

    await measured('USR-API-002', 'Duplicate admin user email is rejected', 'POST', '/users/admin-create', 'Non-2xx and no second DB user', async () => {
      const resp = await http.post('/users/admin-create', { email: createdCaregiverEmail, password: 'Qa!Create123A', firstName: 'Duplicate', lastName: 'Caregiver', role: 'CAREGIVER' });
      assert(!is2xx(resp.status), `Duplicate email unexpectedly succeeded: ${resp.status}`);
      const count = await prisma.users.count({ where: { email: createdCaregiverEmail } });
      assert(count === 1, `Expected exactly one DB row, found ${count}`);
      return { httpStatus: resp.status, observed: bodyText(resp) };
    });

    await measured('USR-API-003', 'Missing password is rejected', 'POST', '/users/admin-create', 'Non-2xx', async () => {
      const resp = await http.post('/users/admin-create', { email: `${emailPrefix}-no-password@example.com`, firstName: 'No', lastName: 'Password', role: 'CAREGIVER' });
      assert(!is2xx(resp.status), `Missing password unexpectedly succeeded: ${resp.status}`);
      return { httpStatus: resp.status, observed: bodyText(resp) };
    });

    await measured('USR-API-004', 'Update existing user succeeds', 'PATCH', '/users/:id', '2xx and DB names updated', async () => {
      const resp = await http.patch(`/users/${createdCaregiverId}`, { firstName: 'Updated', lastName: 'Caregiver' });
      assert(is2xx(resp.status), `Update failed: ${resp.status}: ${bodyText(resp)}`);
      const db = await prisma.users.findUnique({ where: { id: createdCaregiverId } });
      assert(db?.first_name === 'Updated' && db.last_name === 'Caregiver', 'DB user names were not updated');
      return { httpStatus: resp.status, observed: 'DB values updated' };
    });

    await measured('USR-API-005', 'Update nonexistent user is rejected', 'PATCH', '/users/:id', 'Non-2xx', async () => {
      const id = crypto.randomUUID();
      const resp = await http.patch(`/users/${id}`, { firstName: 'Nobody', lastName: 'Missing' });
      assert(!is2xx(resp.status), `Nonexistent user update unexpectedly succeeded: ${resp.status}`);
      return { httpStatus: resp.status, observed: bodyText(resp) };
    });

    await measured('USR-API-006', 'Create managed senior succeeds with relationship and devices', 'POST', '/users/create-senior', '201; senior+relationship+POD+wearable persisted', async () => {
      mainSeniorEmail = `${emailPrefix}-managed-senior@example.com`;
      const resp = await http.post('/users/create-senior', {
        email: mainSeniorEmail, password: 'Qa!Senior123A', firstName: 'Managed', lastName: 'Senior',
        caregiverId: anchorCaregiver!.id, podSerial: pod1.serial_number, wearableSerial: wear1.serial_number,
      });
      assert(resp.status === 201 && resp.data?.success === true && resp.data?.seniorId, `Expected 201, got ${resp.status}: ${bodyText(resp)}`);
      mainSeniorId = resp.data.seniorId;
      const [dbUser, rel, podDb, wearDb] = await Promise.all([
        prisma.users.findUnique({ where: { id: mainSeniorId } }),
        prisma.caregiver_senior.findUnique({ where: { caregiver_id_senior_id: { caregiver_id: anchorCaregiver!.id, senior_id: mainSeniorId } } }),
        prisma.devices.findUnique({ where: { id: pod1.id } }),
        prisma.devices.findUnique({ where: { id: wear1.id } }),
      ]);
      assert(dbUser?.role === 'SENIOR' && rel && podDb?.senior_id === mainSeniorId && wearDb?.senior_id === mainSeniorId, 'Senior side effects incomplete');
      return { httpStatus: resp.status, observed: 'Senior, relationship, POD and wearable persisted', details: { seniorId: mainSeniorId } };
    });

    await measured('USR-API-007', 'Duplicate managed senior email is rejected', 'POST', '/users/create-senior', 'Non-2xx', async () => {
      const resp = await http.post('/users/create-senior', { email: mainSeniorEmail, password: 'Qa!Senior123A', firstName: 'Dup', lastName: 'Senior', caregiverId: anchorCaregiver!.id });
      assert(!is2xx(resp.status), `Duplicate senior email unexpectedly succeeded: ${resp.status}`);
      return { httpStatus: resp.status, observed: bodyText(resp) };
    });

    await measured('USR-API-008', 'Invalid caregiver senior creation is rejected atomically', 'POST', '/users/create-senior', 'Non-2xx and no residual Auth/DB user', async () => {
      const email = `${emailPrefix}-bad-caregiver@example.com`;
      const resp = await http.post('/users/create-senior', { email, password: 'Qa!Senior123A', firstName: 'Bad', lastName: 'Caregiver', caregiverId: crypto.randomUUID() });
      assert(!is2xx(resp.status), `Invalid caregiver unexpectedly succeeded: ${resp.status}`);
      const db = await prisma.users.findUnique({ where: { email } });
      let authExists = false;
      for (let page = 1; page <= 3; page += 1) {
        const { data } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
        if (data.users.some((u) => u.email === email)) authExists = true;
        if (data.users.length < 1000) break;
      }
      assert(!db && !authExists, `Request failed but left partial user state (DB=${!!db}, Auth=${authExists})`);
      return { httpStatus: resp.status, observed: 'Rejected without residual user state' };
    });

    await measured('USR-API-009', 'Assign caregiver-senior relationship succeeds', 'POST', '/users/relationships', '201 and one relationship row', async () => {
      const resp = await http.post('/users/relationships', { caregiverId: secondCaregiver!.id, seniorId: standaloneSenior!.id });
      assert(resp.status === 201 && resp.data?.success === true, `Relationship create failed: ${resp.status}: ${bodyText(resp)}`);
      const count = await prisma.caregiver_senior.count({ where: { caregiver_id: secondCaregiver!.id, senior_id: standaloneSenior!.id } });
      assert(count === 1, `Expected one relationship, got ${count}`);
      return { httpStatus: resp.status, observed: 'Relationship persisted' };
    });

    await measured('USR-API-010', 'Duplicate relationship request is idempotent', 'POST', '/users/relationships', '2xx and still one row', async () => {
      const resp = await http.post('/users/relationships', { caregiverId: secondCaregiver!.id, seniorId: standaloneSenior!.id });
      assert(is2xx(resp.status) && resp.data?.success === true, `Duplicate relationship returned ${resp.status}: ${bodyText(resp)}`);
      const count = await prisma.caregiver_senior.count({ where: { caregiver_id: secondCaregiver!.id, senior_id: standaloneSenior!.id } });
      assert(count === 1, `Duplicate relationship created ${count} rows`);
      return { httpStatus: resp.status, observed: 'Idempotent; one row remains' };
    });

    await measured('USR-API-011', 'Remove relationship succeeds', 'DELETE', '/users/relationships', '2xx and row removed', async () => {
      const resp = await http.delete('/users/relationships', { data: { caregiverId: secondCaregiver!.id, seniorId: standaloneSenior!.id } });
      assert(is2xx(resp.status) && resp.data?.success === true, `Relationship delete failed: ${resp.status}`);
      const count = await prisma.caregiver_senior.count({ where: { caregiver_id: secondCaregiver!.id, senior_id: standaloneSenior!.id } });
      assert(count === 0, `Relationship still exists (${count})`);
      return { httpStatus: resp.status, observed: 'Relationship removed' };
    });

    await measured('USR-API-012', 'Removing absent relationship is idempotent', 'DELETE', '/users/relationships', '2xx success', async () => {
      const resp = await http.delete('/users/relationships', { data: { caregiverId: secondCaregiver!.id, seniorId: standaloneSenior!.id } });
      assert(is2xx(resp.status) && resp.data?.success === true, `Absent relationship delete returned ${resp.status}`);
      return { httpStatus: resp.status, observed: 'Idempotent success' };
    });

    await measured('USR-API-013', 'Assign unassigned device succeeds', 'PATCH', '/users/assign-device/:seniorId', '2xx and device senior_id updated', async () => {
      const resp = await http.patch(`/users/assign-device/${standaloneSenior!.id}`, { serial: pod2.serial_number, type: 'POD' });
      assert(is2xx(resp.status), `Assign device failed: ${resp.status}: ${bodyText(resp)}`);
      const db = await prisma.devices.findUnique({ where: { id: pod2.id } });
      assert(db?.senior_id === standaloneSenior!.id, 'Device was not assigned in DB');
      return { httpStatus: resp.status, observed: 'Device assigned' };
    });

    await measured('USR-API-014', 'Already assigned device is rejected', 'PATCH', '/users/assign-device/:seniorId', '400/non-2xx', async () => {
      const resp = await http.patch(`/users/assign-device/${anchorCaregiver!.id}`, { serial: pod2.serial_number, type: 'POD' });
      assert(!is2xx(resp.status), `Already-assigned device unexpectedly succeeded: ${resp.status}`);
      return { httpStatus: resp.status, observed: bodyText(resp) };
    });

    await measured('USR-API-015', 'Wrong device type is rejected', 'PATCH', '/users/assign-device/:seniorId', '400/non-2xx', async () => {
      const resp = await http.patch(`/users/assign-device/${standaloneSenior!.id}`, { serial: wear2.serial_number, type: 'POD' });
      assert(!is2xx(resp.status), `Wrong device type unexpectedly succeeded: ${resp.status}`);
      return { httpStatus: resp.status, observed: bodyText(resp) };
    });

    await measured('USR-API-016', 'Unknown device serial is rejected', 'PATCH', '/users/assign-device/:seniorId', '400/non-2xx', async () => {
      const resp = await http.patch(`/users/assign-device/${standaloneSenior!.id}`, { serial: `${devicePrefix}-MISSING`, type: 'WEARABLE' });
      assert(!is2xx(resp.status), `Missing device unexpectedly succeeded: ${resp.status}`);
      return { httpStatus: resp.status, observed: bodyText(resp) };
    });

    await measured('USR-API-017', 'Unassign existing device succeeds', 'PATCH', '/users/devices/unassign/:id', '2xx and senior_id cleared', async () => {
      const resp = await http.patch(`/users/devices/unassign/${pod2.id}`);
      assert(is2xx(resp.status), `Unassign failed: ${resp.status}: ${bodyText(resp)}`);
      const db = await prisma.devices.findUnique({ where: { id: pod2.id } });
      assert(db?.senior_id === null, 'Device senior_id not cleared');
      return { httpStatus: resp.status, observed: 'Device unassigned' };
    });

    await measured('USR-API-018', 'Unassign nonexistent device is rejected', 'PATCH', '/users/devices/unassign/:id', 'Non-2xx', async () => {
      const resp = await http.patch(`/users/devices/unassign/${crypto.randomUUID()}`);
      assert(!is2xx(resp.status), `Nonexistent device unassign unexpectedly succeeded: ${resp.status}`);
      return { httpStatus: resp.status, observed: bodyText(resp) };
    });

    await measured('USR-API-019', 'Delete managed senior removes profile/relationship and unassigns devices', 'DELETE', '/users/senior/:id', '2xx; DB/Auth senior removed; devices unassigned', async () => {
      const resp = await http.delete(`/users/senior/${mainSeniorId}`);
      assert(is2xx(resp.status) && resp.data?.success === true, `Senior delete failed: ${resp.status}: ${bodyText(resp)}`);
      const [dbUser, relCount, podDb, wearDb] = await Promise.all([
        prisma.users.findUnique({ where: { id: mainSeniorId } }),
        prisma.caregiver_senior.count({ where: { senior_id: mainSeniorId } }),
        prisma.devices.findUnique({ where: { id: pod1.id } }),
        prisma.devices.findUnique({ where: { id: wear1.id } }),
      ]);
      const { data: authData } = await supabaseAdmin.auth.admin.getUserById(mainSeniorId);
      assert(!dbUser && relCount === 0 && podDb?.senior_id === null && wearDb?.senior_id === null && !authData.user, 'Delete side effects incomplete');
      mainSeniorId = '';
      return { httpStatus: resp.status, observed: 'Senior removed from Auth/DB; relationship removed; devices retained but unassigned' };
    });

    await measured('USR-API-020', 'Delete nonexistent senior is rejected', 'DELETE', '/users/senior/:id', 'Non-2xx', async () => {
      const resp = await http.delete(`/users/senior/${crypto.randomUUID()}`);
      assert(!is2xx(resp.status), `Nonexistent senior delete unexpectedly succeeded: ${resp.status}`);
      return { httpStatus: resp.status, observed: bodyText(resp) };
    });
  } finally {
    await cleanupPrefix().catch((e) => console.error('Cleanup warning:', e));
    await prisma.$disconnect().catch(() => undefined);
  }

  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.length - passed;
  const summary = { runAt: new Date().toISOString(), apiBase, total: results.length, passed, failed, status: failed ? 'FAIL' : 'PASS', results };
  fs.writeFileSync(path.join(resultsDir, 'users-api-results.json'), JSON.stringify(summary, null, 2));
  const csv = ['id,name,method,endpoint,status,durationMs,httpStatus,expected,observed']
    .concat(results.map((r) => [r.id,r.name,r.method,r.endpoint,r.status,r.durationMs,r.httpStatus ?? '',r.expected ?? '',r.observed ?? ''].map(csvEscape).join(',')))
    .join('\n');
  fs.writeFileSync(path.join(resultsDir, 'users-api-results.csv'), csv);
  console.log(JSON.stringify({ status: summary.status, total: results.length, passed, failed, resultsDir }, null, 2));
  if (failed) process.exitCode = 1;
}

main().catch(async (error) => {
  console.error(error);
  try { await cleanupPrefix(); } catch {}
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
