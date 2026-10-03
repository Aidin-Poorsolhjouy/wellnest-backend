# WellNest Backend

NestJS + Prisma backend for WellNest. It exposes the REST API, ingests Pod and wearable telemetry, evaluates thresholds/alerts, and connects to the MQTT broker when started through `src/main.ts`.

## Local setup

Copy `.env.example` to `.env` and provide your own PostgreSQL/Supabase/HiveMQ values.

```bash
npm install
npm run build
npm run start:dev
```

Health endpoint:

```text
GET /health
```

Swagger:

```text
/api/docs
```

Tests are normally run through the project-level command:

```bash
python qa/run_all.py
```
