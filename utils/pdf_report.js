// const puppeteer = require('puppeteer');

function chartDataScript({ daily, topServices }) {
  const dailyLabels = daily.map(d => d._id);
  const dailyOrders = daily.map(d => d.orders);
  const dailyRevenue = daily.map(d => Math.round((d.revenue || 0)/100));

  const topLabels = topServices.map(t => String(t._id || '—')).slice(0,10);
  const topCounts = topServices.map(t => t.count).slice(0,10);
  const topRevenue = topServices.map(t => Math.round((t.revenue || 0)/100)).slice(0,10);

  return `
    const dailyLabels = ${JSON.stringify(dailyLabels)};
    const dailyOrders = ${JSON.stringify(dailyOrders)};
    const dailyRevenue = ${JSON.stringify(dailyRevenue)};
    const topLabels = ${JSON.stringify(topLabels)};
    const topCounts = ${JSON.stringify(topCounts)};
    const topRevenue = ${JSON.stringify(topRevenue)};
  `;
}

function buildHtml({ title, range, kpi, daily, topServices }) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    body { font-family: Arial, sans-serif; color:#111; margin:24px; }
    h1 { margin:0 0 8px 0; }
    h2 { margin:24px 0 8px 0; }
    .grid { display:grid; grid-template-columns: repeat(4, 1fr); gap:12px; }
    .card { border:1px solid #ddd; border-radius:12px; padding:12px; }
    .big { font-size:22px; font-weight:700; }
    .muted { color:#666; font-size:12px;}
    canvas { width:100% !important; height:260px !important; }
    .footer { margin-top:24px; font-size:11px; color:#666; }
  </style>
</head>
<body>
  <h1>Raport miesięczny • ${range.from} → ${range.to}</h1>
  <div class="muted">Generowane przez Helpfli Analytics</div>

  <h2>KPIs</h2>
  <div class="grid">
    <div class="card"><div class="muted">Zlecenia</div><div class="big">${kpi.orders}</div></div>
    <div class="card"><div class="muted">Opłacone (w systemie)</div><div class="big">${kpi.ordersPaid}</div></div>
    <div class="card"><div class="muted">Obrót (PLN)</div><div class="big">${(kpi.revenue/100).toFixed(2)}</div></div>
    <div class="card"><div class="muted">Średnia wartość (PLN)</div><div class="big">${(kpi.avgOrder/100).toFixed(2)}</div></div>
  </div>

  <h2>Trend dzienny</h2>
  <div class="card"><canvas id="chartDaily"></canvas></div>

  <h2>Top usługi</h2>
  <div class="card"><canvas id="chartTop"></canvas></div>

  <div class="footer">© Helpfli – raport wygenerowany automatycznie.</div>

  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <script>
    ${chartDataScript({ daily, topServices })}
    const ctx1 = document.getElementById('chartDaily').getContext('2d');
    new Chart(ctx1, {
      type: 'line',
      data: { labels: dailyLabels, datasets: [
        { label: 'Zlecenia', data: dailyOrders, tension: .3 },
        { label: 'Przychód (PLN)', data: dailyRevenue, tension: .3 }
      ]},
      options: { plugins: { legend: { position:'bottom' } } }
    });
    const ctx2 = document.getElementById('chartTop').getContext('2d');
    new Chart(ctx2, {
      type: 'bar',
      data: { labels: topLabels, datasets: [
        { label: 'Zlecenia', data: topCounts },
        { label: 'Przychód (PLN)', data: topRevenue }
      ]}, options: { indexAxis: 'y', plugins:{ legend:{ position:'bottom' } } }
    });
  </script>
</body></html>`;
}

// async function renderPdfFromHtml(html, pdfOptions = {}) {
//   const browser = await puppeteer.launch({ headless: 'new', args: ['--no-sandbox'] });
//   try {
//     const page = await browser.newPage();
//     await page.setContent(html, { waitUntil: 'networkidle0' });
//     const pdf = await page.pdf({
//       format: 'A4',
//       printBackground: true,
//       margin: { top: '14mm', right: '12mm', bottom: '14mm', left: '12mm' },
//       ...pdfOptions
//     });
//     return pdf;
//   } finally {
//     await browser.close();
//   }
// }

module.exports = { buildHtml };
function buildHtmlPerCity({ title, range, cities }) {
  const sections = cities.map((c, idx) => {
    const id = `c${idx}`;
    const dailyLabels = c.daily.map(d => d._id);
    const dailyOrders = c.daily.map(d => d.orders);
    const dailyRevenue = c.daily.map(d => Math.round((d.revenue || 0)/100));
    const topLabels = c.topServices.map(t => String(t._id || '—')).slice(0,10);
    const topCounts = c.topServices.map(t => t.count).slice(0,10);
    const topRevenue = c.topServices.map(t => Math.round((t.revenue || 0)/100)).slice(0,10);

    return `
      <div class="page">
        <h2>${c.city || '—'}</h2>
        <div class="grid">
          <div class="card"><div class="muted">Zlecenia</div><div class="big">${c.kpi.orders}</div></div>
          <div class="card"><div class="muted">Opłacone</div><div class="big">${c.kpi.ordersPaid}</div></div>
          <div class="card"><div class="muted">Obrót (PLN)</div><div class="big">${(c.kpi.revenue/100).toFixed(2)}</div></div>
          <div class="card"><div class="muted">% w systemie</div><div class="big">${(c.kpi.paidShare*100).toFixed(1)}%</div></div>
        </div>
        <h3>Trend dzienny</h3>
        <div class="card"><canvas id="d_${id}"></canvas></div>
        <h3>Top usługi</h3>
        <div class="card"><canvas id="t_${id}"></canvas></div>
        <div class="break"></div>
        <script>
          (function(){
            const dailyLabels = ${JSON.stringify(dailyLabels)};
            const dailyOrders = ${JSON.stringify(dailyOrders)};
            const dailyRevenue = ${JSON.stringify(dailyRevenue)};
            const topLabels = ${JSON.stringify(topLabels)};
            const topCounts = ${JSON.stringify(topCounts)};
            const topRevenue = ${JSON.stringify(topRevenue)};
            new Chart(document.getElementById('d_${id}').getContext('2d'), {
              type: 'line',
              data: { labels: dailyLabels, datasets: [
                { label: 'Zlecenia', data: dailyOrders, tension:.3 },
                { label: 'Przychód (PLN)', data: dailyRevenue, tension:.3 }
              ]}, options:{ plugins:{ legend:{ position:'bottom' } } }
            });
            new Chart(document.getElementById('t_${id}').getContext('2d'), {
              type: 'bar',
              data: { labels: topLabels, datasets: [
                { label: 'Zlecenia', data: topCounts },
                { label: 'Przychód (PLN)', data: topRevenue }
              ]}, options:{ indexAxis:'y', plugins:{ legend:{ position:'bottom' } } }
            });
          })();
        </script>
      </div>
    `;
  }).join('\n');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<title>${title}</title>
<style>
  body { font-family: Arial, sans-serif; color:#111; margin:24px; }
  h1 { margin:0 0 8px 0; }
  h2 { margin:24px 0 8px 0; }
  h3 { margin:18px 0 8px 0; }
  .grid { display:grid; grid-template-columns: repeat(4, 1fr); gap:12px; }
  .card { border:1px solid #ddd; border-radius:12px; padding:12px; }
  .big { font-size:22px; font-weight:700; }
  .muted { color:#666; font-size:12px;}
  .break { page-break-after: always; }
  .page { page-break-inside: avoid; }
  canvas { width:100% !important; height:240px !important; }
</style>
</head>
<body>
  <h1>Raport miesięczny per miasto • ${range.from} → ${range.to}</h1>
  <div class="muted">Top segmenty miast</div>
  ${sections}
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
</body>
</html>`;
}

module.exports = { buildHtml, buildHtmlPerCity };

function i18nDict(lang = 'pl') {
  const pl = {
    kpis: 'KPIs',
    orders: 'Zlecenia',
    paidOrders: 'Opłacone (w systemie)',
    revenue: 'Obrót (PLN)',
    avgOrder: 'Średnia wartość (PLN)',
    systemShare: '% płatnych w systemie',
    dailyTrend: 'Trend dzienny',
    topServices: 'Top usługi',
    topCities: 'Top miasta',
    service: 'Usługa',
    monthlyReport: 'Raport miesięczny',
    monthlyPerService: 'Raport miesięczny per usługa',
  };
  const en = {
    kpis: 'KPIs',
    orders: 'Orders',
    paidOrders: 'Paid in-system',
    revenue: 'Revenue (PLN)',
    avgOrder: 'Avg order (PLN)',
    systemShare: 'In-system share',
    dailyTrend: 'Daily trend',
    topServices: 'Top services',
    topCities: 'Top cities',
    service: 'Service',
    monthlyReport: 'Monthly Report',
    monthlyPerService: 'Monthly Report by Service',
  };
  return lang === 'en' ? en : pl;
}

function brandHeaderHtml(brand = {}) {
  const primary = brand.primary || '#7c3aed';
  const logo = brand.logoUrl;
  return `
  <style>
    :root { --brand: ${primary}; }
    .brand-title { display:flex; align-items:center; gap:12px; margin-bottom:6px; }
    .brand-logo { height:28px; }
    .brand-name { font-weight:800; font-size:18px; color:var(--brand); letter-spacing:.3px; }
  </style>
  <div class="brand-title">
    ${logo ? `<img class="brand-logo" src="${logo}" alt="logo"/>` : ''}
    <div class="brand-name">${brand.name || 'Helpfli'}</div>
  </div>`;
}

/** Multipage PDF: per-usługa (z „Top miasta” dla danej usługi) */
function buildHtmlPerService({ title, range, services, brand = {}, lang = 'pl' }) {
  const t = i18nDict(lang);
  const sections = services.map((svc, idx) => {
    const id = `s${idx}`;
    const dailyLabels = svc.daily.map(d => d._id);
    const dailyOrders = svc.daily.map(d => d.orders);
    const dailyRevenue = svc.daily.map(d => Math.round((d.revenue || 0)/100));
    const citiesLabels = (svc.topCities || []).map(c => c._id || '—').slice(0,10);
    const citiesCounts = (svc.topCities || []).map(c => c.count).slice(0,10);
    const citiesRevenue = (svc.topCities || []).map(c => Math.round((c.revenue || 0)/100)).slice(0,10);

    return `
      <div class="page">
        <h2>${t.service}: ${svc.name || svc.key}</h2>
        <div class="grid">
          <div class="card"><div class="muted">${t.orders}</div><div class="big">${svc.kpi.orders}</div></div>
          <div class="card"><div class="muted">${t.paidOrders}</div><div class="big">${svc.kpi.paidOrders}</div></div>
          <div class="card"><div class="muted">${t.revenue}</div><div class="big">${(svc.kpi.revenue/100).toFixed(2)}</div></div>
          <div class="card"><div class="muted">${t.systemShare}</div><div class="big">${(svc.kpi.systemShare*100).toFixed(1)}%</div></div>
        </div>

        <h3>${t.dailyTrend}</h3>
        <div class="card"><canvas id="d_${id}"></canvas></div>

        <h3>${t.topCities}</h3>
        <div class="card"><canvas id="c_${id}"></canvas></div>

        <div class="break"></div>
        <script>
          (function(){
            const dailyLabels = ${JSON.stringify(dailyLabels)};
            const dailyOrders = ${JSON.stringify(dailyOrders)};
            const dailyRevenue = ${JSON.stringify(dailyRevenue)};
            const citiesLabels = ${JSON.stringify(citiesLabels)};
            const citiesCounts = ${JSON.stringify(citiesCounts)};
            const citiesRevenue = ${JSON.stringify(citiesRevenue)};
            new Chart(document.getElementById('d_${id}').getContext('2d'), {
              type: 'line',
              data: { labels: dailyLabels, datasets: [
                { label: '${t.orders}', data: dailyOrders, tension:.3 },
                { label: '${t.revenue}', data: dailyRevenue, tension:.3 }
              ]}, options:{ plugins:{ legend:{ position:'bottom' } } }
            });
            new Chart(document.getElementById('c_${id}').getContext('2d'), {
              type: 'bar',
              data: { labels: citiesLabels, datasets: [
                { label: '${t.orders}', data: citiesCounts },
                { label: '${t.revenue}', data: citiesRevenue }
              ]}, options:{ indexAxis:'y', plugins:{ legend:{ position:'bottom' } } }
            });
          })();
        </script>
      </div>
    `;
  }).join('\n');

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${title}</title>
  <style>
    body { font-family: Arial, sans-serif; color:#111; margin:24px; }
    h1 { margin:0 0 8px 0; }
    h2 { margin:22px 0 8px 0; }
    h3 { margin:18px 0 8px 0; }
    .grid { display:grid; grid-template-columns: repeat(4, 1fr); gap:12px; }
    .card { border:1px solid #ddd; border-radius:12px; padding:12px; }
    .big { font-size:22px; font-weight:700; }
    .muted { color:#666; font-size:12px;}
    .break { page-break-after: always; }
    .page { page-break-inside: avoid; }
    canvas { width:100% !important; height:240px !important; }
    .range { color:#666; font-size:12px; margin-bottom:8px; }
  </style>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  ${brandHeaderHtml(brand)}
  <h1>${title}</h1>
  <div class="range">${range.from} → ${range.to}</div>
</head>
<body>
  ${sections}
</body>
</html>`;
}

module.exports = {
  buildHtml,
  buildHtmlPerCity,
  buildHtmlPerService,
  i18nDict,
};
