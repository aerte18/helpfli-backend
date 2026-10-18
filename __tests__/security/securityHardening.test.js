const User = require('../../models/User');
const SponsorAd = require('../../models/SponsorAd');
const Report = require('../../models/Report');
const { PUBLIC_USER_PROFILE_SELECT } = require('../../utils/publicUserFields');
const {
  safeUploadName,
  hasExpectedMagicBytes,
} = require('../../utils/uploadSafety');
const {
  PUBLIC_PREFIXES,
  isSafeRelativePath,
} = require('../../middleware/secureUploads');

describe('security hardening invariants', () => {
  test.each([
    'password',
    'emailVerificationToken',
    'emailVerificationExpires',
    'passwordResetToken',
    'passwordResetExpires',
    'twoFactorSecret',
    'twoFactorBackupCodes',
    'pushSubs',
    'kyc.idNumber',
    'kyc.docs.idFrontUrl',
  ])('%s is excluded from User queries by default', (field) => {
    expect(User.schema.path(field).options.select).toBe(false);
  });

  test('public user projection is an allow-list without credentials or PII', () => {
    expect(PUBLIC_USER_PROFILE_SELECT).toContain('kyc.status');
    expect(PUBLIC_USER_PROFILE_SELECT).not.toMatch(/password|Token|Secret|Backup|pushSubs|idNumber|docs|email|phone|address/);
  });

  test('server-generated upload name ignores an attacker-controlled extension', () => {
    const name = safeUploadName(
      'draft',
      { mimetype: 'image/png', originalname: 'payload.html' },
      '507f1f77bcf86cd799439011'
    );
    expect(name).toMatch(/^draft-507f1f77bcf86cd799439011-[a-f0-9]{32}\.png$/);
    expect(name).not.toContain('.html');
  });

  test('magic-byte validation rejects HTML declared as an image', () => {
    expect(hasExpectedMagicBytes(Buffer.from('<html><script>'), 'image/png')).toBe(false);
    expect(
      hasExpectedMagicBytes(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
        'image/png'
      )
    ).toBe(true);
  });

  test('only intentionally public upload categories bypass resource authorization', () => {
    expect([...PUBLIC_PREFIXES].sort()).toEqual(['avatars', 'portfolio', 'sponsor-ads']);
    expect(PUBLIC_PREFIXES.has('kyc')).toBe(false);
    expect(PUBLIC_PREFIXES.has('drafts')).toBe(false);
    expect(PUBLIC_PREFIXES.has('reports')).toBe(false);
  });

  test('upload paths reject traversal and malformed segments', () => {
    expect(isSafeRelativePath('drafts/photo.png')).toBe(true);
    expect(isSafeRelativePath('../kyc/id.png')).toBe(false);
    expect(isSafeRelativePath('kyc/../avatars/id.png')).toBe(false);
    expect(isSafeRelativePath('kyc/%2e%2e/avatars/id.png')).toBe(false);
    expect(isSafeRelativePath('orders//invoice.pdf')).toBe(false);
  });

  test('sponsor ads have an owner and no active HTML media type', () => {
    expect(SponsorAd.schema.path('owner')).toBeDefined();
    expect(SponsorAd.schema.path('mediaType').enumValues).not.toContain('html5');
    expect(SponsorAd.schema.path('htmlContent')).toBeUndefined();
  });

  test('duplicate reports from one reporter are rejected by a unique index', () => {
    const uniqueIndex = Report.schema.indexes().find(([keys, options]) =>
      keys.user === 1 && keys.reportedUser === 1 && options.unique === true
    );
    expect(uniqueIndex).toBeDefined();
  });
});
