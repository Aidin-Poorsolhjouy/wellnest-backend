import 'dotenv/config';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

const apiBase = (process.env.QA_API_BASE_URL || '').replace(/\/+$/, '');
const frontendUrl = (process.env.QA_FRONTEND_URL || '').replace(/\/+$/, '');
const resultsDir = process.env.QA_RESULTS_DIR || path.resolve(process.cwd(), 'qa-results', 'security');
fs.mkdirSync(resultsDir, { recursive: true });

type Severity = 'HIGH' | 'MEDIUM' | 'LOW' | 'INFO';
type Finding = { id: string; severity: Severity; area: string; finding: string; evidence: string; recommendation: string };
const findings: Finding[] = [];
function add(id: string, severity: Severity, area: string, finding: string, evidence: string, recommendation: string) {
  findings.push({ id, severity, area, finding, evidence, recommendation });
}

async function main() {
  const usersController = fs.readFileSync(path.resolve(process.cwd(), 'src/users/users.controller.ts'), 'utf8');
  const telemetryController = fs.readFileSync(path.resolve(process.cwd(), 'src/telemetry/telemetry.controller.ts'), 'utf8');
  const mainSource = fs.readFileSync(path.resolve(process.cwd(), 'src/main.ts'), 'utf8');

  if (!/UseGuards|AuthGuard|CanActivate/.test(usersController)) {
    add('SEC-AUTH-001', 'HIGH', 'Backend authorization', 'User-management controller has no visible route guard.', 'users.controller.ts contains mutation endpoints but no UseGuards/AuthGuard reference.', 'Protect administrative and caregiver mutations with verified Supabase JWTs and role checks.');
  }
  if (!/UseGuards|AuthGuard|device.*token|api.?key/i.test(telemetryController)) {
    add('SEC-IOT-001', 'MEDIUM', 'Telemetry authentication', 'Telemetry ingestion has no visible device authentication at controller level.', 'HTTP/MQTT handlers accept deviceId plus payload without a device secret/signature in the controller.', 'Define device authentication (per-device credential, signed payload, or private broker ACL) and document the trust boundary.');
  }
  if (/app\.enableCors\(\s*\)/.test(mainSource)) {
    add('SEC-CORS-001', 'MEDIUM', 'CORS', 'Backend enables unrestricted default CORS.', 'main.ts calls app.enableCors() with no origin allowlist.', 'Restrict browser origins to the deployed WellNest frontend and intended development origins.');
  }

  if (apiBase) {
    try {
      const res = await axios.get(`${apiBase}/health`, { timeout: 15000, validateStatus: () => true, headers: { Origin: 'https://example-attacker.invalid' } });
      const aco = String(res.headers['access-control-allow-origin'] || '');
      if (aco === '*') add('SEC-CORS-DEP-001', 'MEDIUM', 'Deployed CORS', 'Deployed API permits any browser origin.', 'Access-Control-Allow-Origin: * on /health.', 'Use an explicit CORS allowlist.');
      const hsts = res.headers['strict-transport-security'];
      if (!hsts) add('SEC-HDR-001', 'LOW', 'Backend headers', 'HSTS header was not observed on the backend response.', 'Strict-Transport-Security absent from /health response.', 'Enable HSTS at the platform/proxy layer after confirming HTTPS-only operation.');
      const xcto = res.headers['x-content-type-options'];
      if (!xcto) add('SEC-HDR-002', 'LOW', 'Backend headers', 'X-Content-Type-Options header was not observed.', 'X-Content-Type-Options absent from /health response.', 'Add nosniff via the hosting proxy or Helmet.');
    } catch (error: any) {
      add('SEC-NET-001', 'INFO', 'Security audit', 'Backend header audit could not complete.', error.message, 'Re-run when the deployed backend is reachable.');
    }
  }

  if (frontendUrl) {
    try {
      const res = await axios.get(`${frontendUrl}/login`, { timeout: 15000, validateStatus: () => true });
      const csp = res.headers['content-security-policy'];
      if (!csp) add('SEC-FE-HDR-001', 'LOW', 'Frontend headers', 'Content-Security-Policy header was not observed.', 'CSP absent from deployed login response.', 'Consider a CSP compatible with Next.js/Supabase before final production handover.');
    } catch (error: any) {
      add('SEC-FE-NET-001', 'INFO', 'Security audit', 'Frontend header audit could not complete.', error.message, 'Re-run when the deployed frontend is reachable.');
    }
  }

  const severityCounts = { HIGH: 0, MEDIUM: 0, LOW: 0, INFO: 0 };
  for (const f of findings) severityCounts[f.severity]++;
  const output = { runAt: new Date().toISOString(), summary: { totalFindings: findings.length, ...severityCounts }, findings };
  fs.writeFileSync(path.join(resultsDir, 'security-audit-results.json'), JSON.stringify(output, null, 2));
  fs.writeFileSync(path.join(resultsDir, 'security-audit-results.csv'), ['id,severity,area,finding,evidence,recommendation']
    .concat(findings.map((f) => [f.id, f.severity, f.area, f.finding, f.evidence, f.recommendation].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(',')))
    .join('\n'));
  console.log(JSON.stringify(output, null, 2));
  // The audit is informational in this phase. Findings are carried into the handover report.
  process.exit(0);
}

main().catch((error) => { console.error(error); process.exit(1); });
