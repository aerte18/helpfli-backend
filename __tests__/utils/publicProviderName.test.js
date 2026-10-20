const {
  PROVIDER_PUBLIC_ROLES,
  getPublicProviderName,
  isProviderRole,
  withPublicProviderName,
} = require('../../utils/publicProviderName');
const { withListableProviders } = require('../../utils/listableProviderQuery');

describe('public provider identity', () => {
  test('uses the company name for a company provider', () => {
    expect(getPublicProviderName({
      name: 'Jan Kowalski',
      company: { name: '  Fach-Mix Sp. z o.o.  ' },
    })).toBe('Fach-Mix Sp. z o.o.');
  });

  test('falls back to the personal name when there is no populated company', () => {
    expect(getPublicProviderName({ name: '  Jan Kowalski  ', company: 'company-id' }))
      .toBe('Jan Kowalski');
  });

  test('normalizes API output without mutating the source', () => {
    const source = { name: 'Jan Kowalski', company: { name: 'Fach-Mix' } };
    const result = withPublicProviderName(source);

    expect(result).toMatchObject({ name: 'Fach-Mix', displayName: 'Fach-Mix' });
    expect(source.name).toBe('Jan Kowalski');
  });

  test('recognizes all public provider roles', () => {
    expect(PROVIDER_PUBLIC_ROLES).toEqual(['provider', 'company_owner', 'company_manager']);
    expect(isProviderRole('company_owner')).toBe(true);
    expect(isProviderRole('client')).toBe(false);
  });

  test('expands the provider listing query to company provider roles', () => {
    expect(withListableProviders({ role: 'provider', verified: true })).toEqual({
      role: { $in: PROVIDER_PUBLIC_ROLES },
      verified: true,
      isActive: true,
      anonymized: { $ne: true },
    });
  });
});
