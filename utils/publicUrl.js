/**
 * Publiczny URL frontendu — jeden punkt prawdy dla linków w emailach, SEO, redirectach.
 */
function getFrontendUrl() {
  const raw =
    process.env.FRONTEND_URL ||
    process.env.CLIENT_URL ||
    process.env.PUBLIC_APP_URL ||
    process.env.SEO_PUBLIC_BASE_URL ||
    'https://helpfli.pl';
  return String(raw).trim().replace(/\/$/, '');
}

function getPublicBaseUrl() {
  const env = (process.env.SEO_PUBLIC_BASE_URL || process.env.PUBLIC_APP_URL || '').trim();
  if (env) return env.replace(/\/$/, '');
  return getFrontendUrl();
}

module.exports = { getFrontendUrl, getPublicBaseUrl };
