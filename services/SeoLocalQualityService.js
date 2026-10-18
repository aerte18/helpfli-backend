const { TOP_PL_CITIES_BY_SLUG } = require('../utils/polishCities');

function plainText(value) {
  return String(value || '')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function evaluateSeoLocalPage(page) {
  const issues = [];
  const metaDescription = String(page?.metaDescription || '').trim();
  const intro = plainText(page?.intro);
  const content = plainText(page?.contentHtml);
  const faq = Array.isArray(page?.faq) ? page.faq.filter((item) => item?.question && item?.answer) : [];
  const providerCount = Number(page?.statsSnapshot?.providerCount || 0);
  const recentOrders = Number(page?.statsSnapshot?.recentOrders30d || 0);

  if (!page?.serviceSlug || !page?.serviceName) issues.push('Brak poprawnej usługi.');
  if (!page?.citySlug || !TOP_PL_CITIES_BY_SLUG[page.citySlug]) issues.push('Miasto nie jest wspierane.');
  if (String(page?.title || '').trim().length < 20) issues.push('Tytuł jest zbyt krótki.');
  if (metaDescription.length < 70 || metaDescription.length > 180) {
    issues.push('Meta description musi mieć 70–180 znaków.');
  }
  if (intro.length < 120) issues.push('Wprowadzenie musi mieć co najmniej 120 znaków.');
  if (content.length < 300) issues.push('Treść główna musi mieć co najmniej 300 znaków.');
  if (faq.length < 2) issues.push('Wymagane są co najmniej 2 kompletne pytania FAQ.');
  if (providerCount < 1 && recentOrders < 1) {
    issues.push('Brak potwierdzonej lokalnej podaży lub popytu.');
  }

  return {
    indexable: issues.length === 0,
    issues,
    metrics: {
      introLength: intro.length,
      contentLength: content.length,
      faqCount: faq.length,
      providerCount,
      recentOrders30d: recentOrders
    }
  };
}

function isSeoLocalPageIndexable(page) {
  return Boolean(page?.published) && evaluateSeoLocalPage(page).indexable;
}

module.exports = {
  evaluateSeoLocalPage,
  isSeoLocalPageIndexable,
  plainText
};
