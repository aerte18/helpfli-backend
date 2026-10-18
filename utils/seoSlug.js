const POLISH_CHAR_MAP = Object.freeze({
  ą: 'a',
  ć: 'c',
  ę: 'e',
  ł: 'l',
  ń: 'n',
  ó: 'o',
  ś: 's',
  ź: 'z',
  ż: 'z'
});

function slugifyPolish(value, maxLength = 160) {
  const transliterated = String(value || '')
    .trim()
    .split('')
    .map((char) => POLISH_CHAR_MAP[char.toLowerCase()] || char)
    .join('');

  return transliterated
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
}

function buildCanonicalServiceSlug(service) {
  if (!service) return '';
  const parent = slugifyPolish(service.parent_slug || service.parentSlug || '', 80);
  const name = slugifyPolish(
    service.name_pl || service.name || service.name_en || '',
    140
  );
  if (!name) return slugifyPolish(service.slug || '', 220);
  if (!parent || name === parent || name.startsWith(`${parent}-`)) return name;
  return `${parent}-${name}`.slice(0, 220).replace(/-+$/g, '');
}

module.exports = {
  buildCanonicalServiceSlug,
  slugifyPolish
};
