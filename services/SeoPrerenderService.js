/**
 * SSR-lite: gotowy HTML z meta + treścią dla crawlerów (Google, Facebook, Bing).
 * Używany przez GET /api/seo/prerender oraz Vercel Edge Middleware na frontendzie.
 */
const mongoose = require('mongoose');
const { getPublicBaseUrl } = require('../utils/publicUrl');

let logger;
try { logger = require('../utils/logger'); } catch { logger = console; }

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function stripHtml(html) {
  if (!html) return '';
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buildHtmlDocument({ title, description, canonical, ogImage, jsonLd = [], bodyHtml }) {
  const base = getPublicBaseUrl();
  const img = ogImage || `${base}/icons/icon-192x192.png`;
  const ldScripts = (Array.isArray(jsonLd) ? jsonLd : [jsonLd])
    .filter(Boolean)
    .map((ld) => `<script type="application/ld+json">${JSON.stringify(ld)}</script>`)
    .join('\n    ');

  return `<!DOCTYPE html>
<html lang="pl">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}" />
  <link rel="canonical" href="${escapeHtml(canonical)}" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta property="og:url" content="${escapeHtml(canonical)}" />
  <meta property="og:type" content="website" />
  <meta property="og:site_name" content="Helpfli" />
  <meta property="og:locale" content="pl_PL" />
  <meta property="og:image" content="${escapeHtml(img)}" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:title" content="${escapeHtml(title)}" />
  <meta name="twitter:description" content="${escapeHtml(description)}" />
  <meta name="twitter:image" content="${escapeHtml(img)}" />
  ${ldScripts}
  <style>
    body{font-family:system-ui,sans-serif;max-width:720px;margin:2rem auto;padding:0 1rem;line-height:1.6;color:#1e293b}
    a{color:#4f46e5} h1{font-size:1.75rem} .cta{margin-top:2rem;padding:1rem;background:#eef2ff;border-radius:12px}
  </style>
</head>
<body>
  <header><a href="${escapeHtml(base)}">Helpfli</a></header>
  <main>${bodyHtml}</main>
  <footer style="margin-top:3rem;font-size:.875rem;color:#64748b">
    <p>© Helpfli — marketplace usług lokalnych w Polsce.</p>
  </footer>
</body>
</html>`;
}

async function renderArticlePage(slug) {
  const SeoArticle = require('../models/SeoArticle');
  const article = await SeoArticle.findOne({ slug, published: true }).lean();
  if (!article) return null;

  const base = getPublicBaseUrl();
  const canonical = `${base}/poradnik/${article.slug}`;
  const title = article.metaTitle || article.title;
  const description = article.metaDescription || article.tldr || article.problem || '';
  const ogImage = article.heroImage?.startsWith('http')
    ? article.heroImage
    : article.heroImage
      ? `${base}${article.heroImage.startsWith('/') ? '' : '/'}${article.heroImage}`
      : `${base}/icons/icon-192x192.png`;

  const faqLd =
    article.faq?.length > 0
      ? {
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: article.faq.map((f) => ({
            '@type': 'Question',
            name: f.question,
            acceptedAnswer: { '@type': 'Answer', text: f.answer }
          }))
        }
      : null;

  const howToLd =
    article.howtoSteps?.length >= 3
      ? {
          '@context': 'https://schema.org',
          '@type': 'HowTo',
          name: article.title,
          description: article.tldr || description,
          inLanguage: 'pl-PL',
          totalTime: article.howtoTotalTimeMinutes
            ? `PT${article.howtoTotalTimeMinutes}M`
            : undefined,
          step: article.howtoSteps.map((s, i) => ({
            '@type': 'HowToStep',
            position: i + 1,
            name: s.name,
            text: s.text || s.name,
            url: `${canonical}#krok-${i + 1}`
          }))
        }
      : null;

  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Strona główna', item: base },
      { '@type': 'ListItem', position: 2, name: 'Poradniki', item: `${base}/poradniki` },
      { '@type': 'ListItem', position: 3, name: article.title, item: canonical }
    ]
  };

  const articleLd = {
    '@context': 'https://schema.org',
    '@type': 'Article',
    headline: article.title,
    description,
    datePublished: article.publishedAt || article.createdAt,
    dateModified: article.updatedAt || article.publishedAt,
    author: { '@type': 'Organization', name: 'Helpfli' },
    publisher: {
      '@type': 'Organization',
      name: 'Helpfli',
      logo: { '@type': 'ImageObject', url: `${base}/icons/icon-192x192.png` }
    },
    mainEntityOfPage: canonical,
    inLanguage: 'pl-PL'
  };

  const contentPreview = article.contentHtml
    ? `<article>${article.contentHtml}</article>`
    : `<p>${escapeHtml(article.tldr || article.problem || description)}</p>`;

  const faqHtml =
    article.faq?.length > 0
      ? `<section><h2>Najczęstsze pytania</h2>${article.faq
          .map((f) => `<h3>${escapeHtml(f.question)}</h3><p>${escapeHtml(f.answer)}</p>`)
          .join('')}</section>`
      : '';

  const bodyHtml = `
    <h1>${escapeHtml(article.title)}</h1>
    ${article.tldr ? `<p><strong>${escapeHtml(article.tldr)}</strong></p>` : ''}
    ${contentPreview}
    ${faqHtml}
    <div class="cta"><p><a href="${escapeHtml(base)}/create-order">Znajdź wykonawcę na Helpfli →</a></p></div>
  `;

  return buildHtmlDocument({
    title,
    description,
    canonical,
    ogImage,
    jsonLd: [articleLd, faqLd, howToLd, breadcrumbLd].filter(Boolean),
    bodyHtml
  });
}

