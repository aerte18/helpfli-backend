'use strict';

const PROVIDER_PUBLIC_ROLES = Object.freeze([
  'provider',
  'company_owner',
  'company_manager',
]);

function isProviderRole(role) {
  return PROVIDER_PUBLIC_ROLES.includes(String(role || ''));
}

function cleanName(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Publiczna nazwa wykonawcy. Firma ma pierwszeństwo przed imieniem i nazwiskiem
 * użytkownika. Korzystamy wyłącznie z publicznego rekordu Company — nigdy z
 * danych rozliczeniowych ani KYC.
 */
function getPublicProviderName(provider, fallback = 'Wykonawca') {
  const company = provider?.company;
  const companyName = company && typeof company === 'object'
    ? cleanName(company.name)
    : '';

  return companyName || cleanName(provider?.name) || cleanName(provider?.displayName) || fallback;
}

function withPublicProviderName(provider, fallback = 'Wykonawca') {
  if (!provider) return provider;
  const source = typeof provider.toObject === 'function' ? provider.toObject() : provider;
  const name = getPublicProviderName(source, fallback);
  return { ...source, name, displayName: name };
}

module.exports = {
  PROVIDER_PUBLIC_ROLES,
  isProviderRole,
  getPublicProviderName,
  withPublicProviderName,
};
