/**
 * Monetyzacja trybu „Pozyskaj tylko oferty” (lead gen).
 * Wystawienie: 0 zł. Pieniądz: sloty ofert (provider), odblokowanie kontaktu (klient), boosty.
 */
module.exports = {
  /** Opłata za odblokowanie kontaktu po wyborze wykonawcy (PLN) */
  contactUnlockFeePln: Number(process.env.OFFERS_ONLY_CONTACT_UNLOCK_PLN) || 24,

  /** Opcjonalne boosty przy wystawieniu (tylko offers_only) — PLN */
  fastTrackFeePln: Number(process.env.OFFERS_ONLY_FAST_TRACK_PLN) || 19,
  listHighlightFeePln: Number(process.env.OFFERS_ONLY_LIST_HIGHLIGHT_PLN) || 9,
  verifiedProvidersOnlyFeePln: Number(process.env.OFFERS_ONLY_VERIFIED_ONLY_PLN) || 29,

  listHighlightHours: 168, // 7 dni na górze listy
  fastTrackPriorityDays: 14,

  /** Klient PRO: Fast Track w cenie (jak pilne zlecenia w pakiecie) */
  clientFreeFastTrackPlans: ['CLIENT_PRO'],

  /** Plany klienta z darmowym odblokowaniem kontaktu w pakiecie */
  clientFreeContactUnlockPlans: ['CLIENT_PRO'],

  /** Provider PRO: duży projekt liczy max 1 slot zamiast 2–3 */
  providerReducedSlotPlans: ['PROV_PRO'],

  /** Slugi / wzorce → 3 sloty (największe inwestycje) */
  extraLargeSlugPatterns: [
    'budowa-domu',
    'dom-pod-klucz',
    'budowa-hali',
    'generalny-wykonawca',
    'generalny-remont-domu',
    'fit-out-biur',
  ],
};
