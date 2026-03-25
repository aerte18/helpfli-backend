/**
 * E2E test: pełny proces zlecenia (utworzenie → oferta → akceptacja → realizacja → zakończenie → ocena)
 * w obu wariantach płatności: przez stronę (system) i poza systemem (external).
 * Sprawdza widoczność na koncie klienta i providera po każdym etapie.
 *
 * Wymagania: backend na localhost:5000, MongoDB, użytkownicy client@helpfli.local (client123) i provider@helpfli.local (provider123).
 * Uruchom: node scripts/test_order_flow_e2e.js
 * Uwaga: Provider może mieć hasło test123 (create_provider_user.js) lub provider123 – w razie błędu logowania sprawdź.
 */
require('dotenv').config();
const BASE = process.env.API_BASE_URL || 'http://localhost:5000';

const PROVIDER_PASSWORD = process.env.TEST_PROVIDER_PASSWORD || 'provider123';

async function request(method, path, body, token) {
  const url = path.startsWith('http') ? path : `${BASE}${path}`;
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  };
  if (body && method !== 'GET') opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status >= 500) console.error('Response body:', JSON.stringify(data, null, 2));
    const msg = data.message || data.error || (typeof data.error === 'string' ? data.error : JSON.stringify(data));
    throw new Error(msg || `HTTP ${res.status} ${method} ${url}`);
  }
  return data;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Assert failed');
}

async function login(email, password) {
  const data = await request('POST', '/api/auth/login', { email, password });
  assert(data.token, 'Brak tokenu w odpowiedzi logowania');
  return data.token;
}

async function ensureKycVerified() {
  const mongoose = require('mongoose');
  const User = require('../models/User');
  const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/helpfli';
  if (mongoose.connection.readyState !== 1) await mongoose.connect(uri);
  await User.updateMany(
    { email: { $in: ['client@helpfli.local', 'provider@helpfli.local'] } },
    { $set: { 'kyc.status': 'verified' } }
  );
}

