import webhookService from '../../services/webhookService.js';
import { parsePagination } from '../../lib/pagination.js';

/**
 * Allowed filter values for delivery status — used to prevent open-string injection
 * into the Prisma where clause.
 */
const ALLOWED_DELIVERY_STATUSES = new Set(['pending', 'success', 'failed']);

const MAX_EVENT_TYPES = 20;
const ALLOWED_SCHEMES = ['https:'];

/**
 * Webhook delivery latency SLA
 *
 * Normal delivery: webhooks are dispatched within 5 seconds (p95) of the
 * originating event being committed. The target SLA is 99% of deliveries
 * acknowledged with a 2xx response within 10 seconds.
 *
 * Degraded delivery: when the endpoint is slow or intermittently failing,
 * deliveries may take up to 60 seconds (p95) while retries are in flight.
 * The subscription remains active and events continue to be queued.
 *
 * Paused delivery: after the circuit breaker trips (see below), delivery is
 * paused for the subscription. No new attempts are made until the breaker
 * moves to half-open. Events are retained for the configured retention
 * window and replayed once delivery resumes.
 */

/**
 * Retry backoff
 *
 * Failed deliveries (non-2xx response, timeout, or connection error) are
 * retried with exponential backoff and jitter:
 *
 *   attempt 1: immediate
 *   attempt 2: ~30s
 *   attempt 3: ~2m
 *   attempt 4: ~10m
 *   attempt 5: ~1h
 *
 * After the final attempt the delivery is marked as failed and surfaced via
 * the delivery history endpoint. Backoff is capped at 1 hour per attempt.
 */

/**
 * Circuit breaker
 *
 * Each subscription has an independent circuit breaker:
 *
 *   closed    - normal operation; deliveries are attempted immediately.
 *   open      - tripped after repeated failures; deliveries are paused and
 *               no requests are sent to the endpoint.
 *   half-open - after a cooldown, a single probe delivery is attempted. A
 *               success closes the breaker; a failure re-opens it.
 *
 * The breaker state is exposed through the SLA metrics endpoint so callers
 * can distinguish a paused subscription from a healthy one.
 */

/**
 * Status inspection
 *
 * GET /webhooks/:id/deliveries returns paginated delivery history, including
 * per-attempt status codes and timestamps, for inspecting individual events.
 *
 * GET /webhooks/:id/sla-metrics returns aggregated latency and reliability
 * metrics (success rate, p95 latency, breaker state) for the subscription.
 */

function isValidWebhookUrl(raw) {
  try {
    const parsed = new URL(raw);
    return ALLOWED_SCHEMES.includes(parsed.protocol);
  } catch {
    return false;
  }
}

const subscribe = async (req, res) => {
  try {
    const { url, eventTypes } = req.body;

    if (!url || !isValidWebhookUrl(url)) {
      return res.status(400).json({ error: 'url must be a valid HTTPS URL' });
    }

    if (!Array.isArray(eventTypes) || eventTypes.length === 0) {
      return res.status(400).json({ error: 'eventTypes must be a non-empty array' });
    }

    if (eventTypes.length > MAX_EVENT_TYPES) {
      return res
        .status(400)
        .json({ error: `eventTypes may not exceed ${MAX_EVENT_TYPES} entries` });
    }

    const result = await webhookService.createSubscription({
      url,
      eventTypes: eventTypes.slice(0, MAX_EVENT_TYPES),
      createdBy: req.user?.address || null,
    });

    res.status(201).json({ data: result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const listSubscriptions = async (req, res) => {
  try {
    const subscriptions = await webhookService.listSubscriptions({
      createdBy: req.user?.address || null,
    });
    res.json({ data: subscriptions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const deleteSubscription = async (req, res) => {
  try {
    const deleted = await webhookService.deleteSubscription({
      id: req.params.id,
      createdBy: req.user?.address || null,
    });

    if (!deleted) {
      return res.status(404).json({ error: 'Webhook subscription not found' });
    }

    res.status(204).send();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

/**
 * GET /api/v1/webhooks/:id/deliveries
 *
 * Query recent delivery attempts for a subscription owned by the authenticated
 * user.  The query is subscription-scoped: a subscription that does not belong
 * to the caller returns 404 rather than leaking cross-tenant data.
 *
 * Query params:
 *   page    — default 1
 *   limit   — default 30, max 100
 *   status  — optional filter: pending | success | failed
 */
const getDeliveries = async (req, res) => {
  try {
    const { page, limit } = parsePagination({ limit: 30, ...req.query });

    // Optional status filter — validated against the allow-list to prevent injection
    const { status } = req.query;
    if (status !== undefined && !ALLOWED_DELIVERY_STATUSES.has(status)) {
      return res.status(400).json({
        error: `Invalid status filter. Allowed values: ${[...ALLOWED_DELIVERY_STATUSES].join(', ')}`,
      });
    }

    const result = await webhookService.getDeliveryHistory({
      subscriptionId: req.params.id,
      createdBy: req.user?.address || null,
      page,
      limit,
      status: status || null,
    });

    // 404 when the subscription doesn't exist or belongs to another user
    if (!result) {
      return res.status(404).json({ error: 'Webhook subscription not found' });
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

const getSlaMetrics = async (req, res) => {
  try {
    const { page, limit } = parsePagination({ limit: 30, ...req.query });

    const result = await webhookService.getSlaMetrics({
      subscriptionId: req.params.id,
      createdBy: req.user?.address || null,
      page,
      limit,
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};

export default {
  subscribe,
  listSubscriptions,
  deleteSubscription,
  getDeliveries,
  getSlaMetrics,
};
