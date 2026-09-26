/**
 * Tests for escrow template validation service  (Issue #204)
 *
 * Covers:
 *  - Valid template passes
 *  - Missing required address fields
 *  - Malformed Stellar addresses
 *  - client === freelancer address conflict
 *  - Missing/invalid tokenAddress
 *  - Missing/invalid totalAmount
 *  - Malformed milestone array (missing title, zero amount, etc.)
 *  - Duplicate milestoneIndex values
 *  - Milestone total exceeds totalAmount
 *  - Invalid past deadline (top-level and per-milestone)
 *  - arbiterAddress is optional but must be valid when present
 */

import { describe, it, expect, beforeEach } from '@jest/globals';
import { validateEscrowTemplate } from '../services/escrowTemplateValidator.js';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const VALID_CLIENT  = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';
const VALID_FREELANCER = 'GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPGK6XALXYQ7LGBKHSXJDAL4VXM';
const VALID_ARBITER = 'GDQP2KPQGKIHYJGXNUIYOMHARUARCA7DJT5FO2FFOOKY3B2WSQHG4W37';
const VALID_TOKEN   = 'CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC';

const FUTURE_DATE = new Date(Date.now() + 86_400_000).toISOString(); // tomorrow

function validTemplate(overrides = {}) {
  return {
    clientAddress:     VALID_CLIENT,
    freelancerAddress: VALID_FREELANCER,
    tokenAddress:      VALID_TOKEN,
    totalAmount:       '1000',
    milestones: [
      { title: 'Milestone 1', amount: '500' },
      { title: 'Milestone 2', amount: '500' },
    ],
    ...overrides,
  };
}

// ── Happy path ────────────────────────────────────────────────────────────────

describe('validateEscrowTemplate — valid payloads', () => {
  it('returns { valid: true } for a minimal valid template', () => {
    const result = validateEscrowTemplate(validTemplate());
    expect(result.valid).toBe(true);
  });

  it('accepts an optional arbiterAddress', () => {
    const result = validateEscrowTemplate(validTemplate({ arbiterAddress: VALID_ARBITER }));
    expect(result.valid).toBe(true);
  });

  it('accepts an optional top-level future deadline', () => {
    const result = validateEscrowTemplate(validTemplate({ deadline: FUTURE_DATE }));
    expect(result.valid).toBe(true);
  });

  it('accepts milestones with per-milestone future deadlines', () => {
    const result = validateEscrowTemplate(
      validTemplate({
        milestones: [
          { title: 'Phase 1', amount: '600', deadline: FUTURE_DATE },
          { title: 'Phase 2', amount: '400' },
        ],
      }),
    );
    expect(result.valid).toBe(true);
  });

  it('accepts milestone amounts that sum exactly to totalAmount', () => {
    const result = validateEscrowTemplate(
      validTemplate({
        totalAmount: '900',
        milestones: [
          { title: 'A', amount: '400' },
          { title: 'B', amount: '500' },
        ],
      }),
    );
    expect(result.valid).toBe(true);
  });

  it('accepts milestone amounts that sum below totalAmount', () => {
    const result = validateEscrowTemplate(
      validTemplate({
        totalAmount: '2000',
        milestones: [
          { title: 'A', amount: '500' },
          { title: 'B', amount: '500' },
        ],
      }),
    );
    expect(result.valid).toBe(true);
  });
});

// ── Address validation ────────────────────────────────────────────────────────

describe('validateEscrowTemplate — address fields', () => {
  it('fails when clientAddress is missing', () => {
    const result = validateEscrowTemplate(validTemplate({ clientAddress: undefined }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'clientAddress')).toBe(true);
  });

  it('fails when freelancerAddress is missing', () => {
    const result = validateEscrowTemplate(validTemplate({ freelancerAddress: undefined }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'freelancerAddress')).toBe(true);
  });

  it('fails when clientAddress is not a valid Stellar address', () => {
    const result = validateEscrowTemplate(validTemplate({ clientAddress: 'not-a-stellar-address' }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'clientAddress')).toBe(true);
  });

  it('fails when freelancerAddress starts with S (secret key)', () => {
    const result = validateEscrowTemplate(
      validTemplate({ freelancerAddress: 'SCZANGBA5SSEL6BKUWFHQKQQ62DXBZHDL3QTTBUCYQEZGT2VJCSMQEF' }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'freelancerAddress')).toBe(true);
  });

  it('fails when client and freelancer addresses are the same', () => {
    const result = validateEscrowTemplate(
      validTemplate({ clientAddress: VALID_CLIENT, freelancerAddress: VALID_CLIENT }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'freelancerAddress')).toBe(true);
  });

  it('fails when arbiterAddress is provided but malformed', () => {
    const result = validateEscrowTemplate(validTemplate({ arbiterAddress: 'BADINPUT' }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'arbiterAddress')).toBe(true);
  });
});

// ── Token address ─────────────────────────────────────────────────────────────

