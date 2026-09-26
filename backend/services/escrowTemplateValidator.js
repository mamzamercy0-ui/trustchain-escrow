/**
 * Escrow Template Validator  (Issue #204)
 *
 * Validates escrow template payloads server-side before any on-chain or DB
 * operations are attempted.  Checks:
 *
 *  - clientAddress / freelancerAddress / arbiterAddress — valid Stellar G-addresses
 *  - tokenAddress   — non-empty string (contract ID or native)
 *  - milestones     — non-empty array; each milestone has title, amount > 0, and
 *                     an optional deadline that is a valid future ISO date
 *  - deadline       — optional top-level deadline; must be a future ISO date
 *  - milestone total ≤ totalAmount (when both are supplied)
 *
 * Returns { valid: true } or { valid: false, errors: FieldError[] }.
 *
 * @module services/escrowTemplateValidator
 */

/** Stellar G-address regex: starts with G, 56 uppercase base-32 chars total. */
const STELLAR_ADDRESS_RE = /^G[A-Z2-7]{55}$/;

/**
 * @typedef {{ field: string, message: string }} FieldError
 * @typedef {{ valid: true }} ValidResult
 * @typedef {{ valid: false, errors: FieldError[] }} InvalidResult
 * @typedef {ValidResult | InvalidResult} ValidationResult
 */

/**
 * Validate a single Stellar address field.
 * @param {string}      field  dot-path label used in error messages
 * @param {unknown}     value
 * @param {FieldError[]} errors  mutated in-place
 * @param {boolean}     [required=true]
 */
function validateAddress(field, value, errors, required = true) {
  if (value === undefined || value === null || value === '') {
    if (required) errors.push({ field, message: `${field} is required` });
    return;
  }
  if (typeof value !== 'string' || !STELLAR_ADDRESS_RE.test(value.trim())) {
    errors.push({ field, message: `${field} must be a valid Stellar G-address` });
  }
}

/**
 * Validate an ISO-8601 datetime string that must be in the future.
 * @param {string}      field
 * @param {unknown}     value
 * @param {FieldError[]} errors
 * @param {boolean}     [required=false]
 */
function validateFutureDate(field, value, errors, required = false) {
  if (value === undefined || value === null || value === '') {
    if (required) errors.push({ field, message: `${field} is required` });
    return;
  }
  const ts = Date.parse(String(value));
  if (Number.isNaN(ts)) {
    errors.push({ field, message: `${field} must be a valid ISO-8601 date` });
    return;
  }
  if (ts <= Date.now()) {
    errors.push({ field, message: `${field} must be a future date` });
  }
}

/**
 * Validate a decimal/BigInt amount string — must be a positive number.
 * @param {string}      field
 * @param {unknown}     value
 * @param {FieldError[]} errors
 * @param {boolean}     [required=true]
 * @returns {bigint|null}  parsed value on success, null otherwise
 */
function validateAmount(field, value, errors, required = true) {
  if (value === undefined || value === null || value === '') {
    if (required) errors.push({ field, message: `${field} is required` });
    return null;
  }
  const str = String(value).trim();
  // Accept integers or decimals represented as strings or numbers
  if (!/^\d+(\.\d+)?$/.test(str) || parseFloat(str) <= 0) {
    errors.push({ field, message: `${field} must be a positive number` });
    return null;
  }
  // Return as BigInt (strip decimals — on-chain amounts are integer stroops)
  try {
    return BigInt(Math.round(parseFloat(str)));
  } catch {
    return null;
  }
}

/**
 * Validate the milestones array.
 *
 * Rules:
 *  - Must be a non-empty array
 *  - Each milestone must have: title (non-empty string), amount (positive), optional deadline (future ISO date)
 *  - Milestone indices must be unique integers ≥ 0 when provided
 *
 * @param {unknown}     milestones
 * @param {FieldError[]} errors
 * @returns {bigint}  sum of milestone amounts (0n on error)
 */
