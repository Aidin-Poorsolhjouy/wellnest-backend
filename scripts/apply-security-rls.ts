import 'dotenv/config';
import { Pool } from 'pg';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';

const TABLES = [
  'users',
  'caregiver_senior',
  'devices',
  'thresholds',
  'daily_checkins',
  'caregiver_journal',
  'medication_schedules',
  'medication_logs',
  'messages',
  'alerts',
  'environmental_readings',
  'activity_events',
];

async function main() {
  if (!process.env.DATABASE_URL) {
    throw new Error('DATABASE_URL is not configured');
  }

  const pool = new Pool({ connectionString: process.env.DATABASE_URL });

  try {
    const existing = await pool.query(
      `
        SELECT schemaname, tablename, policyname, permissive, roles, cmd, qual, with_check
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = ANY($1::text[])
        ORDER BY tablename, policyname
      `,
      [TABLES],
    );

    const securityDir = join(process.cwd(), 'security');
    await mkdir(securityDir, { recursive: true });

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const backupPath = join(
      securityDir,
      `policy-backup-before-hardening-${stamp}.json`,
    );
    await writeFile(
      backupPath,
      JSON.stringify(existing.rows, null, 2),
      'utf8',
    );

    console.log(`Backed up ${existing.rowCount ?? 0} existing policies to:`);
    console.log(backupPath);

    const sql = await readFile(
      join(process.cwd(), 'security', 'wellnest-rls.sql'),
      'utf8',
    );

    await pool.query(sql);

    const hardened = await pool.query(
      `
        SELECT tablename, policyname, roles, cmd
        FROM pg_policies
        WHERE schemaname = 'public'
          AND tablename = ANY($1::text[])
        ORDER BY tablename, policyname
      `,
      [TABLES],
    );

    console.log(
      `Security RLS applied successfully. Active policies: ${hardened.rowCount ?? 0}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
