import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import { createClient } from '@supabase/supabase-js';
import { PrismaService } from '../src/prisma/prisma.service';

const resultsDir = process.env.QA_RESULTS_DIR || path.resolve(process.cwd(), 'qa-results', 'browser');
const fixturePath = process.env.QA_BROWSER_FIXTURE_PATH || path.join(resultsDir, 'browser-fixtures.json');
const action = (process.env.QA_FIXTURE_ACTION || 'setup').toLowerCase();
fs.mkdirSync(resultsDir, { recursive: true });

const supabaseUrl = process.env.SUPABASE_URL;
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!supabaseUrl || !serviceKey) {
  throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for browser QA fixtures.');
}

const supabaseAdmin = createClient(supabaseUrl, serviceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});
const prisma = new PrismaService();

type Role = 'ADMIN' | 'CAREGIVER' | 'SENIOR';
interface TestUser {
  id: string;
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  role: Role;
}
interface FixtureFile {
  createdAt: string;
  users: { admin: TestUser; caregiver: TestUser; senior: TestUser };
  devices: { podId: string; wearableId: string; podSerial: string; wearableSerial: string };
}

function loadFixture(): FixtureFile | null {
  if (!fs.existsSync(fixturePath)) return null;
  return JSON.parse(fs.readFileSync(fixturePath, 'utf8')) as FixtureFile;
}

async function deleteAuthUser(id: string) {
  try { await supabaseAdmin.auth.admin.deleteUser(id); } catch {}
}

async function cleanupFixture(fixture: FixtureFile | null) {
  if (!fixture) return;
  const seniorId = fixture.users.senior.id;
  const caregiverId = fixture.users.caregiver.id;
  const userIds = [fixture.users.admin.id, caregiverId, seniorId];
  const deviceIds = [fixture.devices.podId, fixture.devices.wearableId];

  try { await prisma.medication_schedules.deleteMany({ where: { senior_id: seniorId } }); } catch {}
  try { await prisma.caregiver_journal.deleteMany({ where: { OR: [{ senior_id: seniorId }, { author_id: caregiverId }] } }); } catch {}
  try { await prisma.daily_checkins.deleteMany({ where: { senior_id: seniorId } }); } catch {}
  try { await prisma.alerts.deleteMany({ where: { senior_id: seniorId } }); } catch {}
  try { await prisma.thresholds.deleteMany({ where: { senior_id: seniorId } }); } catch {}
  try { await prisma.activity_events.deleteMany({ where: { device_id: { in: deviceIds } } }); } catch {}
  try { await prisma.environmental_readings.deleteMany({ where: { device_id: { in: deviceIds } } }); } catch {}
  try { await prisma.messages.deleteMany({ where: { OR: [{ sender_id: { in: userIds } }, { receiver_id: { in: userIds } }] } }); } catch {}
  try { await prisma.caregiver_senior.deleteMany({ where: { OR: [{ caregiver_id: caregiverId }, { senior_id: seniorId }] } }); } catch {}
  try { await prisma.devices.deleteMany({ where: { id: { in: deviceIds } } }); } catch {}
  try { await prisma.users.deleteMany({ where: { id: { in: userIds } } }); } catch {}

  for (const id of userIds) await deleteAuthUser(id);
}

async function createUser(role: Role, stamp: string): Promise<TestUser> {
  const lower = role.toLowerCase();
  const email = `qa-browser-${lower}-${stamp}@example.com`;
  const password = `Qa!${stamp.slice(-6)}xA9`;
  const firstName = role === 'ADMIN' ? 'QA Admin' : role === 'CAREGIVER' ? 'QA Caregiver' : 'QA Senior';
  const lastName = stamp.slice(-5);

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { role },
  });
  if (error || !data.user) throw new Error(`Unable to create ${role} auth user: ${error?.message || 'unknown error'}`);

  await prisma.users.create({
    data: {
      id: data.user.id,
      email,
      first_name: firstName,
      last_name: lastName,
      role,
    },
  });
  return { id: data.user.id, email, password, firstName, lastName, role };
}

async function setup(): Promise<FixtureFile> {
  const existing = loadFixture();
  if (existing) await cleanupFixture(existing);

  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const admin = await createUser('ADMIN', stamp);
  const caregiver = await createUser('CAREGIVER', stamp);
  const senior = await createUser('SENIOR', stamp);

  await prisma.caregiver_senior.create({ data: { caregiver_id: caregiver.id, senior_id: senior.id } });

  const pod = await prisma.devices.create({
    data: {
      serial_number: `QA-BROWSER-POD-${stamp}`,
      type: 'POD',
      senior_id: senior.id,
      battery_level: 91,
    },
  });
  const wearable = await prisma.devices.create({
    data: {
      serial_number: `QA-BROWSER-WEAR-${stamp}`,
      type: 'WEARABLE',
      senior_id: senior.id,
      battery_level: 87,
    },
  });

  await prisma.environmental_readings.create({
    data: {
      device_id: pod.id,
      temperature: 22.4,
      humidity: 46.2,
      gas_resistance: 118000,
      air_quality_score: 76,
      occupancy: true,
      recorded_at: new Date(),
    },
  });

  const fixture: FixtureFile = {
    createdAt: new Date().toISOString(),
    users: { admin, caregiver, senior },
    devices: {
      podId: pod.id,
      wearableId: wearable.id,
      podSerial: pod.serial_number,
      wearableSerial: wearable.serial_number,
    },
  };
  fs.writeFileSync(fixturePath, JSON.stringify(fixture, null, 2));
  console.log(JSON.stringify({ status: 'PASS', action: 'setup', fixturePath, usersCreated: 3, devicesCreated: 2 }, null, 2));
  return fixture;
}

async function main() {
  await prisma.$connect();
  try {
    if (action === 'cleanup') {
      const fixture = loadFixture();
      await cleanupFixture(fixture);
      try { if (fs.existsSync(fixturePath)) fs.unlinkSync(fixturePath); } catch {}
      console.log(JSON.stringify({ status: 'PASS', action: 'cleanup', fixtureFound: !!fixture }, null, 2));
      return;
    }
    await setup();
  } finally {
    await prisma.$disconnect();
  }
}

main().catch(async (error) => {
  console.error(error);
  try { await prisma.$disconnect(); } catch {}
  process.exit(1);
});
