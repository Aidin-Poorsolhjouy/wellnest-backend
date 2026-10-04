import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import { PrismaService } from '../src/prisma/prisma.service';

const fixturePath = process.env.QA_PLATFORM_FIXTURE_PATH || path.resolve(process.cwd(), 'qa-module-results', 'frontend-functional', 'platform-fixture.json');
const action = (process.env.QA_FIXTURE_ACTION || 'setup').toLowerCase();
fs.mkdirSync(path.dirname(fixturePath), { recursive: true });
const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceKey) throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required.');
const supabaseAdmin = createClient(supabaseUrl, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
const prisma = new PrismaService();

type Role = 'ADMIN' | 'CAREGIVER' | 'SENIOR';
type UserFixture = { id: string; email: string; password: string; firstName: string; lastName: string; role: Role };
type Fixture = {
  stamp: string;
  createdAt: string;
  users: { admin: UserFixture; caregiver: UserFixture; senior: UserFixture };
  devices: { podId: string; wearableId: string; podSerial: string; wearableSerial: string };
  medication: { id: string; name: string };
};

function loadFixture(): Fixture | null {
  if (!fs.existsSync(fixturePath)) return null;
  try { return JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as Fixture; } catch { return null; }
}

async function deleteAuthUser(id: string) {
  try { await supabaseAdmin.auth.admin.deleteUser(id); } catch {}
}

async function cleanupQaArtifacts(fixture: Fixture | null) {
  const dbUsers = await prisma.users.findMany({
    where: { OR: [{ email: { startsWith: 'qa-platform-fe-' } }, { email: { startsWith: 'qa-ui-' } }] },
    select: { id: true },
  });
  const ids = Array.from(new Set([...(fixture ? Object.values(fixture.users).map((u) => u.id) : []), ...dbUsers.map((u) => u.id)]));
  const qaDevices = await prisma.devices.findMany({
    where: { OR: [{ serial_number: { startsWith: 'QA-PLATFORM-FE-' } }, { serial_number: { startsWith: 'QA-UI-' } }, ...(ids.length ? [{ senior_id: { in: ids } }] : [])] },
    select: { id: true },
  });
  const deviceIds = qaDevices.map((d) => d.id);
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
  await prisma.devices.deleteMany({ where: { OR: [{ serial_number: { startsWith: 'QA-PLATFORM-FE-' } }, { serial_number: { startsWith: 'QA-UI-' } }] } }).catch(() => undefined);
  if (ids.length) await prisma.users.deleteMany({ where: { id: { in: ids } } }).catch(() => undefined);

  for (const id of ids) await deleteAuthUser(id);
  for (let page = 1; page <= 10; page += 1) {
    const { data, error } = await supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) break;
    const matching = data.users.filter((u) => u.email?.startsWith('qa-platform-fe-') || u.email?.startsWith('qa-ui-'));
    for (const u of matching) await deleteAuthUser(u.id);
    if (data.users.length < 1000) break;
  }
}

async function createUser(role: Role, stamp: string): Promise<UserFixture> {
  const lower = role.toLowerCase();
  const email = `qa-platform-fe-${lower}-${stamp}@example.com`;
  const password = `Qa!${stamp.slice(-6)}xA9`;
  const firstName = role === 'ADMIN' ? 'QA Admin' : role === 'CAREGIVER' ? 'QA Caregiver' : 'QA Senior';
  const lastName = stamp.slice(-5);
  const { data, error } = await supabaseAdmin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { role } });
  if (error || !data.user) throw new Error(`Unable to create ${role}: ${error?.message || 'unknown'}`);
  await prisma.users.create({ data: { id: data.user.id, email, first_name: firstName, last_name: lastName, role } });
  return { id: data.user.id, email, password, firstName, lastName, role };
}

async function setup(): Promise<Fixture> {
  await cleanupQaArtifacts(loadFixture());
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const admin = await createUser('ADMIN', stamp);
  const caregiver = await createUser('CAREGIVER', stamp);
  const senior = await createUser('SENIOR', stamp);
  await prisma.caregiver_senior.create({ data: { caregiver_id: caregiver.id, senior_id: senior.id } });

  const pod = await prisma.devices.create({ data: { serial_number: `QA-PLATFORM-FE-POD-${stamp}`, type: 'POD', senior_id: senior.id, battery_level: 93 } });
  const wearable = await prisma.devices.create({ data: { serial_number: `QA-PLATFORM-FE-WEAR-${stamp}`, type: 'WEARABLE', senior_id: senior.id, battery_level: 88 } });
  await prisma.environmental_readings.create({ data: { device_id: pod.id, temperature: 22.6, humidity: 45.1, gas_resistance: 118000, air_quality_score: 78, occupancy: true, recorded_at: new Date() } });
  await prisma.activity_events.create({ data: { device_id: wearable.id, type: 'REGULAR_MOVEMENT', metadata: { qa: true }, recorded_at: new Date() } });

  // Seed one medication so the Senior medication action can be tested independently.
  const time = new Date('1970-01-01T12:00:00.000Z');
  const medication = await prisma.medication_schedules.create({ data: { senior_id: senior.id, medicine_name: `QA Vitamin ${stamp.slice(-4)}`, dosage: '1 tablet', time_of_day: time } });

  const fixture: Fixture = {
    stamp,
    createdAt: new Date().toISOString(),
    users: { admin, caregiver, senior },
    devices: { podId: pod.id, wearableId: wearable.id, podSerial: pod.serial_number, wearableSerial: wearable.serial_number },
    medication: { id: medication.id, name: medication.medicine_name },
  };
  fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));
  return fixture;
}

async function main() {
  await prisma.$connect();
  try {
    if (action === 'cleanup') {
      await cleanupQaArtifacts(loadFixture());
      try { if (fs.existsSync(fixturePath)) fs.unlinkSync(fixturePath); } catch {}
      console.log(JSON.stringify({ status: 'PASS', action: 'cleanup' }, null, 2));
    } else {
      const fixture = await setup();
      console.log(JSON.stringify({ status: 'PASS', action: 'setup', fixturePath, users: 3, devices: 2, medication: fixture.medication.name }, null, 2));
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(error);
  try { await cleanupQaArtifacts(loadFixture()); } catch {}
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
