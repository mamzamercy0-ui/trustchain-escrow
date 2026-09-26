/**
 * Tests for tenant-level metrics access control  (Issue #191)
 *
 * Covers:
 *  - GET /metrics/tenant        — tenant admin: own tenant OK
 *  - GET /metrics/tenant        — normal user: 403
 *  - GET /metrics/tenant/:id    — system admin: any tenant OK
 *  - GET /metrics/tenant/:id    — tenant admin: 403 (can only see own)
 *  - GET /metrics/tenant/:id    — system admin: 404 for unknown tenantId
 *  - GET /metrics/global        — system admin: OK
 *  - GET /metrics/global        — tenant admin: 403
 *  - GET /metrics/global        — normal user: 403
 *  - GET /metrics               — Prometheus scrape (auth token gating)
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import express from 'express';
import request from 'supertest';

// ── Prisma mock ───────────────────────────────────────────────────────────────

const prismaMock = {
  escrow: {
    groupBy: jest.fn(),
    count: jest.fn(),
  },
  dispute: {
    count: jest.fn(),
  },
  tenant: {
    count: jest.fn(),
    findUnique: jest.fn(),
  },
  user: {
    count: jest.fn(),
  },
};

jest.unstable_mockModule('../lib/prisma.js', () => ({ default: prismaMock }));

// ── Metrics / cache mocks ─────────────────────────────────────────────────────

const registerMock = {
  contentType: 'text/plain; version=0.0.4; charset=utf-8',
  metrics: jest.fn().mockResolvedValue('# HELP http_requests_total\n'),
};

const cacheMock = { size: jest.fn().mockReturnValue(0) };
const cacheSizeMock = { set: jest.fn() };

jest.unstable_mockModule('../lib/metrics.js', () => ({
  register: registerMock,
  cacheSize: cacheSizeMock,
}));
jest.unstable_mockModule('../lib/cache.js', () => ({ default: cacheMock }));

// Logger mock (silence output during tests)
jest.unstable_mockModule('../config/logger.js', () => ({
  createModuleLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn() }),
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
  logControllerError: jest.fn(),
  getLogger: jest.fn(),
  requestContext: { getStore: () => undefined, run: (_, fn) => fn() },
}));

// ── Auth middleware mock — controlled via req headers ────────────────────────
//
// We inject role via a custom header X-Test-Role:
//   superadmin  → req.user = { role: 'superadmin' }
//   admin       → req.user = { role: 'admin', tenantId: 'tenant-1' }
//   user        → req.user = { role: 'user', tenantId: 'tenant-1' }
//   <absent>    → 401

jest.unstable_mockModule('../api/middleware/auth.js', () => ({
  default: (req, res, next) => {
    const role = req.headers['x-test-role'];
    if (!role) return res.status(401).json({ error: 'Authentication required' });
    req.user = { role, address: 'G' + 'A'.repeat(55), tenantId: 'tenant-1' };
    if (role === 'superadmin') req.isAdmin = true;
    next();
  },
}));

// ── Build the test app ────────────────────────────────────────────────────────

const { default: metricsRouter } = await import('../api/routes/metricsRoutes.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  // Attach tenant context for /metrics/tenant (own tenant path)
  app.use((req, _res, next) => {
    if (req.user?.tenantId) req.tenant = { id: req.user.tenantId };
    next();
  });
  app.use('/metrics', metricsRouter);
  return app;
}

// ── Default Prisma return values ──────────────────────────────────────────────

function resetPrismaMocks() {
  prismaMock.escrow.groupBy.mockResolvedValue([
    { status: 'Active', _count: { id: 3 } },
    { status: 'Completed', _count: { id: 5 } },
  ]);
  prismaMock.dispute.count.mockResolvedValue(2);
  prismaMock.tenant.count.mockResolvedValue(4);
  prismaMock.tenant.findUnique.mockResolvedValue({ id: 'tenant-1', name: 'Acme Corp' });
  prismaMock.user.count.mockResolvedValue(10);
  prismaMock.escrow.count.mockResolvedValue(8);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Metrics access control (Issue #191)', () => {
  let app;

  beforeEach(() => {
    jest.clearAllMocks();
    resetPrismaMocks();
    app = buildApp();
  });

  afterEach(() => {
    delete process.env.METRICS_TOKEN;
  });

  // ── GET /metrics — Prometheus scrape ────────────────────────────────────────

  describe('GET /metrics (Prometheus scrape)', () => {
    it('returns 200 with Prometheus text when no METRICS_TOKEN is set', async () => {
      delete process.env.METRICS_TOKEN;
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toMatch(/text\/plain/);
    });

    it('returns 200 when Bearer token matches METRICS_TOKEN', async () => {
      process.env.METRICS_TOKEN = 'secret-scrape-token';
      const res = await request(app)
        .get('/metrics')
        .set('Authorization', 'Bearer secret-scrape-token');
      expect(res.status).toBe(200);
    });

    it('returns 401 when METRICS_TOKEN is set but token is wrong', async () => {
      process.env.METRICS_TOKEN = 'secret-scrape-token';
      const res = await request(app)
        .get('/metrics')
        .set('Authorization', 'Bearer wrong-token');
      expect(res.status).toBe(401);
    });

    it('returns 401 when METRICS_TOKEN is set but no Authorization header is sent', async () => {
      process.env.METRICS_TOKEN = 'secret-scrape-token';
      const res = await request(app).get('/metrics');
      expect(res.status).toBe(401);
    });
  });

  // ── GET /metrics/tenant ────────────────────────────────────────────────────

  describe('GET /metrics/tenant', () => {
    it('returns 200 with own tenant snapshot for a tenant admin', async () => {
      const res = await request(app).get('/metrics/tenant').set('x-test-role', 'admin');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('tenantId', 'tenant-1');
      expect(res.body.data).toHaveProperty('escrows');
    });

    it('returns 200 for system admin (superadmin)', async () => {
      const res = await request(app).get('/metrics/tenant').set('x-test-role', 'superadmin');
      expect(res.status).toBe(200);
    });

    it('returns 403 for a normal user', async () => {
      const res = await request(app).get('/metrics/tenant').set('x-test-role', 'user');
      expect(res.status).toBe(403);
    });

    it('returns 401 when not authenticated', async () => {
      const res = await request(app).get('/metrics/tenant');
      expect(res.status).toBe(401);
    });

    it('includes escrow status breakdown in the snapshot', async () => {
      const res = await request(app).get('/metrics/tenant').set('x-test-role', 'admin');
      expect(res.body.data.escrows).toMatchObject({
        active: expect.any(Number),
        completed: expect.any(Number),
        total: expect.any(Number),
      });
    });
  });

  // ── GET /metrics/tenant/:tenantId ──────────────────────────────────────────

  describe('GET /metrics/tenant/:tenantId', () => {
    it('returns 200 with snapshot for system admin viewing any tenant', async () => {
      const res = await request(app)
        .get('/metrics/tenant/tenant-1')
        .set('x-test-role', 'superadmin');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('tenantId', 'tenant-1');
      expect(res.body.data).toHaveProperty('tenantName', 'Acme Corp');
    });

    it('returns 403 when a tenant admin tries to view another tenant', async () => {
      const res = await request(app)
        .get('/metrics/tenant/tenant-other')
        .set('x-test-role', 'admin');
      expect(res.status).toBe(403);
    });

    it('returns 403 when a normal user attempts access', async () => {
      const res = await request(app)
        .get('/metrics/tenant/tenant-1')
        .set('x-test-role', 'user');
      expect(res.status).toBe(403);
    });

    it('returns 404 when tenantId does not exist', async () => {
      prismaMock.tenant.findUnique.mockResolvedValue(null);
      const res = await request(app)
        .get('/metrics/tenant/nonexistent-tenant')
        .set('x-test-role', 'superadmin');
      expect(res.status).toBe(404);
    });
  });

  // ── GET /metrics/global ────────────────────────────────────────────────────

  describe('GET /metrics/global', () => {
    it('returns 200 with global aggregate for system admin', async () => {
      const res = await request(app).get('/metrics/global').set('x-test-role', 'superadmin');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('tenants');
      expect(res.body.data).toHaveProperty('escrows');
    });

    it('returns 403 for tenant admin', async () => {
      const res = await request(app).get('/metrics/global').set('x-test-role', 'admin');
      expect(res.status).toBe(403);
    });

    it('returns 403 for normal user', async () => {
      const res = await request(app).get('/metrics/global').set('x-test-role', 'user');
      expect(res.status).toBe(403);
    });

    it('returns 401 when unauthenticated', async () => {
      const res = await request(app).get('/metrics/global');
      expect(res.status).toBe(401);
    });

    it('includes escrow status breakdown in global snapshot', async () => {
      const res = await request(app).get('/metrics/global').set('x-test-role', 'superadmin');
      expect(res.body.data.escrows).toMatchObject({
        active: expect.any(Number),
        completed: expect.any(Number),
        total: expect.any(Number),
      });
    });

    it('includes generatedAt timestamp', async () => {
      const res = await request(app).get('/metrics/global').set('x-test-role', 'superadmin');
      expect(res.body.data.generatedAt).toBeDefined();
      expect(new Date(res.body.data.generatedAt).toISOString()).toBeTruthy();
    });
  });
});
