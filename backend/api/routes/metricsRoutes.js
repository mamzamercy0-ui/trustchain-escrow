/**
 * Metrics & Health Routes  (Issue #191 — Tenant-level metrics access control)
 *
 * Access rules:
 *
 *   GET /metrics
 *     ├── METRICS_TOKEN set   → requires Bearer <METRICS_TOKEN>  (scraper / ops)
 *     └── METRICS_TOKEN unset → open (fine for internal / dev networks)
 *
 *   GET /metrics/tenant          — tenant admin sees their own metrics snapshot
 *   GET /metrics/tenant/:tenantId — system admin only; sees any tenant's snapshot
 *   GET /metrics/global          — system admin only; global aggregated metrics
 *
 * User roles are read from req.user.role (string).
 * Tenant context is attached by the tenant middleware as req.tenant.id.
 *
 * Role hierarchy (least → most privileged):
 *   user < tenant_admin (role === 'admin') < system_admin (role === 'superadmin')
 */

import express from 'express';
import prisma from '../../lib/prisma.js';
import { register, cacheSize } from '../../lib/metrics.js';
import cache from '../../lib/cache.js';
import authMiddleware from '../middleware/auth.js';
import { createModuleLogger } from '../../config/logger.js';

const log = createModuleLogger('metricsRoutes');
const router = express.Router();

// ── Prometheus scrape token protection ───────────────────────────────────────

function metricsAuth(req, res, next) {
  const token = process.env.METRICS_TOKEN;
  if (!token) return next(); // no token configured → open (fine for internal networks)

  const auth = req.headers.authorization || '';
  if (auth === `Bearer ${token}`) return next();

  res.status(401).json({ error: 'Unauthorized' });
}

// ── Role helpers ──────────────────────────────────────────────────────────────

/**
 * Returns true when the user has the system-admin (superadmin) role.
 * @param {import('express').Request} req
 */
function isSystemAdmin(req) {
  return req.user?.role === 'superadmin' || req.isAdmin === true;
}

/**
 * Returns true when the user has the tenant-admin role OR is a system admin.
 * @param {import('express').Request} req
 */
function isTenantAdmin(req) {
  return req.user?.role === 'admin' || isSystemAdmin(req);
}

/**
 * Middleware: require the caller to be a system admin.
 */
function requireSystemAdmin(req, res, next) {
  if (!isSystemAdmin(req)) {
    log.warn({ message: 'metrics_access_denied', role: req.user?.role, path: req.path });
    return res.status(403).json({ error: 'Forbidden: system admin access required' });
  }
  next();
}

/**
 * Middleware: require the caller to be at least a tenant admin.
 */
function requireTenantAdmin(req, res, next) {
  if (!isTenantAdmin(req)) {
    log.warn({ message: 'metrics_access_denied', role: req.user?.role, path: req.path });
    return res.status(403).json({ error: 'Forbidden: tenant admin access required' });
  }
  next();
}

// ── Prometheus text endpoint ───────────────────────────────────────────────────

router.get('/', metricsAuth, async (_req, res) => {
  try {
    cacheSize.set(cache.size());
    res.set('Content-Type', register.contentType);
    res.end(await register.metrics());
  } catch (err) {
    res.status(500).end(err.message);
  }
});

// ── Tenant-scoped metrics snapshot ───────────────────────────────────────────

/**
 * Build a lightweight metrics snapshot for a given tenantId.
 * Queries are intentionally simple aggregates — not Prometheus format.
 */
async function buildTenantSnapshot(tenantId) {
  const [escrowCounts, disputeCount, userCount] = await Promise.all([
    prisma.escrow.groupBy({
      by: ['status'],
      where: { tenantId },
      _count: { id: true },
    }),
    prisma.dispute
      .count({ where: { tenantId } })
      .catch(() => 0), // dispute model may not have tenantId in older schemas
    prisma.user.count({ where: { tenantId } }).catch(() => null),
  ]);

  const statusMap = Object.fromEntries(
    escrowCounts.map((r) => [r.status.toLowerCase(), r._count.id]),
  );

  return {
    tenantId,
    escrows: {
      active: statusMap.active ?? 0,
      completed: statusMap.completed ?? 0,
      disputed: statusMap.disputed ?? 0,
      cancelled: statusMap.cancelled ?? 0,
      total: escrowCounts.reduce((s, r) => s + r._count.id, 0),
    },
    disputes: disputeCount,
    ...(userCount !== null ? { users: userCount } : {}),
    generatedAt: new Date().toISOString(),
  };
}

/**
 * GET /metrics/tenant
 *
 * Tenant admin: returns a metrics snapshot for their own tenant.
 * System admin: returns their own tenant (or use /metrics/tenant/:tenantId).
 */
router.get('/tenant', authMiddleware, requireTenantAdmin, async (req, res) => {
  try {
    const tenantId = req.tenant?.id ?? req.user?.tenantId;
    if (!tenantId) {
      return res.status(400).json({ error: 'Tenant context not available' });
    }
    const snapshot = await buildTenantSnapshot(tenantId);
    res.json({ data: snapshot });
  } catch (err) {
    log.error({ message: 'metrics_tenant_error', error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /metrics/tenant/:tenantId
 *
 * System admin only: inspect any tenant's metrics by ID.
 * Tenant admins receive 403 — they must use GET /metrics/tenant for their own data.
 */
router.get('/tenant/:tenantId', authMiddleware, requireSystemAdmin, async (req, res) => {
  try {
    const { tenantId } = req.params;

    // Verify tenant exists before building the snapshot
    const tenant = await prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, name: true },
    });
    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    const snapshot = await buildTenantSnapshot(tenantId);
    res.json({ data: { tenantName: tenant.name, ...snapshot } });
  } catch (err) {
    log.error({ message: 'metrics_tenant_by_id_error', error: err.message });
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /metrics/global
 *
 * System admin only: platform-wide aggregate metrics (all tenants combined).
 */
router.get('/global', authMiddleware, requireSystemAdmin, async (req, res) => {
  try {
    const [escrowCounts, tenantCount, userCount] = await Promise.all([
      prisma.escrow.groupBy({
        by: ['status'],
        _count: { id: true },
      }),
      prisma.tenant.count(),
      prisma.user.count().catch(() => null),
    ]);

    const statusMap = Object.fromEntries(
      escrowCounts.map((r) => [r.status.toLowerCase(), r._count.id]),
    );

    res.json({
      data: {
        tenants: tenantCount,
        ...(userCount !== null ? { users: userCount } : {}),
        escrows: {
          active: statusMap.active ?? 0,
          completed: statusMap.completed ?? 0,
          disputed: statusMap.disputed ?? 0,
          cancelled: statusMap.cancelled ?? 0,
          total: escrowCounts.reduce((s, r) => s + r._count.id, 0),
        },
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (err) {
    log.error({ message: 'metrics_global_error', error: err.message });
    res.status(500).json({ error: err.message });
  }
});

export default router;
