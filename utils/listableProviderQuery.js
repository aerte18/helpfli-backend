'use strict';

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
  return { ...match, ...LISTABLE_PROVIDER_FIELDS };
}

module.exports = {
  LISTABLE_PROVIDER_FIELDS,
  withListableProviders,
};
