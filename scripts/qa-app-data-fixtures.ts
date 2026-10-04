import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import { PrismaService } from '../src/prisma/prisma.service';

const fixturePath = process.env.QA_APPDATA_FIXTURE_PATH || path.resolve(process.cwd(), 'qa-module-results', 'application-data-realtime', 'fixture.json');
const action = (process.env.QA_FIXTURE_ACTION || 'setup').toLowerCase();
const verifyScope = (process.env.QA_VERIFY_SCOPE || 'all').toUpperCase();
const resultsDir = process.env.QA_APPDATA_RESULTS_DIR || path.dirname(fixturePath);
fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
fs.mkdirSync(resultsDir, { recursive: true });

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
const supabaseAdmin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
const prisma = new PrismaService();

type Role = 'CAREGIVER' | 'SENIOR';
type UserFixture = { id: string; email: string; password: string; firstName: string; lastName: string; role: Role };
type Fixture = {
  stamp: string;
  createdAt: string;
  users: { caregiver: UserFixture; senior: UserFixture };
  devices: { podId: string; wearableId: string; podSerial: string; wearableSerial: string };
  medication: { id: string; name: string };
  markers: { chatPrefix: string; burstPrefix: string };
};

function loadFixture(): Fixture | null {
  if (!fs.existsSync(fixturePath)) return null;
  try { return JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as Fixture; } catch { return null; }
}

async function deleteAuthUser(id: string) {
  try { await supabaseAdmin.auth.admin.deleteUser(id); } catch {}
}

async function cleanup(fixture: Fixture | null) {
  const dbUsers = await prisma.users.findMany({
    where: { email: { startsWith: 'qa-appdata-' } },
    select: { id: true },
  });
  const ids = Array.from(new Set([...(fixture ? Object.values(fixture.users).map(u => u.id) : []), ...dbUsers.map(u => u.id)]));
  const devices = await prisma.devices.findMany({
    where: { OR: [{ serial_number: { startsWith: 'QA-APPDATA-' } }, ...(ids.length ? [{ senior_id: { in: ids } }] : [])] },
    select: { id: true },
  });
  const deviceIds = devices.map(d => d.id);

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
  await prisma.devices.deleteMany({ where: { serial_number: { startsWith: 'QA-APPDATA-' } } }).catch(() => undefined);
  if (ids.length) await prisma.users.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);
  for (const id of ids) await deleteAuthUser(id);

  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) break;
    for (const u of data.users.filter(u => u.email?.startsWith('qa-appdata-'))) await deleteAuthUser(u.id);
    if (data.users.length < 1000) break;
  }
}

async function createUser(role: Role, stamp: string): Promise<UserFixture> {
  const email = `qa-appdata-${role.toLowerCase()}-${stamp}@example.com`;
  const password = `Qa!${stamp.slice(-6)}xA9`;
  const firstName = role === 'CAREGIVER' ? 'QA Realtime Caregiver' : 'QA Realtime Senior';
  const lastName = stamp.slice(-5);
  const { data, error } = await supabaseAdmin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { role } });
  if (error || !data.user) throw new Error(`Unable to create ${role}: ${error?.message || 'unknown'}`);
  await prisma.users.create({ data: { id: data.user.id, email, first_name: firstName, last_name: lastName, role } });
  return { id: data.user.id, email, password, firstName, lastName, role };
}

