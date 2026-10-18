const { buildCanonicalServiceSlug, slugifyPolish } = require('../../utils/seoSlug');

describe('seoSlug', () => {
  test('transliteruje wszystkie polskie znaki, w tym ł', () => {
    expect(slugifyPolish('Zażółć gęślą jaźń')).toBe('zazolc-gesla-jazn');
  });

  test('buduje stabilny slug usługi z kategorii i polskiej nazwy', () => {
    expect(
      buildCanonicalServiceSlug({
        parent_slug: 'auto-mobilne',
        name_pl: 'Wymiana opon i kół na miejscu – sezonowo'
      })
    ).toBe('auto-mobilne-wymiana-opon-i-kol-na-miejscu-sezonowo');
  });
});
