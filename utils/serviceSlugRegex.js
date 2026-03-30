/**
 * Dopasowanie slugów zleceń do slugów z katalogu — w DB bywa `agd-rtv-...` lub `agd_rtv_...`.
 * Używane w GET /api/orders/open, searchOrdersForProviderTool, itd.
 */
function escapeRegex(x) {
  return String(x).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Regex prefiksowy: slug zlecenia zaczyna się jak slug usługi (kategoria lub liść).
 * @returns {RegExp|null}
 */
function buildServiceSlugPrefixRegex(raw) {
  const norm = String(raw || '').trim().replace(/_/g, '-');
  if (!norm) return null;
  const part = escapeRegex(norm).replace(/-/g, '[-_]');
  return new RegExp(`^${part}(-|$)`, 'i');
}

module.exports = { escapeRegex, buildServiceSlugPrefixRegex };
