/**
 * Tests for feature flag evaluation sampled logs  (Issue #199)
 *
 * Covers:
 *  - EvalReason.FLAG_NOT_FOUND emitted when flag does not exist
 *  - EvalReason.TENANT_OVERRIDE emitted when tenant override resolves the flag
 *  - EvalReason.FLAG_DISABLED emitted when flag is off and user not targeted
 *  - EvalReason.USER_TARGETED emitted when user is in targetUsers (flag off)
 *  - EvalReason.USER_TARGETED emitted when user is in targetUsers (flag on)
 *  - EvalReason.PERCENTAGE_ROLLOUT / PERCENTAGE_EXCLUDED for bucket evaluation
 *  - Sampling: log is skipped when sample rate = 0
 *  - Sampling: log is always emitted when sample rate = 1
 *  - Log entries never contain secrets (no password, token fields)
 *  - Configurable sample rate via FEATURE_FLAG_LOG_SAMPLE_RATE env var
 */

import { jest, describe, it, expect, beforeEach, afterEach } from '@jest/globals';

// ── Prisma mock ───────────────────────────────────────────────────────────────

const flagStore = new Map();
const tenantOverrideStore = new Map();

const prismaMock = {
  featureFlag: {
    findUnique: jest.fn(({ where }) => Promise.resolve(flagStore.get(where.key) ?? null)),
    findMany: jest.fn(() => Promise.resolve([...flagStore.values()])),
    create: jest.fn(({ data }) => {
      flagStore.set(data.key, { ...data, targetUsers: data.targetUsers ?? [] });
      return Promise.resolve(flagStore.get(data.key));
    }),
    update: jest.fn(({ where, data }) => {
      const existing = flagStore.get(where.key);
      if (!existing) throw new Error('Not found');
      const updated = { ...existing, ...data };
      flagStore.set(where.key, updated);
      return Promise.resolve(updated);
    }),
    delete: jest.fn(({ where }) => { flagStore.delete(where.key); return Promise.resolve(); }),
  },
  tenantFeatureFlagOverride: {
    findUnique: jest.fn(({ where }) => {
      const key = `${where.tenantId_flagKey.tenantId}:${where.tenantId_flagKey.flagKey}`;
      const record = tenantOverrideStore.get(key);
      return Promise.resolve(record ?? null);
    }),
    upsert: jest.fn(),
    delete: jest.fn(),
  },
  auditLog: {
    create: jest.fn(() => Promise.resolve()),
  },
};

jest.unstable_mockModule('../lib/prisma.js', () => ({ default: prismaMock }));

// ── Logger mock — capture log calls ──────────────────────────────────────────

const loggerInfoMock = jest.fn();
const loggerMock = {
  info: loggerInfoMock,
  warn: jest.fn(),
  error: jest.fn(),
  child: jest.fn().mockReturnThis(),
};

jest.unstable_mockModule('../config/logger.js', () => ({
  createModuleLogger: jest.fn(() => loggerMock),
  logger: loggerMock,
  logControllerError: jest.fn(),
  getLogger: jest.fn(() => loggerMock),
  requestContext: { getStore: () => undefined, run: (_, fn) => fn() },
  runWithCorrelation: (_, fn) => fn(),
  getCorrelationId: () => undefined,
}));

// Audit service mock
jest.unstable_mockModule('../services/auditService.js', () => ({
  log: jest.fn(() => Promise.resolve()),
  AuditCategory: { ADMIN: 'ADMIN' },
}));

const { isFeatureEnabled, createFlag, EvalReason } = await import('../services/featureFlags.js');

// ── Helpers ───────────────────────────────────────────────────────────────────

function lastLogCall() {
  const calls = loggerInfoMock.mock.calls;
  if (calls.length === 0) return null;
  return calls[calls.length - 1][0];
}

