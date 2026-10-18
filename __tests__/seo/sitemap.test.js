const { renderSitemapXml } = require('../../routes/seo');

describe('SEO sitemap', () => {
  test('nie wymyśla lastmod, gdy encja nie ma daty', () => {
    const xml = renderSitemapXml(
      'https://helpfli.pl',
      [],
      [],
      [],
      [
        {
          slug: 'elektryka-pomiary-elektryczne-i-protoko-y',
          parent_slug: 'elektryka',
          name_pl: 'Pomiary elektryczne i protokoły'
        }
      ]
    );
    expect(xml).toContain(
      '<loc>https://helpfli.pl/service/elektryka-pomiary-elektryczne-i-protokoly</loc>'
    );
    expect(xml).not.toContain('<lastmod>');
  });

  test('używa updated_at usługi jako lastmod', () => {
    const updatedAt = new Date('2026-10-01T10:00:00.000Z');
    const xml = renderSitemapXml(
      'https://helpfli.pl',
      [],
      [],
      [],
      [
        {
          slug: 'hydraulika-wymiana-wc-spluczki-mechanizmu',
          parent_slug: 'hydraulika',
          name_pl: 'Wymiana WC / spłuczki / mechanizmu',
          updated_at: updatedAt
        }
      ]
    );
    expect(xml).toContain('<lastmod>2026-10-01T10:00:00.000Z</lastmod>');
  });
});
