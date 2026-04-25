const {
  isValidObjectId,
  normalizeTopN,
  normalizeThresholdHours,
  sanitizeFollowupMessage,
  isOfferQualifiedByPolicy
} = require('../../utils/companyProOps');

describe('companyProOps utils', () => {
  describe('isValidObjectId', () => {
    it('returns true for valid object id', () => {
      expect(isValidObjectId('507f1f77bcf86cd799439011')).toBe(true);
    });

    it('returns false for invalid object id', () => {
      expect(isValidObjectId('not-an-id')).toBe(false);
    });
  });

  describe('normalizeTopN', () => {
    it('clamps between 1 and 10', () => {
      expect(normalizeTopN(0)).toBe(1);
      expect(normalizeTopN(99)).toBe(10);
      expect(normalizeTopN(4.6)).toBe(5);
    });
  });

  describe('normalizeThresholdHours', () => {
    it('clamps between 1 and 168', () => {
      expect(normalizeThresholdHours(0)).toBe(1);
      expect(normalizeThresholdHours(999)).toBe(168);
      expect(normalizeThresholdHours(24)).toBe(24);
    });
  });

  describe('sanitizeFollowupMessage', () => {
    it('returns default for empty message', () => {
      const msg = sanitizeFollowupMessage('');
      expect(msg).toMatch(/prosimy o krótką aktualizację/i);
    });

    it('trims and truncates long message', () => {
      const msg = sanitizeFollowupMessage(`   ${'a'.repeat(500)}   `);
      expect(msg.length).toBe(400);
      expect(msg).toBe('a'.repeat(400));
    });
  });

  describe('isOfferQualifiedByPolicy', () => {
    const offerBase = {
      amount: 1000,
      hasGuarantee: true,
      message: 'Oferta z gwarancją',
      providerId: {
        ratingAvg: 4.8,
        vatInvoice: true
      }
    };

    it('returns true when offer satisfies all policy constraints', () => {
      const policy = {
        minRating: 4.5,
        maxBudget: 1200,
        requiresInvoice: true,
        requiresWarranty: true
      };
      expect(isOfferQualifiedByPolicy(offerBase, policy)).toBe(true);
    });

    it('returns false when rating is below minRating', () => {
      const policy = { minRating: 4.9 };
      expect(isOfferQualifiedByPolicy(offerBase, policy)).toBe(false);
    });

    it('returns false when VAT invoice is required but missing', () => {
      const policy = { requiresInvoice: true };
      const offer = { ...offerBase, providerId: { ...offerBase.providerId, vatInvoice: false } };
      expect(isOfferQualifiedByPolicy(offer, policy)).toBe(false);
    });
  });
});
