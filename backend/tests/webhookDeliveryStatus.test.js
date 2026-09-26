/**
 * Tests for webhook delivery status query  (Issue #203)
 *
 * Covers:
 *  - getDeliveryHistory: successful deliveries paged response
 *  - getDeliveryHistory: failed deliveries filtered by status
 *  - getDeliveryHistory: 404 when subscription belongs to another user
 *  - getDeliveries controller: invalid status filter → 400
 *  - getDeliveries controller: valid status filter forwarded to service
 *  - getDeliveries controller: subscription not found → 404
 *  - getDeliveries controller: successful response structure
 */

import { jest, describe, it, expect, beforeEach } from '@jest/globals';

// ── Mocks ─────────────────────────────────────────────────────────────────────

const prismaMock = {
  webhookSubscription: {
    create: jest.fn(),
    findFirst: jest.fn(),
    findMany: jest.fn(),
    deleteMany: jest.fn(),
  },
  webhookDelivery: {
    create: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
    findMany: jest.fn(),
  },
};

const queueMock = { enqueueWebhookDelivery: jest.fn() };

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeDelivery(overrides = {}) {
  return {
    id: 'del_1',
    eventType: 'esc_crt',
    status: 'success',
    attempts: 1,
    responseCode: 200,
    errorMessage: null,
    lastAttemptAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

// ── webhookService.getDeliveryHistory ─────────────────────────────────────────

describe('webhookService — getDeliveryHistory', () => {
  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.unstable_mockModule('../lib/prisma.js', () => ({ default: prismaMock }));
    jest.unstable_mockModule('../queues/webhookQueue.js', () => ({
      enqueueWebhookDelivery: queueMock.enqueueWebhookDelivery,
    }));
  });

  it('returns paginated deliveries when subscription belongs to caller', async () => {
    prismaMock.webhookSubscription.findFirst.mockResolvedValue({ id: 'sub_1' });
    const deliveries = [makeDelivery(), makeDelivery({ id: 'del_2', status: 'failed' })];
    prismaMock.webhookDelivery.findMany.mockResolvedValue(deliveries);
    prismaMock.webhookDelivery.count.mockResolvedValue(2);

    const { default: webhookService } = await import('../services/webhookService.js');
    const result = await webhookService.getDeliveryHistory({
      subscriptionId: 'sub_1',
      createdBy: '0xABC',
      page: 1,
      limit: 30,
    });

    expect(result).toMatchObject({ page: 1, limit: 30, total: 2 });
    expect(result.deliveries).toHaveLength(2);
  });

  it('returns null when subscription does not belong to caller', async () => {
    prismaMock.webhookSubscription.findFirst.mockResolvedValue(null);

    const { default: webhookService } = await import('../services/webhookService.js');
    const result = await webhookService.getDeliveryHistory({
      subscriptionId: 'sub_other',
      createdBy: '0xABC',
    });

    expect(result).toBeNull();
    expect(prismaMock.webhookDelivery.findMany).not.toHaveBeenCalled();
  });

  it('filters by status when status option is provided', async () => {
    prismaMock.webhookSubscription.findFirst.mockResolvedValue({ id: 'sub_1' });
    const failedDelivery = makeDelivery({ status: 'failed', responseCode: null, errorMessage: 'timeout' });
    prismaMock.webhookDelivery.findMany.mockResolvedValue([failedDelivery]);
    prismaMock.webhookDelivery.count.mockResolvedValue(1);

    const { default: webhookService } = await import('../services/webhookService.js');
    const result = await webhookService.getDeliveryHistory({
      subscriptionId: 'sub_1',
      createdBy: '0xABC',
      status: 'failed',
    });

    expect(result.deliveries).toHaveLength(1);
    expect(result.deliveries[0].status).toBe('failed');
    // The where clause should have included status: 'failed'
    expect(prismaMock.webhookDelivery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ status: 'failed' }) }),
    );
  });

  it('does not filter by status when status is null', async () => {
    prismaMock.webhookSubscription.findFirst.mockResolvedValue({ id: 'sub_1' });
    prismaMock.webhookDelivery.findMany.mockResolvedValue([]);
    prismaMock.webhookDelivery.count.mockResolvedValue(0);

    const { default: webhookService } = await import('../services/webhookService.js');
    await webhookService.getDeliveryHistory({
      subscriptionId: 'sub_1',
      createdBy: '0xABC',
      status: null,
    });

    const callArg = prismaMock.webhookDelivery.findMany.mock.calls[0][0];
    expect(callArg.where.status).toBeUndefined();
  });

  it('respects page / limit for pagination', async () => {
    prismaMock.webhookSubscription.findFirst.mockResolvedValue({ id: 'sub_1' });
    prismaMock.webhookDelivery.findMany.mockResolvedValue([]);
    prismaMock.webhookDelivery.count.mockResolvedValue(100);

    const { default: webhookService } = await import('../services/webhookService.js');
    const result = await webhookService.getDeliveryHistory({
      subscriptionId: 'sub_1',
      createdBy: '0xABC',
      page: 3,
      limit: 10,
    });

    expect(result.page).toBe(3);
    expect(result.limit).toBe(10);
    expect(prismaMock.webhookDelivery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 20, take: 10 }),
    );
  });
});