async function renderPseoPage(serviceSlug, citySlug) {
  const SeoLocalPage = require('../models/SeoLocalPage');
  const { TOP_PL_CITIES_BY_SLUG } = require('../utils/polishCities');
  if (!TOP_PL_CITIES_BY_SLUG[citySlug]) return null;

  let page = await SeoLocalPage.findOne({ serviceSlug, citySlug, published: true }).lean();
  if (!page) {
    try {
      const { buildOrUpdateLocalPage } = require('../services/SeoLocalPageGenerator');
      page = await buildOrUpdateLocalPage({ serviceSlug, citySlug });
      if (page?.toObject) page = page.toObject();
    } catch (err) {
      logger.warn?.('[SeoPrerender] PSEO build failed:', err.message);
      return null;
    }
  }
  if (!page) return null;

  const base = getPublicBaseUrl();
  const canonical = `${base}/wykonawcy/${page.serviceSlug}/${page.citySlug}`;
  const title = page.metaTitle || `${page.serviceName} ${page.cityName} | Helpfli`;
  const description =
    page.metaDescription ||
    `Znajdź sprawdzonych wykonawców: ${page.serviceName} w mieście ${page.cityName}. Porównaj oferty na Helpfli.`;

  const faqLd =
    page.faq?.length > 0
      ? {
          '@context': 'https://schema.org',
          '@type': 'FAQPage',
          mainEntity: page.faq.map((f) => ({
            '@type': 'Question',
            name: f.question,
            acceptedAnswer: { '@type': 'Answer', text: f.answer }
          }))
        }
      : null;

  const localBusinessLd = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: `Helpfli – ${page.serviceName} ${page.cityName}`,
    description,
    url: canonical,
    areaServed: { '@type': 'City', name: page.cityName },
    image: `${base}/icons/icon-192x192.png`
  };

  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Strona główna', item: base },
      { '@type': 'ListItem', position: 2, name: 'Wykonawcy', item: `${base}/wykonawcy` },
      {
        '@type': 'ListItem',
        position: 3,
        name: `${page.serviceName} ${page.cityName}`,
        item: canonical
      }
    ]
  };

  const faqHtml =
    page.faq?.length > 0
      ? `<section><h2>FAQ</h2>${page.faq
          .map((f) => `<h3>${escapeHtml(f.question)}</h3><p>${escapeHtml(f.answer)}</p>`)
          .join('')}</section>`
      : '';

  const contentBlock = page.contentHtml
    ? `<div>${page.contentHtml}</div>`
    : '';

  const bodyHtml = `
    <h1>${escapeHtml(page.title || `${page.serviceName} w mieście ${page.cityName}`)}</h1>
    <p>${escapeHtml(page.intro || stripHtml(page.contentHtml).slice(0, 400))}</p>
    ${contentBlock}
    ${faqHtml}
    <div class="cta"><p><a href="${escapeHtml(base)}/create-order?service=${escapeHtml(page.serviceSlug)}&city=${escapeHtml(page.cityName)}">Zleć ${escapeHtml(page.serviceName)} w ${escapeHtml(page.cityName)} →</a></p></div>
  `;

  return buildHtmlDocument({
    title,
    description,
    canonical,
    jsonLd: [localBusinessLd, faqLd, breadcrumbLd].filter(Boolean),
    bodyHtml
  });
}

