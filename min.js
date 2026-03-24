require('dotenv').config();

const express = require('express');
const cors = require('cors');

const app = express();
app.use(express.json());

const FRONTENDS = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:5175',
];

app.use(
  cors({
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (FRONTENDS.includes(origin)) return cb(null, true);
      return cb(null, true);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Accept', 'Origin']
  })
);

const CATEGORIES = [
  { _id: 'hydraulika', name: 'Hydraulika', icon: 'plumbing', isTop: true, isSeasonal: false, subcategories: [
    { id: 'udraznianie', name: 'Udrażnianie odpływów i kanalizacji' },
    { id: 'wyciek', name: 'Naprawa wycieku' },
    { id: 'bialy_montaz', name: 'Podłączenie zmywarki / pralki (biały montaż)' },
    { id: 'wymiana_wc', name: 'Wymiana WC / spłuczki / mechanizmu' }
  ] },
  { _id: 'elektryka', name: 'Elektryka', icon: 'bolt', isTop: true, isSeasonal: false, subcategories: [
    { id: 'gniazdka', name: 'Montaż gniazdek / włączników / oświetlenia (LED)' },
    { id: 'rozdzielnia', name: 'Wymiana bezpieczników / naprawa rozdzielni' },
    { id: 'pomiary', name: 'Pomiary elektryczne i protokoły' }
  ] },
  { _id: 'piec', name: 'Przegląd pieca', icon: 'heater', isTop: false, isSeasonal: true, subcategories: [
    { id: 'przeglad_pieca', name: 'Przegląd pieca CO' },
    { id: 'regulacja_co', name: 'Regulacja / serwis instalacji c.o.' }
  ] },
  { _id: 'klima', name: 'Czyszczenie klimatyzacji', icon: 'air', isTop: false, isSeasonal: true, subcategories: [
    { id: 'odgrzybianie', name: 'Nabicie / serwis czynnika, odgrzybianie' },
    { id: 'czyszczenie_klimy', name: 'Czyszczenie jednostek' }
  ] },
  { _id: 'lekarz', name: 'Lekarz na telefon', icon: 'med', isTop: true, isSeasonal: false, subcategories: [
    { id: 'teleporada', name: 'Telekonsultacja lekarza' },
    { id: 'wizyta_domowa', name: 'Wizyty domowe (opieka podstawowa)' }
  ] }
];

const SERVICES = [
  { _id: 's1', name: 'Udrażnianie kanalizacji', categoryId: 'hydraulika', isTop: true },
  { _id: 's2', name: 'Naprawa wycieku', categoryId: 'hydraulika', isTop: true },
  { _id: 's3', name: 'Montaż gniazdek LED', categoryId: 'elektryka', isTop: true },
  { _id: 's4', name: 'Pomiary elektryczne', categoryId: 'elektryka', isTop: true },
  { _id: 's5', name: 'Przegląd pieca CO', categoryId: 'piec', isTop: false },
  { _id: 's6', name: 'Czyszczenie klimatyzacji', categoryId: 'klima', isTop: false },
  { _id: 's7', name: 'Telekonsultacja lekarza', categoryId: 'lekarz', isTop: true },
  { _id: 's8', name: 'Wizyta domowa', categoryId: 'lekarz', isTop: true },
  { _id: 's9', name: 'Sprzątanie mieszkania', categoryId: 'sprzatanie', isTop: true },
  { _id: 's10', name: 'Mycie okien', categoryId: 'sprzatanie', isTop: true }
];

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, time: new Date().toISOString() });
});

app.get('/api/categories', (req, res) => {
  const { is_top, is_seasonal, limit } = req.query;
  let list = CATEGORIES.slice();
  if (typeof is_top !== 'undefined') {
    const v = String(is_top).toLowerCase();
    list = list.filter(c => c.isTop === (v === '1' || v === 'true'));
  }
  if (typeof is_seasonal !== 'undefined') {
    const v = String(is_seasonal).toLowerCase();
    list = list.filter(c => c.isSeasonal === (v === '1' || v === 'true'));
  }
  const lim = Math.min(Number(limit) || 50, 200);
  res.json({ items: list.slice(0, lim), count: Math.min(list.length, lim) });
});

app.get('/api/services', (req, res) => {
  const { is_top, limit, skip } = req.query;
  let list = SERVICES.slice();
  if (typeof is_top !== 'undefined') {
    const v = String(is_top).toLowerCase();
    list = list.filter(s => s.isTop === (v === '1' || v === 'true'));
  }
  const sk = Number(skip) || 0;
  const lim = Math.min(Number(limit) || 20, 100);
  res.json({ items: list.slice(sk, sk + lim), count: Math.min(list.length - sk, lim) });
});

const PORT = process.env.MIN_PORT || 5002;
app.listen(PORT, () => {
  console.log(`[min] API listening on :${PORT}`);
});