async function runFlow(paymentVariant) {
  const isSystem = paymentVariant === 'system';
  console.log(`\n--- Flow: płatność ${isSystem ? 'przez stronę (system)' : 'poza systemem (external)'} ---\n`);

  await ensureKycVerified();

  const clientToken = await login('client@helpfli.local', 'client123');
  let providerToken;
  try {
    providerToken = await login('provider@helpfli.local', PROVIDER_PASSWORD);
  } catch (e) {
    providerToken = await login('provider@helpfli.local', 'test123');
  }

  // 1. Klient tworzy zlecenie
  const createPayload = {
    service: 'hydraulika',
    description: `Test E2E ${paymentVariant} - naprawa kranu`,
    location: 'Warszawa', // backend akceptuje string lub location: { address, lat, lng }
    paymentPreference: paymentVariant,
    matchMode: 'open',
    urgency: 'flexible',
  };
  const orderRes = await request('POST', '/api/orders', createPayload, clientToken);
  const orderIdRaw = orderRes._id || orderRes.orderId || orderRes.order?._id;
  assert(orderIdRaw, 'Brak orderId po utworzeniu zlecenia');
  const orderId = String(orderIdRaw);
  console.log('1. Zlecenie utworzone:', orderId);
  const orderDetail = await request('GET', `/api/orders/${orderId}`, null, clientToken);
  assert(orderDetail.paymentPreference === paymentVariant, `Nieprawidłowa paymentPreference: ${orderDetail.paymentPreference}`);
  console.log('   paymentPreference:', orderDetail.paymentPreference);

  let myOrdersClient = await request('GET', '/api/orders/my', null, clientToken);
  let items = myOrdersClient.items || myOrdersClient.orders || myOrdersClient;
  assert(Array.isArray(items) && items.some(o => String(o._id) === String(orderId)), 'Klient nie widzi zlecenia w /api/orders/my');
  console.log('   Klient widzi zlecenie w Moje zlecenia: OK');

  // 2. Provider składa ofertę
  const offerPayload = {
    orderId,
    price: 150,
    amount: 150,
    etaMinutes: 60,
    notes: 'Oferta testowa E2E',
  };
  const offerRes = await request('POST', '/api/offers', offerPayload, providerToken);
  const offerId = offerRes._id || offerRes.offer?._id;
  assert(offerId, 'Brak offerId po złożeniu oferty');
  console.log('2. Oferta złożona:', offerId);

  let myOrdersProvider = await request('GET', '/api/orders/my', null, providerToken);
  items = myOrdersProvider.items || myOrdersProvider.orders || myOrdersProvider;
  assert(Array.isArray(items) && items.some(o => String(o._id) === String(orderId)), 'Provider nie widzi zlecenia w Moje zlecenia');
  console.log('   Provider widzi zlecenie w Moje zlecenia: OK');

  // 3. Klient akceptuje ofertę
  const orderBeforeAccept = await request('GET', `/api/orders/${orderId}`, null, clientToken);
  const providerId = orderBeforeAccept.provider?._id || orderBeforeAccept.provider;
  await request('POST', `/api/offers/${offerId}/accept`, {
    paymentMethod: paymentVariant,
    totalAmount: 150,
    breakdown: { baseAmount: 150, platformFee: 0, guaranteeFee: 0 },
  }, clientToken);

  const orderAfterAccept = await request('GET', `/api/orders/${orderId}`, null, clientToken);
  assert(orderAfterAccept.status === 'accepted', `Status po akceptacji powinien być accepted, jest: ${orderAfterAccept.status}`);
  assert(String(orderAfterAccept.paymentPreference || '') === paymentVariant, 'Nieprawidłowy paymentPreference po akceptacji');
  console.log('3. Oferta zaakceptowana, status:', orderAfterAccept.status, 'paymentPreference:', orderAfterAccept.paymentPreference);

  if (isSystem) {
    // Symulacja płatności: ustawienie w bazie (bez Stripe)
    const mongoose = require('mongoose');
    const Order = require('../models/Order');
    const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/helpfli';
    if (mongoose.connection.readyState !== 1) await mongoose.connect(uri);
    await Order.findByIdAndUpdate(orderId, {
      paymentStatus: 'succeeded',
      paidInSystem: true,
      protectionEligible: true,
      protectionStatus: 'active',
      protectionExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    console.log('   (Płatność przez system: symulacja paidInSystem=true)');
  }

  // 4. Provider rozpoczyna pracę
  await request('POST', `/api/orders/${orderId}/start`, {}, providerToken);
  const orderAfterStart = await request('GET', `/api/orders/${orderId}`, null, clientToken);
  assert(orderAfterStart.status === 'in_progress', `Status po start powinien być in_progress, jest: ${orderAfterStart.status}`);
  console.log('4. Realizacja rozpoczęta, status:', orderAfterStart.status);

  myOrdersClient = await request('GET', '/api/orders/my', null, clientToken);
  myOrdersProvider = await request('GET', '/api/orders/my', null, providerToken);
  const clientList = myOrdersClient.items || myOrdersClient.orders || myOrdersClient;
  const providerList = myOrdersProvider.items || myOrdersProvider.orders || myOrdersProvider;
  const clientHas = Array.isArray(clientList) && clientList.some(o => String(o._id) === String(orderId) && (o.status === 'in_progress' || o.status === 'in progress'));
  const providerHas = Array.isArray(providerList) && providerList.some(o => String(o._id) === String(orderId) && (o.status === 'in_progress' || o.status === 'in progress'));
  assert(clientHas, 'Klient nie widzi zlecenia in_progress');
  assert(providerHas, 'Provider nie widzi zlecenia in_progress');
  console.log('   Klient i provider widzą zlecenie w realizacji: OK');

  // 5. Provider kończy zlecenie
  await request('POST', `/api/orders/${orderId}/complete`, {
    completionType: 'simple',
    completionNotes: null,
    additionalAmount: null,
    paymentReason: null,
  }, providerToken);
  const orderAfterComplete = await request('GET', `/api/orders/${orderId}`, null, clientToken);
  assert(orderAfterComplete.status === 'completed', `Status po complete powinien być completed, jest: ${orderAfterComplete.status}`);
  console.log('5. Zlecenie zakończone przez wykonawcę, status:', orderAfterComplete.status);

  // 6. Klient potwierdza odbiór
  await request('POST', `/api/orders/${orderId}/confirm-receipt`, {}, clientToken);
  const orderAfterReceipt = await request('GET', `/api/orders/${orderId}`, null, clientToken);
  assert(orderAfterReceipt.status === 'released', `Status po confirm-receipt powinien być released, jest: ${orderAfterReceipt.status}`);
  console.log('6. Odbiór potwierdzony, status:', orderAfterReceipt.status);

  // 7. Klient ocenia wykonawcę (tylko w pierwszym flow – przy drugim już oceniony)
  const providerIdToRate = orderAfterReceipt.provider?._id || orderAfterReceipt.provider;
  assert(providerIdToRate, 'Brak providerId do oceny');
  try {
    await request('POST', '/api/ratings', {
      ratedUser: providerIdToRate,
      rating: 5,
      comment: 'Świetna realizacja testu E2E',
      orderId,
    }, clientToken);
    console.log('7. Ocena wystawiona (klient → provider)');
  } catch (e) {
    if (e.message && e.message.includes('Już oceniłeś')) console.log('7. Ocena pominięta (już oceniono tego wykonawcę)');
    else throw e;
  }

  // Podsumowanie widoczności
  const myClient = await request('GET', '/api/orders/my', null, clientToken);
  const myProvider = await request('GET', '/api/orders/my', null, providerToken);
  const clientItems = myClient.items || myClient.orders || myClient;
  const providerItems = myProvider.items || myProvider.orders || myProvider;
  const orderInClient = Array.isArray(clientItems) ? clientItems.find(o => String(o._id) === String(orderId)) : null;
  const orderInProvider = Array.isArray(providerItems) ? providerItems.find(o => String(o._id) === String(orderId)) : null;
  console.log('\nWidoczność na koncie:');
  console.log('  Klient:', orderInClient ? `zlecenie ${orderId}, status ${orderInClient.status}` : 'BRAK ZLECENIA');
  console.log('  Provider:', orderInProvider ? `zlecenie ${orderId}, status ${orderInProvider.status}` : 'BRAK ZLECENIA');
  assert(orderInClient && orderInProvider, 'Zlecenie musi być widoczne u klienta i providera na końcu flow');
  console.log(`\n✅ Flow ${paymentVariant} zakończony pomyślnie.`);
  return orderId;
}

async function main() {
  console.log('E2E Test: Pełny proces zlecenia (external + system)\n');
  console.log('Backend:', BASE);
  const errors = [];
  try {
    await runFlow('external');
  } catch (e) {
    errors.push({ flow: 'external', error: e.message });
    console.error('Błąd flow external:', e.message);
  }
  try {
    await runFlow('system');
  } catch (e) {
    errors.push({ flow: 'system', error: e.message });
    console.error('Błąd flow system:', e.message);
  }
  if (errors.length) {
    console.log('\n❌ Niektóre flow zakończyły się błędem:', errors);
    process.exit(1);
  }
  console.log('\n✅ Wszystkie testy E2E zakończone pomyślnie.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