async function setup(): Promise<Fixture> {
  await cleanup(loadFixture());
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const caregiver = await createUser('CAREGIVER', stamp);
  const senior = await createUser('SENIOR', stamp);
  await prisma.caregiver_senior.create({ data: { caregiver_id: caregiver.id, senior_id: senior.id } });

  const pod = await prisma.devices.create({ data: { serial_number: `QA-APPDATA-POD-${stamp}`, type: 'POD', senior_id: senior.id, battery_level: 91 } });
  const wearable = await prisma.devices.create({ data: { serial_number: `QA-APPDATA-WEAR-${stamp}`, type: 'WEARABLE', senior_id: senior.id, battery_level: 87 } });
  await prisma.environmental_readings.create({ data: { device_id: pod.id, temperature: 22.4, humidity: 44.5, gas_resistance: 120000, air_quality_score: 81, occupancy: true, recorded_at: new Date() } });
  await prisma.activity_events.create({ data: { device_id: wearable.id, type: 'REGULAR_MOVEMENT', metadata: { qa: true, module: 'QA-E' }, recorded_at: new Date() } });

  // Put the medication at the current local clock time so it is actionable as DUE NOW.
  const now = new Date();
  const medTime = new Date(Date.UTC(1970, 0, 1, now.getHours(), now.getMinutes(), 0, 0));
  const medication = await prisma.medication_schedules.create({ data: { senior_id: senior.id, medicine_name: `QA Realtime Medication ${stamp.slice(-4)}`, dosage: '1 tablet', time_of_day: medTime } });

  const fixture: Fixture = {
    stamp,
    createdAt: new Date().toISOString(),
    users: { caregiver, senior },
    devices: { podId: pod.id, wearableId: wearable.id, podSerial: pod.serial_number, wearableSerial: wearable.serial_number },
    medication: { id: medication.id, name: medication.medicine_name },
    markers: { chatPrefix: `QA-E CHAT ${stamp}`, burstPrefix: `QA-E BURST ${stamp}` },
  };
  fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));
  return fixture;
}

async function verify(fixture: Fixture) {
  const checkins = await prisma.daily_checkins.count({ where: { senior_id: fixture.users.senior.id } });
  const emergencyAlerts = await prisma.alerts.findMany({ where: { senior_id: fixture.users.senior.id, title: { contains: 'Software Panic Button' } }, select: { id: true, status: true, created_at: true } });
  const resolvedAlerts = emergencyAlerts.filter(a => a.status === 'RESOLVED').length;
  const medTaken = await prisma.medication_logs.count({ where: { schedule_id: fixture.medication.id, status: 'TAKEN' } });
  const chatMessages = await prisma.messages.count({ where: { content: { startsWith: fixture.markers.chatPrefix } } });
  const burstMessages = await prisma.messages.count({ where: { content: { startsWith: fixture.markers.burstPrefix } } });
  const allPass = checkins >= 1 && emergencyAlerts.length >= 2 && resolvedAlerts >= 1 && medTaken >= 1 && chatMessages >= 2 && burstMessages >= 5;
  const chatPass = chatMessages >= 2;
  const burstPass = burstMessages >= 5;
  const scopedPass = verifyScope === 'APP-RT-001' ? chatPass : verifyScope === 'APP-RT-003' ? burstPass : allPass;
  const verification = {
    scope: verifyScope,
    status: scopedPass ? 'PASS' : 'FAIL',
    checks: {
      dailyCheckins: checkins,
      emergencyAlerts: emergencyAlerts.length,
      resolvedEmergencyAlerts: resolvedAlerts,
      medicationTakenLogs: medTaken,
      bidirectionalChatMessages: chatMessages,
      realtimeBurstMessages: burstMessages,
    },
  };
  fs.writeFileSync(path.join(resultsDir, 'db-verification.json'), JSON.stringify(verification, null, 2));
  console.log(JSON.stringify(verification, null, 2));
  if (verification.status !== 'PASS') process.exitCode = 1;
}

async function main() {
  await prisma.$connect();
  try {
    const fixture = loadFixture();
    if (action === 'cleanup') {
      await cleanup(fixture);
      try { if (fs.existsSync(fixturePath)) fs.unlinkSync(fixturePath); } catch {}
      console.log(JSON.stringify({ status: 'PASS', action: 'cleanup' }, null, 2));
    } else if (action === 'verify') {
      if (!fixture) throw new Error('Fixture file is missing for verification.');
      await verify(fixture);
    } else {
      const created = await setup();
      console.log(JSON.stringify({ status: 'PASS', action: 'setup', fixturePath, users: 2, devices: 2, medication: created.medication.name }, null, 2));
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(error);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
