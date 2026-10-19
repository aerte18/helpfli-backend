const EmailVerificationService = require('../../services/emailVerificationService');

describe('EmailVerificationService safe continue path', () => {
  test('accepts a local order resume path', () => {
    expect(
      EmailVerificationService.safeContinuePath('/create-order?resume=1&source=landing_hero')
    ).toBe('/create-order?resume=1&source=landing_hero');
  });

  test.each([
    'https://evil.example/create-order',
    '//evil.example/create-order',
    '/verify-email?token=other',
    '/login?next=/create-order',
    '',
    null,
  ])('rejects unsafe or recursive target %p', (target) => {
    expect(EmailVerificationService.safeContinuePath(target)).toBe('');
  });
});