// ── webhookController.getDeliveries ──────────────────────────────────────────

describe('webhookController — getDeliveries', () => {
  let controller;

  const mockWebhookService = {
    getDeliveryHistory: jest.fn(),
    createSubscription: jest.fn(),
    listSubscriptions: jest.fn(),
    deleteSubscription: jest.fn(),
    queueEventWebhooks: jest.fn(),
    signPayload: jest.fn(),
  };

  beforeEach(async () => {
    jest.resetModules();
    jest.clearAllMocks();
    jest.unstable_mockModule('../services/webhookService.js', () => ({
      default: mockWebhookService,
    }));
    jest.unstable_mockModule('../lib/pagination.js', () => ({
      parsePagination: jest.fn(({ limit, ...q }) => ({
        page: parseInt(q.page ?? '1'),
        limit: parseInt(q.limit ?? String(limit ?? 30)),
      })),
    }));

    const mod = await import('../api/controllers/webhookController.js');
    controller = mod.default;
  });

  function makeRes() {
    const res = { _status: 200, _body: null };
    res.status = jest.fn().mockImplementation((s) => { res._status = s; return res; });
    res.json   = jest.fn().mockImplementation((b) => { res._body  = b; return res; });
    return res;
  }

  it('returns 400 when status filter is not in the allow-list', async () => {
    const req = { params: { id: 'sub_1' }, query: { status: 'unknown' }, user: { address: '0xABC' } };
    const res = makeRes();

    await controller.getDeliveries(req, res);

    expect(res._status).toBe(400);
    expect(res._body.error).toMatch(/Invalid status filter/);
  });

  it('returns 404 when subscription is not found / owned by another user', async () => {
    mockWebhookService.getDeliveryHistory.mockResolvedValue(null);
    const req = { params: { id: 'sub_x' }, query: {}, user: { address: '0xABC' } };
    const res = makeRes();

    await controller.getDeliveries(req, res);

    expect(res._status).toBe(404);
    expect(res._body.error).toMatch(/not found/i);
  });

  it('returns 200 with delivery result for a valid request', async () => {
    const deliveryResult = { page: 1, limit: 30, total: 1, deliveries: [makeDelivery()] };
    mockWebhookService.getDeliveryHistory.mockResolvedValue(deliveryResult);

    const req = { params: { id: 'sub_1' }, query: {}, user: { address: '0xABC' } };
    const res = makeRes();

    await controller.getDeliveries(req, res);

    expect(res._body).toEqual(deliveryResult);
  });

  it('passes status filter to service when valid', async () => {
    mockWebhookService.getDeliveryHistory.mockResolvedValue({
      page: 1, limit: 30, total: 0, deliveries: [],
    });
    const req = { params: { id: 'sub_1' }, query: { status: 'failed' }, user: { address: '0xABC' } };
    const res = makeRes();

    await controller.getDeliveries(req, res);

    expect(mockWebhookService.getDeliveryHistory).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'failed' }),
    );
  });

  it('passes null status to service when status is omitted', async () => {
    mockWebhookService.getDeliveryHistory.mockResolvedValue({
      page: 1, limit: 30, total: 0, deliveries: [],
    });
    const req = { params: { id: 'sub_1' }, query: {}, user: { address: '0xABC' } };
    const res = makeRes();

    await controller.getDeliveries(req, res);

    expect(mockWebhookService.getDeliveryHistory).toHaveBeenCalledWith(
      expect.objectContaining({ status: null }),
    );
  });

  it('returns 500 on unexpected service error', async () => {
    mockWebhookService.getDeliveryHistory.mockRejectedValue(new Error('DB crash'));
    const req = { params: { id: 'sub_1' }, query: {}, user: { address: '0xABC' } };
    const res = makeRes();

    await controller.getDeliveries(req, res);

    expect(res._status).toBe(500);
    expect(res._body.error).toBe('DB crash');
  });
});
