'use strict';

const { PROVIDER_PUBLIC_ROLES } = require('./publicProviderName');

/**
 * Warunki MongoDB: wykonawca może być pokazany klientowi (mapa, lista, wyszukiwarka).
 * Zamknięte konta: isActive === false, anonymized === true (patrz PrivacyService).
 */
const LISTABLE_PROVIDER_FIELDS = Object.freeze({
  isActive: true,
  anonymized: { $ne: true },
});

/**
 * @param {Record<string, unknown>} match — np. { role: 'provider', ... }
 * @returns {Record<string, unknown>} — pola listingu nadpisują match (nie da się „wyłączyć” filtra z zapytania)
 */
function withListableProviders(match) {
  const normalizedMatch = { ...match };
  if (normalizedMatch.role === 'provider') {
    normalizedMatch.role = { $in: PROVIDER_PUBLIC_ROLES };
  }
  return { ...normalizedMatch, ...LISTABLE_PROVIDER_FIELDS };
}

module.exports = {
  LISTABLE_PROVIDER_FIELDS,
  withListableProviders,
};