describe('validateEscrowTemplate — tokenAddress', () => {
  it('fails when tokenAddress is absent', () => {
    const result = validateEscrowTemplate(validTemplate({ tokenAddress: undefined }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'tokenAddress')).toBe(true);
  });

  it('fails when tokenAddress is an empty string', () => {
    const result = validateEscrowTemplate(validTemplate({ tokenAddress: '' }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'tokenAddress')).toBe(true);
  });

  it('accepts non-G tokenAddress (e.g. contract identifier)', () => {
    const result = validateEscrowTemplate(validTemplate({ tokenAddress: 'native' }));
    expect(result.valid).toBe(true);
  });
});

// ── Total amount ──────────────────────────────────────────────────────────────

describe('validateEscrowTemplate — totalAmount', () => {
  it('fails when totalAmount is missing', () => {
    const result = validateEscrowTemplate(validTemplate({ totalAmount: undefined }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'totalAmount')).toBe(true);
  });

  it('fails when totalAmount is zero', () => {
    const result = validateEscrowTemplate(validTemplate({ totalAmount: '0' }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'totalAmount')).toBe(true);
  });

  it('fails when totalAmount is negative', () => {
    const result = validateEscrowTemplate(validTemplate({ totalAmount: '-500' }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'totalAmount')).toBe(true);
  });

  it('fails when totalAmount is a non-numeric string', () => {
    const result = validateEscrowTemplate(validTemplate({ totalAmount: 'abc' }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'totalAmount')).toBe(true);
  });
});

// ── Milestones ────────────────────────────────────────────────────────────────

describe('validateEscrowTemplate — milestones', () => {
  it('fails when milestones is absent', () => {
    const result = validateEscrowTemplate(validTemplate({ milestones: undefined }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'milestones')).toBe(true);
  });

  it('fails when milestones is an empty array', () => {
    const result = validateEscrowTemplate(validTemplate({ milestones: [] }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'milestones')).toBe(true);
  });

  it('fails when a milestone is missing a title', () => {
    const result = validateEscrowTemplate(
      validTemplate({
        milestones: [{ amount: '500' }],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field.includes('title'))).toBe(true);
  });

  it('fails when a milestone title is an empty string', () => {
    const result = validateEscrowTemplate(
      validTemplate({
        milestones: [{ title: '   ', amount: '500' }],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field.includes('title'))).toBe(true);
  });

  it('fails when a milestone amount is zero', () => {
    const result = validateEscrowTemplate(
      validTemplate({
        milestones: [{ title: 'Phase 1', amount: '0' }],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field.includes('amount'))).toBe(true);
  });

  it('fails when a milestone amount is missing', () => {
    const result = validateEscrowTemplate(
      validTemplate({
        milestones: [{ title: 'Phase 1' }],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field.includes('amount'))).toBe(true);
  });

  it('fails when milestone total exceeds totalAmount', () => {
    const result = validateEscrowTemplate(
      validTemplate({
        totalAmount: '500',
        milestones: [
          { title: 'A', amount: '400' },
          { title: 'B', amount: '200' }, // 600 > 500
        ],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'milestones')).toBe(true);
    expect(result.errors.some((e) => e.message.includes('exceeds'))).toBe(true);
  });

  it('fails when milestoneIndex is duplicated', () => {
    const result = validateEscrowTemplate(
      validTemplate({
        milestones: [
          { title: 'A', amount: '500', milestoneIndex: 0 },
          { title: 'B', amount: '500', milestoneIndex: 0 }, // duplicate
        ],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.message.includes('duplicated'))).toBe(true);
  });

  it('fails when milestoneIndex is negative', () => {
    const result = validateEscrowTemplate(
      validTemplate({
        milestones: [{ title: 'A', amount: '500', milestoneIndex: -1 }],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field.includes('milestoneIndex'))).toBe(true);
  });

  it('fails when a milestone deadline is in the past', () => {
    const pastDate = new Date(Date.now() - 86_400_000).toISOString();
    const result = validateEscrowTemplate(
      validTemplate({
        milestones: [{ title: 'Phase 1', amount: '1000', deadline: pastDate }],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field.includes('deadline'))).toBe(true);
  });

  it('collects errors for multiple invalid milestones', () => {
    const result = validateEscrowTemplate(
      validTemplate({
        milestones: [
          { amount: '0' },    // missing title, zero amount
          { title: 'B' },     // missing amount
        ],
      }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});

// ── Top-level deadline ────────────────────────────────────────────────────────

describe('validateEscrowTemplate — top-level deadline', () => {
  it('fails when deadline is a past date', () => {
    const pastDate = new Date(Date.now() - 86_400_000).toISOString();
    const result = validateEscrowTemplate(validTemplate({ deadline: pastDate }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'deadline')).toBe(true);
  });

  it('fails when deadline is not a valid ISO date', () => {
    const result = validateEscrowTemplate(validTemplate({ deadline: 'not-a-date' }));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.field === 'deadline')).toBe(true);
  });
});

// ── Edge cases ────────────────────────────────────────────────────────────────

describe('validateEscrowTemplate — edge cases', () => {
  it('fails when the entire body is null', () => {
    const result = validateEscrowTemplate(null);
    expect(result.valid).toBe(false);
  });

  it('fails when the body is a string instead of an object', () => {
    const result = validateEscrowTemplate('bad input');
    expect(result.valid).toBe(false);
  });

  it('returns multiple errors when many fields are invalid simultaneously', () => {
    const result = validateEscrowTemplate({});
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(3);
  });
});
