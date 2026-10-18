const {
  evaluateSeoLocalPage,
  isSeoLocalPageIndexable
} = require('../../services/SeoLocalQualityService');
const SeoLocalPage = require('../../models/SeoLocalPage');

function validPage(overrides = {}) {
  return {
    serviceSlug: 'hydraulik',
    serviceName: 'Hydraulik',
    citySlug: 'warszawa',
    cityName: 'Warszawa',
    title: 'Hydraulik w Warszawie — dostępni wykonawcy',
    metaDescription:
      'Znajdź hydraulika w Warszawie, porównaj dostępne profile wykonawców i opisz swoje zlecenie w Helpfli.',
    intro:
      'Szukasz hydraulika w Warszawie? Porównaj dostępnych wykonawców, zakres usług i opinie, a następnie opisz swoje zlecenie w jednym miejscu.',
    contentHtml: `<h2>Co warto wiedzieć</h2><p>${'Rzetelna informacja lokalna. '.repeat(18)}</p>`,
    faq: [
      { question: 'Jak wybrać wykonawcę?', answer: 'Porównaj zakres usług i dostępne opinie.' },
      { question: 'Jak opisać zlecenie?', answer: 'Podaj zakres pracy, termin i lokalizację.' }
    ],
    statsSnapshot: { providerCount: 2, recentOrders30d: 1 },
    published: true,
    ...overrides
  };
}

describe('SeoLocalQualityService', () => {
  test('nowy landing PSEO jest domyślnie draftem', () => {
    const page = new SeoLocalPage({
      serviceSlug: 'hydraulik',
      serviceName: 'Hydraulik',
      citySlug: 'warszawa',
      cityName: 'Warszawa',
      slug: 'hydraulik-warszawa'
    });
    expect(page.published).toBe(false);
  });

  test('dopuszcza opublikowaną stronę z lokalnymi danymi i kompletną treścią', () => {
    const result = evaluateSeoLocalPage(validPage());
    expect(result.indexable).toBe(true);
    expect(isSeoLocalPageIndexable(validPage())).toBe(true);
  });

  test('blokuje cienką stronę bez lokalnej podaży lub popytu', () => {
    const page = validPage({
      contentHtml: '<p>Krótki tekst.</p>',
      statsSnapshot: { providerCount: 0, recentOrders30d: 0 }
    });
    const result = evaluateSeoLocalPage(page);
    expect(result.indexable).toBe(false);
    expect(result.issues).toEqual(
      expect.arrayContaining([
        'Treść główna musi mieć co najmniej 300 znaków.',
        'Brak potwierdzonej lokalnej podaży lub popytu.'
      ])
    );
  });

  test('draft nigdy nie jest indeksowalny', () => {
    expect(isSeoLocalPageIndexable(validPage({ published: false }))).toBe(false);
  });
});