async function renderHomePage() {
  const base = getPublicBaseUrl();
  const websiteLd = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'Helpfli',
    url: base,
    potentialAction: {
      '@type': 'SearchAction',
      target: `${base}/home?search={search_term_string}`,
      'query-input': 'required name=search_term_string'
    }
  };
  const orgLd = {
    '@context': 'https://schema.org',
    '@type': 'Organization',
    name: 'Helpfli',
    url: base,
    logo: `${base}/icons/icon-192x192.png`
  };
  return buildHtmlDocument({
    title: 'Helpfli — marketplace usług lokalnych w Polsce',
    description:
      'Helpfli łączy klientów ze sprawdzonymi wykonawcami: hydraulik, elektryk, remont, sprzątanie. Porównaj oferty i zleć usługę online.',
    canonical: `${base}/`,
    jsonLd: [websiteLd, orgLd],
    bodyHtml: `
      <h1>Helpfli — usługi lokalne w Polsce</h1>
      <p>Znajdź sprawdzonego wykonawcę w swojej okolicy. Opisz problem, porównaj oferty, zapłać bezpiecznie.</p>
      <div class="cta"><p><a href="${escapeHtml(base)}/home">Szukaj wykonawców →</a></p></div>
    `
  });
}

async function renderProviderProfile(providerId) {
  const User = require('../models/User');
  const user = await User.findById(providerId)
    .select('name bio city avatar role isActive anonymized deletedAt')
    .lean();
  if (!user || !user.isActive || user.anonymized || user.deletedAt) return null;
  if (!['provider', 'company_owner', 'company_manager'].includes(user.role)) return null;

  const base = getPublicBaseUrl();
  const canonical = `${base}/provider/${providerId}`;
  const title = `${user.name} — wykonawca | Helpfli`;
  const description =
    (user.bio && String(user.bio).slice(0, 160)) ||
    `Profil wykonawcy ${user.name} na Helpfli. Sprawdź usługi i wyślij zapytanie o wycenę.`;

  const localBusinessLd = {
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: user.name,
    url: canonical,
    description
  };

  const bodyHtml = `
    <h1>${escapeHtml(user.name)}</h1>
    <p>${escapeHtml(description)}</p>
    ${user.city ? `<p>Miasto: ${escapeHtml(user.city)}</p>` : ''}
    <div class="cta"><p><a href="${escapeHtml(canonical)}">Zobacz profil i zapytaj o wycenę →</a></p></div>
  `;

  return buildHtmlDocument({
    title,
    description,
    canonical,
    ogImage: user.avatar?.startsWith('http') ? user.avatar : undefined,
    jsonLd: localBusinessLd,
    bodyHtml
  });
}

