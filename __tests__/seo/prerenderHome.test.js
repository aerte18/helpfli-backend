const { renderForPath } = require('../../services/SeoPrerenderService');

describe('SEO prerender homepage', () => {
  test('renders customer-focused metadata, structured data and crawlable service links', async () => {
    const html = await renderForPath('/');

    expect(html).toContain('<title>Fachowcy i usługi lokalne w Twojej okolicy | Helpfli</title>');
    expect(html).toContain('"@type":"SearchAction"');
    expect(html).toContain('"@type":"FAQPage"');
    expect(html).toContain('/service/hydraulika-naprawa-wycieku');
    expect(html).toContain('/services');
    expect(html).toContain('/wykonawcy');
    expect(html).toContain('/create-order');
    expect(html).toContain('wypełnić całe zlecenie bez logowania');
  });
});
