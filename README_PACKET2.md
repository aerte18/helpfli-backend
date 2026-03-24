?# 📦 Helpfli – Pakiet 2 - Instrukcje uruchomienia

## ✅ **Co zostało zaimplementowane**

### Backend
- ✅ Modele: `Payment`, `Promotion`, `ProSubscription`, `KYCVerification`, `Favorite`
- ✅ Trasy: płatności Stripe, promowanie, PRO, KYC, ulubieni, AI Concierge
- ✅ Webhook Stripe z obsługą wszystkich typów płatności
- ✅ Middleware `requireVerifiedProvider` dla blokady akcji bez KYC
- ✅ Push notifications i admin analytics

### Frontend
- ✅ Nowe trasy w React Router: `/kyc`, `/ai`
- ✅ Linki w nawigacji dla AI Concierge i KYC
- ✅ Badge'i TOP/PRO w ProviderCard
- ✅ Integracja z istniejącą nawigacją

## 🚀 **Kroki uruchomienia**

### 1. **Konfiguracja środowiska**

Skopiuj `env.example` do `.env` i uzupełnij:
```bash
# Backend
cp env.example .env

# Frontend  
cp env.example .env
```

**Wymagane zmienne:**
- `STRIPE_SECRET_KEY` - klucz testowy z Dashboard Stripe
- `STRIPE_WEBHOOK_SECRET` - webhook secret z Dashboard Stripe
- `STRIPE_PRICE_*` - ID cen z utworzonych produktów w Stripe
- `VAPID_*` - klucze push notifications

### 2. **Migracja modeli**

Uruchom migrację, żeby dodać nowe pola do istniejących dokumentów:
```bash
cd backend
node scripts/migrate_pack2_users_orders.js
```

### 3. **Seeding demo danych**

Utwórz testowe dane:
```bash
cd backend
node scripts/seed_pack2_demo.js
```

**Demo konta:**
- `jan@helpfli.test` / `Test1234!` (hydraulik, KYC verified, PRO)
- `ewa@helpfli.test` / `Test1234!` (elektryk, KYC verified)

### 4. **Konfiguracja Stripe**

1. Przejdź do [Stripe Dashboard](https://dashboard.stripe.com/test/products)
2. Utwórz produkty dla promowania:
   - PROMO_24H (cena: 19.99 PLN)
   - TOP_7 (cena: 49.99 PLN)
   - TOP_14 (cena: 89.99 PLN)
   - TOP_31 (cena: 149.99 PLN)
3. Utwórz produkty dla PRO:
   - PRO_MONTHLY (cena: 29.99 PLN/miesiąc)
   - PRO_YEARLY (cena: 299.99 PLN/rok)
4. Skopiuj ID cen do `.env`

### 5. **Generowanie kluczy VAPID**

```bash
cd backend
npx web-push generate-vapid-keys
```

Skopiuj wygenerowane klucze do `.env`.

### 6. **Uruchomienie aplikacji**

```bash
# Terminal 1 - Backend
cd backend
npm run dev

# Terminal 2 - Frontend
cd frontend
npm run dev

# Terminal 3 - Stripe Webhook (opcjonalnie)
cd backend
npm run stripe:listen
```

## 🧪 **Testowanie funkcji**

### Płatności
1. Utwórz zlecenie
2. Kliknij "Zapłać w systemie"
3. Użyj testowej karty: `4242 4242 4242 4242`
4. Sprawdź webhook w logach backendu

### Promowanie
1. Zaloguj się jako provider
2. Przejdź do `/account/subscriptions`
3. Kup promowanie (TOP 7 dni)
4. Sprawdź badge TOP w ProviderCard

### KYC
1. Zaloguj się jako provider
2. Przejdź do `/kyc`
3. Uzupełnij wszystkie kroki
4. Status zmieni się na "pending"

### AI Concierge
1. Przejdź do `/ai`
2. Wybierz usługę i opisz problem
3. Zapisz draft
4. Kliknij "Wyślij zlecenie (1-klik)"

## 🔧 **Rozwiązywanie problemów**

### Błąd "Model not found"
- Sprawdź czy wszystkie modele są zaimportowane w `server.js`
- Uruchom migrację: `node scripts/migrate_pack2_users_orders.js`

### Webhook Stripe nie działa
- Sprawdź `STRIPE_WEBHOOK_SECRET` w `.env`
- Upewnij się, że webhook używa `express.raw()` w `server.js`
- Sprawdź logi backendu

### Badge'i nie wyświetlają się
- Sprawdź czy użytkownik ma `badges.topUntil` lub `badges.pro`
- Uruchom seeder: `node scripts/seed_pack2_demo.js`

## 📚 **Dokumentacja API**

### Nowe endpointy
- `POST /api/payments/checkout-session` - tworzenie płatności
- `POST /api/promotions/checkout` - promowanie
- `POST /api/pro/checkout` - subskrypcja PRO
- `GET /api/kyc/me` - status KYC
- `POST /api/kyc/step` - uzupełnianie kroku KYC
- `GET /api/favorites` - lista ulubionych
- `POST /api/ai/draft` - zapis draftu zlecenia

### Webhook Stripe
- `POST /api/payments/webhook` - obsługa wszystkich eventów Stripe

## 🎯 **Następne kroki**

1. **Testowanie end-to-end** wszystkich funkcji
2. **Integracja z istniejącymi komponentami** (np. dodanie przycisków płatności)
3. **Stylowanie UI** dla nowych funkcji
4. **Dodanie powiadomień push** po akcjach
5. **Testowanie w środowisku produkcyjnym**

## 🚀 **Szybki start (zaktualizowany)**

```bash
# 1) Backend – env i deps
cp env.example .env  # wklej klucze STRIPE_*, VAPID_*
npm i
npm i -D nodemon

# 2) Webhook Stripe (osobne okno)
npm run stripe:listen  # skopiuj whsec do .env jako STRIPE_WEBHOOK_SECRET

# 3) Patch + migracja + seed
npm run migrate:pack2
npm run seed:pack2

# 4) Start backendu
npm run dev

# 5) Frontend
cd ../frontend
cp env.example .env  # wklej klucze VITE_*
npm i
npm run dev
```

## 🔧 **Skrypty npm**

### Backend
- `npm run migrate:pack2` - migracja modeli User/Order
- `npm run seed:pack2` - demo services + providerzy
- `npm run stripe:listen` - nasłuch webhooków Stripe
- `npm run stripe:register` - test webhooków

### Frontend
- `npm run dev` - development server
- `npm run build` - production build
- `npm run preview` - preview production build

---

**Status: ✅ Zaimplementowane i gotowe do testowania**
