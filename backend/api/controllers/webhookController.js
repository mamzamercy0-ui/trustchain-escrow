import webhookService from '../../services/webhookService.js';
import { parsePagination } from '../../lib/pagination.js';

/**
 * Allowed filter values for delivery status — used to prevent open-string injection
 * into the Prisma where clause.
 */
const ALLOWED_DELIVERY_STATUSES = new Set(['pending', 'success', 'failed']);

const MAX_EVENT_TYPES = 20;
const ALLOWED_SCHEMES = ['https:'];

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

export default {
  subscribe,
  listSubscriptions,
  deleteSubscription,
  getDeliveries,
};
