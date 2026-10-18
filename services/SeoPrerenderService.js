/**
 * SSR-lite: gotowy HTML z meta + treścią dla crawlerów (Google, Facebook, Bing).
 * Używany przez GET /api/seo/prerender oraz Vercel Edge Middleware na frontendzie.
 */
const mongoose = require('mongoose');
const { getPublicBaseUrl } = require('../utils/publicUrl');
const { buildCanonicalServiceSlug } = require('../utils/seoSlug');
const { isSeoLocalPageIndexable } = require('./SeoLocalQualityService');

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

function buildHtmlDocument({
  title,
  description,
  canonical,
  ogImage,
  ogType = 'website',
  robots = 'index,follow',
  jsonLd = [],
  bodyHtml
}) {
  const base = getPublicBaseUrl();
  const img = ogImage || `${base}/img/landing%20front.webp`;
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
  <meta name="robots" content="${escapeHtml(robots)}" />
  <link rel="canonical" href="${escapeHtml(canonical)}" />
  <meta property="og:title" content="${escapeHtml(title)}" />
  <meta property="og:description" content="${escapeHtml(description)}" />
  <meta property="og:url" content="${escapeHtml(canonical)}" />
  <meta property="og:type" content="${escapeHtml(ogType)}" />
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
    ogType: 'article',
    jsonLd: [articleLd, faqLd, howToLd, breadcrumbLd].filter(Boolean),
    bodyHtml
  });
}