function validateMilestones(milestones, errors) {
  if (!Array.isArray(milestones) || milestones.length === 0) {
    errors.push({ field: 'milestones', message: 'milestones must be a non-empty array' });
    return 0n;
  }

  let milestoneTotal = 0n;
  const seenIndices = new Set();

  for (let i = 0; i < milestones.length; i++) {
    const m = milestones[i];
    const prefix = `milestones[${i}]`;

    if (typeof m !== 'object' || m === null) {
      errors.push({ field: prefix, message: `${prefix} must be an object` });
      continue;
    }

    // title
    if (!m.title || typeof m.title !== 'string' || m.title.trim() === '') {
      errors.push({ field: `${prefix}.title`, message: `${prefix}.title must be a non-empty string` });
    }

    // amount
    const amt = validateAmount(`${prefix}.amount`, m.amount, errors);
    if (amt !== null) milestoneTotal += amt;

    // optional deadline
    if (m.deadline !== undefined && m.deadline !== null) {
      validateFutureDate(`${prefix}.deadline`, m.deadline, errors, false);
    }

    // optional milestoneIndex uniqueness check
    if (m.milestoneIndex !== undefined) {
      const idx = parseInt(m.milestoneIndex, 10);
      if (!Number.isInteger(idx) || idx < 0) {
        errors.push({
          field: `${prefix}.milestoneIndex`,
          message: `${prefix}.milestoneIndex must be a non-negative integer`,
        });
      } else if (seenIndices.has(idx)) {
        errors.push({
          field: `${prefix}.milestoneIndex`,
          message: `${prefix}.milestoneIndex ${idx} is duplicated`,
        });
      } else {
        seenIndices.add(idx);
      }
    }
  }

  return milestoneTotal;
}

/**
 * Validate a complete escrow template payload.
 *
 * @param {object} template
 * @param {string}   template.clientAddress
 * @param {string}   template.freelancerAddress
 * @param {string}   [template.arbiterAddress]
 * @param {string}   template.tokenAddress
 * @param {string|number} template.totalAmount
 * @param {Array}    template.milestones
 * @param {string}   [template.deadline]
 * @returns {ValidationResult}
 */
export function validateEscrowTemplate(template) {
  if (typeof template !== 'object' || template === null) {
    return { valid: false, errors: [{ field: 'body', message: 'Request body must be an object' }] };
  }

  const errors = /** @type {FieldError[]} */ ([]);

  // ── Address fields ────────────────────────────────────────────────────────
  validateAddress('clientAddress', template.clientAddress, errors, true);
  validateAddress('freelancerAddress', template.freelancerAddress, errors, true);
  validateAddress('arbiterAddress', template.arbiterAddress, errors, false);

  // Addresses must be distinct
  if (
    template.clientAddress &&
    template.freelancerAddress &&
    STELLAR_ADDRESS_RE.test(String(template.clientAddress).trim()) &&
    STELLAR_ADDRESS_RE.test(String(template.freelancerAddress).trim()) &&
    template.clientAddress.trim() === template.freelancerAddress.trim()
  ) {
    errors.push({
      field: 'freelancerAddress',
      message: 'clientAddress and freelancerAddress must be different',
    });
  }

  // ── Token address ─────────────────────────────────────────────────────────
  if (!template.tokenAddress || typeof template.tokenAddress !== 'string' || template.tokenAddress.trim() === '') {
    errors.push({ field: 'tokenAddress', message: 'tokenAddress is required' });
  }

  // ── Total amount ──────────────────────────────────────────────────────────
  const totalAmt = validateAmount('totalAmount', template.totalAmount, errors);

  // ── Milestones ────────────────────────────────────────────────────────────
  const milestoneTotal = validateMilestones(template.milestones, errors);

  // ── Cross-field: milestone totals must not exceed totalAmount ─────────────
  if (
    totalAmt !== null &&
    totalAmt > 0n &&
    milestoneTotal > 0n &&
    milestoneTotal > totalAmt
  ) {
    errors.push({
      field: 'milestones',
      message: `Sum of milestone amounts (${milestoneTotal}) exceeds totalAmount (${totalAmt})`,
    });
  }

  // ── Top-level deadline ────────────────────────────────────────────────────
  if (template.deadline !== undefined && template.deadline !== null) {
    validateFutureDate('deadline', template.deadline, errors, false);
  }

  if (errors.length > 0) return { valid: false, errors };
  return { valid: true };
}

export default { validateEscrowTemplate };