async function renderServicePage(slug) {
  const Service = require('../models/Service');
  const service = await Service.findOne({ slug: String(slug).toLowerCase() }).lean();
  if (!service) return null;

  const base = getPublicBaseUrl();
  const name = service.name_pl || service.name_en || service.name || slug;
  const canonical = `${base}/service/${service.slug || slug}`;
  const title = `${name} — wykonawcy i ceny | Helpfli`;
  const description = `Znajdź wykonawców: ${name}. Porównaj oferty i zleć usługę na Helpfli.`;

  const serviceLd = {
    '@context': 'https://schema.org',
    '@type': 'Service',
    name,
    url: canonical,
    provider: { '@type': 'Organization', name: 'Helpfli' },
    areaServed: { '@type': 'Country', name: 'Polska' }
  };

  return buildHtmlDocument({
    title,
    description,
    canonical,
    jsonLd: serviceLd,
    bodyHtml: `
      <h1>${escapeHtml(name)}</h1>
      <p>${escapeHtml(description)}</p>
      <div class="cta"><p><a href="${escapeHtml(base)}/home?search=${encodeURIComponent(name)}">Znajdź wykonawców →</a></p></div>
    `
  });
}

async function renderForPath(pathname) {
  const path = String(pathname || '').split('?')[0].replace(/\/$/, '') || '/';

  if (path === '/' || path === '/home') {
    return renderHomePage();
  }

  const providerMatch = path.match(/^\/provider\/([^/]+)$/i);
  if (providerMatch) {
    return renderProviderProfile(providerMatch[1]);
  }

  const serviceMatch = path.match(/^\/service\/([^/]+)$/i);
  if (serviceMatch) {
    return renderServicePage(serviceMatch[1].toLowerCase());
  }

  const articleMatch = path.match(/^\/poradnik\/([^/]+)$/i);
  if (articleMatch) {
    return renderArticlePage(articleMatch[1].toLowerCase());
  }

  const pseoMatch = path.match(/^\/wykonawcy\/([^/]+)\/([^/]+)$/i);
  if (pseoMatch) {
    return renderPseoPage(pseoMatch[1].toLowerCase(), pseoMatch[2].toLowerCase());
  }

  if (path === '/poradniki') {
    const base = getPublicBaseUrl();
    return buildHtmlDocument({
      title: 'Poradniki Helpfli — porady domowe i usługi',
      description: 'Poradniki Helpfli: AGD, hydraulika, elektryka, remont. Praktyczne wskazówki i znajdowanie wykonawców.',
      canonical: `${base}/poradniki`,
      bodyHtml: `<h1>Poradniki Helpfli</h1><p>Praktyczne artykuły o domu, AGD i usługach lokalnych.</p><p><a href="${base}/poradniki">Przeglądaj poradniki →</a></p>`
    });
  }

  if (path === '/wykonawcy') {
    const base = getPublicBaseUrl();
    return buildHtmlDocument({
      title: 'Wykonawcy Helpfli — usługi w Twoim mieście',
      description: 'Katalog wykonawców Helpfli: hydraulik, elektryk, remont, sprzątanie w całej Polsce.',
      canonical: `${base}/wykonawcy`,
      bodyHtml: `<h1>Wykonawcy Helpfli</h1><p>Znajdź sprawdzonego fachowca w swoim mieście.</p><p><a href="${base}/wykonawcy">Przeglądaj katalog →</a></p>`
    });
  }

  return null;
}

async function prerenderHandler(req, res) {
  try {
    const path = req.query.path || req.query.url || '/';
    if (mongoose.connection?.readyState !== 1) {
      const { connectMongoOnce } = require('../utils/mongoConnect');
      await connectMongoOnce();
    }
    const html = await renderForPath(path);
    if (!html) {
      return res.status(404).set('Content-Type', 'text/plain; charset=utf-8').send('Not found');
    }
    res.set('Content-Type', 'text/html; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=600, s-maxage=3600');
    res.send(html);
  } catch (err) {
    logger.error?.('[SeoPrerender] error:', err);
    res.status(500).set('Content-Type', 'text/plain').send('Prerender error');
  }
}

module.exports = {
  renderForPath,
  prerenderHandler,
  escapeHtml
};