async function renderPseoPage(serviceSlug, citySlug) {
  const SeoLocalPage = require('../models/SeoLocalPage');
  const { TOP_PL_CITIES_BY_SLUG } = require('../utils/polishCities');
  const { SEO_LOCAL_SERVICES } = require('../utils/seoCities');
  if (!TOP_PL_CITIES_BY_SLUG[citySlug]) return null;

  const requestedService = SEO_LOCAL_SERVICES.find((item) => item.slug === serviceSlug);
  const serviceQuery = requestedService
    ? {
        $or: [
          { serviceSlug },
          { serviceName: { $regex: `^${requestedService.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } }
        ]
      }
    : { serviceSlug };
  const page = await SeoLocalPage.findOne({ ...serviceQuery, citySlug, published: true }).lean();
  if (!page || !isSeoLocalPageIndexable(page)) return null;

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

  const webPageLd = {
    '@context': 'https://schema.org',
    '@type': 'WebPage',
    name: page.title || `${page.serviceName} ${page.cityName} — Helpfli`,
    description,
    url: canonical,
    inLanguage: 'pl-PL',
    isPartOf: { '@type': 'WebSite', name: 'Helpfli', url: base },
    about: {
      '@type': 'Service',
      name: page.serviceName,
      areaServed: { '@type': 'City', name: page.cityName }
    }
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
    <p><a href="${escapeHtml(base)}/wykonawcy">Zobacz wszystkie dostępne usługi i miasta</a></p>
    <div class="cta"><p><a href="${escapeHtml(base)}/create-order?service=${escapeHtml(page.serviceSlug)}&city=${escapeHtml(page.cityName)}">Zleć ${escapeHtml(page.serviceName)} w ${escapeHtml(page.cityName)} →</a></p></div>
  `;

  return buildHtmlDocument({
    title,
    description,
    canonical,
    jsonLd: [webPageLd, faqLd, breadcrumbLd].filter(Boolean),
    bodyHtml
  });
}

async function renderHomePage() {
  const base = getPublicBaseUrl();
  const websiteLd = {
    '@context': 'https://schema.org',
    '@type': 'WebSite',
    name: 'Helpfli',
    url: base
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
      <ul>
        <li><a href="${escapeHtml(base)}/wykonawcy">Usługi w miastach</a></li>
        <li><a href="${escapeHtml(base)}/services">Lista usług</a></li>
        <li><a href="${escapeHtml(base)}/providers">Katalog wykonawców</a></li>
        <li><a href="${escapeHtml(base)}/poradniki">Poradniki</a></li>
      </ul>
      <div class="cta"><p><a href="${escapeHtml(base)}/register">Załóż konto i opisz zlecenie →</a></p></div>
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
  if (!user.name || (!user.bio && !user.city)) return null;

  const base = getPublicBaseUrl();
  const canonical = `${base}/provider/${providerId}`;
  const title = `${user.name} — wykonawca | Helpfli`;
  const description =
    (user.bio && String(user.bio).slice(0, 160)) ||
    `Profil wykonawcy ${user.name} na Helpfli. Sprawdź usługi i wyślij zapytanie o wycenę.`;

  const providerLd = {
    '@context': 'https://schema.org',
    '@type': 'Person',
    name: user.name,
    url: canonical,
    description,
    jobTitle: 'Wykonawca usług lokalnych',
    ...(user.city ? { areaServed: { '@type': 'City', name: user.city } } : {})
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
    jsonLd: providerLd,
    bodyHtml
  });
}

async function renderServicePage(slug) {
  const Service = require('../models/Service');
  const requestedSlug = String(slug).toLowerCase();
  let service = await Service.findOne({
    $or: [{ slug: requestedSlug }, { legacy_slugs: requestedSlug }]
  }).lean();
  if (!service) {
    const candidates = await Service.find({})
      .select('slug legacy_slugs parent_slug name_pl name_en name description')
      .lean();
    service = candidates.find((item) => buildCanonicalServiceSlug(item) === requestedSlug) || null;
  }
  if (!service) return null;

  const base = getPublicBaseUrl();
  const name = service.name_pl || service.name_en || service.name || slug;
  const publicSlug = buildCanonicalServiceSlug(service) || service.slug || requestedSlug;
  const canonical = `${base}/service/${publicSlug}`;
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

async function renderArticleIndex() {
  const SeoArticle = require('../models/SeoArticle');
  const base = getPublicBaseUrl();
  const articles = await SeoArticle.find({ published: true })
    .select('slug title metaDescription tldr')
    .sort({ publishedAt: -1 })
    .limit(100)
    .lean();
  const links = articles
    .map(
      (article) =>
        `<li><a href="${escapeHtml(base)}/poradnik/${escapeHtml(article.slug)}">${escapeHtml(article.title)}</a>${
          article.metaDescription || article.tldr
            ? ` — ${escapeHtml(article.metaDescription || article.tldr)}`
            : ''
        }</li>`
    )
    .join('');
  return buildHtmlDocument({
    title: 'Poradniki Helpfli — porady domowe i usługi',
    description:
      'Poradniki Helpfli: AGD, hydraulika, elektryka, remont. Praktyczne wskazówki i znajdowanie wykonawców.',
    canonical: `${base}/poradniki`,
    bodyHtml: `<h1>Poradniki Helpfli</h1><p>Praktyczne artykuły o domu, AGD i usługach lokalnych.</p><ul>${links}</ul>`
  });
}

async function renderPseoIndex() {
  const SeoLocalPage = require('../models/SeoLocalPage');
  const base = getPublicBaseUrl();
  const pages = await SeoLocalPage.find({ published: true })
    .select(
      'serviceSlug serviceName citySlug cityName title metaDescription intro contentHtml faq statsSnapshot published'
    )
    .sort({ serviceName: 1, cityName: 1 })
    .limit(2000)
    .lean();
  const links = pages
    .filter(isSeoLocalPageIndexable)
    .map(
      (page) =>
        `<li><a href="${escapeHtml(base)}/wykonawcy/${escapeHtml(page.serviceSlug)}/${escapeHtml(page.citySlug)}">${escapeHtml(page.serviceName)} — ${escapeHtml(page.cityName)}</a></li>`
    )
    .join('');
  return buildHtmlDocument({
    title: 'Wykonawcy Helpfli — usługi w Twoim mieście',
    description:
      'Katalog wykonawców Helpfli: hydraulik, elektryk, remont i inne usługi w miastach w całej Polsce.',
    canonical: `${base}/wykonawcy`,
    bodyHtml: `<h1>Wykonawcy Helpfli</h1><p>Przeglądaj dostępne usługi lokalne w miastach obsługiwanych przez Helpfli.</p><ul>${links}</ul>`
  });
}

async function renderProvidersIndex() {
  const User = require('../models/User');
  const base = getPublicBaseUrl();
  const providers = await User.find({
    role: { $in: ['provider', 'company_owner', 'company_manager'] },
    isActive: true,
    anonymized: { $ne: true },
    deletedAt: null
  })
    .select('_id name bio city')
    .sort({ updatedAt: -1 })
    .limit(100)
    .lean();
  const links = providers
    .filter((provider) => provider.name && (provider.bio || provider.city))
    .map(
      (provider) =>
        `<li><a href="${escapeHtml(base)}/provider/${escapeHtml(provider._id)}">${escapeHtml(provider.name)}</a>${provider.city ? ` — ${escapeHtml(provider.city)}` : ''}</li>`
    )
    .join('');
  return buildHtmlDocument({
    title: 'Sprawdzeni wykonawcy usług | Helpfli',
    description: 'Przeglądaj profile wykonawców, porównuj dostępne informacje i znajdź pomoc w swojej okolicy.',
    canonical: `${base}/providers`,
    bodyHtml: `<h1>Katalog wykonawców</h1><p>Znajdź wykonawcę dopasowanego do swojej usługi i lokalizacji.</p><ul>${links}</ul>`
  });
}

async function renderServicesIndex() {
  const Service = require('../models/Service');
  const base = getPublicBaseUrl();
  const services = await Service.find({ slug: { $exists: true, $nin: [null, ''] } })
    .select('slug parent_slug name_pl name_en name')
    .sort({ is_top: -1, name_pl: 1 })
    .limit(500)
    .lean();
  const links = services
    .map((service) => {
      const name = service.name_pl || service.name_en || service.name || service.slug;
      const publicSlug = buildCanonicalServiceSlug(service) || service.slug;
      return `<li><a href="${escapeHtml(base)}/service/${escapeHtml(publicSlug)}">${escapeHtml(name)}</a></li>`;
    })
    .join('');
  return buildHtmlDocument({
    title: 'Lista usług lokalnych | Helpfli',
    description: 'Sprawdź katalog usług Helpfli i znajdź wykonawcę dopasowanego do swojego zadania.',
    canonical: `${base}/services`,
    bodyHtml: `<h1>Lista usług Helpfli</h1><p>Wybierz usługę, aby zobaczyć szczegóły i dostępnych wykonawców.</p><ul>${links}</ul>`
  });
}

const STATIC_PUBLIC_PAGES = Object.freeze({
  '/about': {
    title: 'O Helpfli — marketplace usług lokalnych',
    description: 'Dowiedz się, jak Helpfli łączy klientów z wykonawcami usług lokalnych.',
    heading: 'O Helpfli'
  },
  '/help': {
    title: 'Centrum pomocy Helpfli',
    description: 'Odpowiedzi na najczęstsze pytania dotyczące zleceń, wykonawców, płatności i konta Helpfli.',
    heading: 'Centrum pomocy'
  },
  '/contact': {
    title: 'Kontakt z Helpfli',
    description: 'Skontaktuj się z zespołem Helpfli w sprawie konta, zlecenia lub współpracy.',
    heading: 'Kontakt z Helpfli'
  },
  '/why-pro': {
    title: 'Helpfli Pro — narzędzia dla wykonawców',
    description: 'Poznaj możliwości Helpfli Pro dla wykonawców usług lokalnych.',
    heading: 'Helpfli Pro'
  },
  '/regulamin': {
    title: 'Regulamin platformy Helpfli',
    description: 'Zasady korzystania z platformy Helpfli przez klientów i wykonawców.',
    heading: 'Regulamin Helpfli'
  },
  '/prywatnosc': {
    title: 'Polityka prywatności Helpfli',
    description: 'Informacje o przetwarzaniu i ochronie danych osobowych w Helpfli.',
    heading: 'Polityka prywatności'
  },
  '/cennik': {
    title: 'Cennik i opłaty Helpfli',
    description: 'Sprawdź informacje o opłatach i rozliczeniach na platformie Helpfli.',
    heading: 'Cennik i opłaty'
  },
  '/dane-firmy': {
    title: 'Dane firmy Helpfli',
    description: 'Informacje o operatorze platformy Helpfli.',
    heading: 'Dane firmy'
  },
  '/cooperation': {
    title: 'Współpraca z Helpfli',
    description: 'Możliwości współpracy biznesowej z platformą Helpfli.',
    heading: 'Współpraca z Helpfli'
  },
  '/reviews': {
    title: 'Opinie o wykonawcach | Helpfli',
    description: 'Sprawdź, jak działają opinie i oceny wykonawców na platformie Helpfli.',
    heading: 'Opinie o wykonawcach'
  }
});

function renderStaticPublicPage(path) {
  const page = STATIC_PUBLIC_PAGES[path];
  if (!page) return null;
  const base = getPublicBaseUrl();
  return buildHtmlDocument({
    title: page.title,
    description: page.description,
    canonical: `${base}${path}`,
    bodyHtml: `<h1>${escapeHtml(page.heading)}</h1><p>${escapeHtml(page.description)}</p><p><a href="${escapeHtml(base)}${escapeHtml(path)}">Przejdź do strony</a></p>`
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

  if (path === '/poradniki') return renderArticleIndex();

  if (path === '/wykonawcy') return renderPseoIndex();
  if (path === '/providers') return renderProvidersIndex();
  if (path === '/services') return renderServicesIndex();

  const staticPage = renderStaticPublicPage(path);
  if (staticPage) return staticPage;

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