function setEnvSampleRate(rate) {
  process.env.FEATURE_FLAG_LOG_SAMPLE_RATE = String(rate);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Feature flag evaluation logs (Issue #199)', () => {
  beforeEach(() => {
    flagStore.clear();
    tenantOverrideStore.clear();
    jest.clearAllMocks();
    // Set sample rate to 1 so every evaluation is logged
    setEnvSampleRate(1);
  });

  afterEach(() => {
    delete process.env.FEATURE_FLAG_LOG_SAMPLE_RATE;
  });

  // ── EvalReason.FLAG_NOT_FOUND ─────────────────────────────────────────────

  describe('FLAG_NOT_FOUND reason', () => {
    it('emits FLAG_NOT_FOUND when the flag key does not exist', async () => {
      const result = await isFeatureEnabled('nonexistent-flag', { id: 'user-1' });

      expect(result).toBe(false);
      const entry = lastLogCall();
      expect(entry).toMatchObject({
        message: 'feature_flag_evaluated',
        flagKey: 'nonexistent-flag',
        variant: false,
        reason: EvalReason.FLAG_NOT_FOUND,
      });
    });
  });

  // ── EvalReason.TENANT_OVERRIDE ────────────────────────────────────────────

  describe('TENANT_OVERRIDE reason', () => {
    it('emits TENANT_OVERRIDE when a tenant override resolves to true', async () => {
      await createFlag({ key: 'feat-x', isEnabled: false, percentage: 0, targetUsers: [] }, 'admin');
      const overrideKey = 'tenant-99:feat-x';
      tenantOverrideStore.set(overrideKey, { tenantId: 'tenant-99', flagKey: 'feat-x', isEnabled: true });

      const result = await isFeatureEnabled('feat-x', { id: 'user-5', tenantId: 'tenant-99' });

      expect(result).toBe(true);
      const entry = lastLogCall();
      expect(entry).toMatchObject({
        flagKey: 'feat-x',
        tenantId: 'tenant-99',
        variant: true,
        reason: EvalReason.TENANT_OVERRIDE,
      });
    });

    it('emits TENANT_OVERRIDE when a tenant override resolves to false', async () => {
      await createFlag({ key: 'feat-y', isEnabled: true, percentage: 100, targetUsers: [] }, 'admin');
      const overrideKey = 'tenant-42:feat-y';
      tenantOverrideStore.set(overrideKey, { tenantId: 'tenant-42', flagKey: 'feat-y', isEnabled: false });

      const result = await isFeatureEnabled('feat-y', { id: 'user-7', tenantId: 'tenant-42' });

      expect(result).toBe(false);
      const entry = lastLogCall();
      expect(entry.reason).toBe(EvalReason.TENANT_OVERRIDE);
      expect(entry.variant).toBe(false);
    });
  });

  // ── EvalReason.FLAG_DISABLED ──────────────────────────────────────────────

  describe('FLAG_DISABLED reason', () => {
    it('emits FLAG_DISABLED when flag is off and user is not targeted', async () => {
      await createFlag({ key: 'off-flag', isEnabled: false, percentage: 0, targetUsers: [] }, 'admin');

      const result = await isFeatureEnabled('off-flag', { id: 'user-99' });

      expect(result).toBe(false);
      const entry = lastLogCall();
      expect(entry).toMatchObject({
        flagKey: 'off-flag',
        variant: false,
        reason: EvalReason.FLAG_DISABLED,
      });
    });
  });

  // ── EvalReason.USER_TARGETED ──────────────────────────────────────────────

  describe('USER_TARGETED reason', () => {
    it('emits USER_TARGETED when flag is off but user is in targetUsers', async () => {
      await createFlag(
        { key: 'beta', isEnabled: false, percentage: 0, targetUsers: ['user-42'] },
        'admin',
      );

      const result = await isFeatureEnabled('beta', { id: 'user-42' });

      expect(result).toBe(true);
      const entry = lastLogCall();
      expect(entry).toMatchObject({
        flagKey: 'beta',
        variant: true,
        reason: EvalReason.USER_TARGETED,
      });
    });

    it('emits USER_TARGETED when flag is on and user is explicitly in targetUsers', async () => {
      await createFlag(
        { key: 'early-access', isEnabled: true, percentage: 10, targetUsers: ['vip-user'] },
        'admin',
      );

      const result = await isFeatureEnabled('early-access', { id: 'vip-user' });

      expect(result).toBe(true);
      const entry = lastLogCall();
      expect(entry).toMatchObject({ reason: EvalReason.USER_TARGETED });
    });
  });

  // ── EvalReason.PERCENTAGE_ROLLOUT / PERCENTAGE_EXCLUDED ───────────────────

  describe('PERCENTAGE_ROLLOUT / PERCENTAGE_EXCLUDED reasons', () => {
    it('emits PERCENTAGE_ROLLOUT for a user whose bucket falls inside the rollout', async () => {
      // Use 100% to guarantee all users are enrolled
      await createFlag({ key: 'full-rollout', isEnabled: true, percentage: 100, targetUsers: [] }, 'admin');

      await isFeatureEnabled('full-rollout', { id: 'any-user' });

      const entry = lastLogCall();
      expect(entry.reason).toBe(EvalReason.PERCENTAGE_ROLLOUT);
      expect(entry.variant).toBe(true);
    });

    it('emits PERCENTAGE_EXCLUDED for a user whose bucket falls outside the rollout', async () => {
      // Use 0% to guarantee no users are enrolled
      await createFlag({ key: 'zero-rollout', isEnabled: true, percentage: 0, targetUsers: [] }, 'admin');

      await isFeatureEnabled('zero-rollout', { id: 'any-user' });

      const entry = lastLogCall();
      expect(entry.reason).toBe(EvalReason.PERCENTAGE_EXCLUDED);
      expect(entry.variant).toBe(false);
    });
  });

  // ── Sampling ──────────────────────────────────────────────────────────────

  describe('sampling behaviour', () => {
    it('never logs when sample rate is 0', async () => {
      setEnvSampleRate(0);
      await createFlag({ key: 'sample-zero', isEnabled: true, percentage: 100, targetUsers: [] }, 'admin');

      // Run many evaluations — none should emit a log
      for (let i = 0; i < 20; i++) {
        await isFeatureEnabled('sample-zero', { id: String(i) });
      }

      expect(loggerInfoMock).not.toHaveBeenCalled();
    });

    it('always logs when sample rate is 1', async () => {
      setEnvSampleRate(1);
      await createFlag({ key: 'sample-one', isEnabled: true, percentage: 100, targetUsers: [] }, 'admin');

      await isFeatureEnabled('sample-one', { id: 'u1' });
      await isFeatureEnabled('sample-one', { id: 'u2' });
      await isFeatureEnabled('sample-one', { id: 'u3' });

      expect(loggerInfoMock).toHaveBeenCalledTimes(3);
    });
  });

  // ── Secret safety ─────────────────────────────────────────────────────────

  describe('secret safety', () => {
    it('does not include password, token, or secret fields in log entries', async () => {
      setEnvSampleRate(1);
      await createFlag({ key: 'safe-flag', isEnabled: true, percentage: 100, targetUsers: [] }, 'admin');

      const userContextWithSecrets = {
        id: 'user-safe',
        tenantId: 'tenant-1',
        password: 'super-secret-password',
        token: 'Bearer eyJhbGciOi...',
        privateKey: 'SCZANGBA5SSEL6BKUWFHQKQQ62DXBZHDL3QTTBUCYQEZGT2VJCSMQEF',
      };

      await isFeatureEnabled('safe-flag', userContextWithSecrets);

      const entry = lastLogCall();
      expect(entry).not.toHaveProperty('password');
      expect(entry).not.toHaveProperty('token');
      expect(entry).not.toHaveProperty('privateKey');
      // Safe fields are present
      expect(entry).toHaveProperty('userId', 'user-safe');
      expect(entry).toHaveProperty('tenantId', 'tenant-1');
    });
  });

  // ── Log shape ─────────────────────────────────────────────────────────────

  describe('log entry shape', () => {
    it('includes flagKey, userId, tenantId, variant, and reason', async () => {
      setEnvSampleRate(1);
      await createFlag({ key: 'shape-flag', isEnabled: true, percentage: 100, targetUsers: [] }, 'admin');

      await isFeatureEnabled('shape-flag', { id: 'u-shape', tenantId: 't-shape' });

      const entry = lastLogCall();
      expect(entry).toMatchObject({
        message: 'feature_flag_evaluated',
        flagKey: 'shape-flag',
        userId: 'u-shape',
        tenantId: 't-shape',
        variant: expect.any(Boolean),
        reason: expect.any(String),
      });
    });

    it('omits tenantId from log when not provided in userContext', async () => {
      setEnvSampleRate(1);
      await createFlag({ key: 'no-tenant', isEnabled: true, percentage: 100, targetUsers: [] }, 'admin');

      await isFeatureEnabled('no-tenant', { id: 'u-notenant' });

      const entry = lastLogCall();
      // tenantId should be undefined, not a string 'undefined'
      expect(entry.tenantId).toBeUndefined();
    });
  });
});
