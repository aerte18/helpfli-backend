# Helpfli Marketing Read API — integracja AI Command Center

Wersjonowane, **read-only** API service-to-service udostępniające zagregowane dane marketingowe bez PII.

## Ścieżki (finalne)

| Metoda | Ścieżka Helpfli | Uwaga dla ACC |
|--------|-----------------|---------------|
| GET | `/api/integrations/marketing/v1/catalog` | ACC MVP oczekuje `/api/integrations/marketing/catalog` — **wymaga mapowania** |
| POST | `/api/integrations/marketing/v1/demand-summary` | j.w. |
| POST | `/api/integrations/marketing/v1/supply-summary` | j.w. |
| GET | `/api/integrations/marketing/v1/platform-facts` | j.w. |
| GET | `/api/integrations/marketing/v1/claims` | j.w. |
| GET | `/api/integrations/marketing/v1/health` | smoke / monitoring |

**Rekomendacja ACC:** ustaw `HELPFLI_API_BASE_URL` + sufiks `/api/integrations/marketing/v1` albo dodaj rewrite w kliencie.

## Autoryzacja

Nagłówek (jeden z):

```http
Authorization: Bearer <AI_COMMAND_CENTER_READ_TOKEN>
```

lub

```http
X-Internal-Token: <AI_COMMAND_CENTER_READ_TOKEN>
```

- Brak tokenu → `401 unauthorized`
- Zły token → `403 forbidden`
- Brak `AI_COMMAND_CENTER_READ_TOKEN` na serwerze → `503 integration_unavailable`
- Opcjonalnie: `AI_COMMAND_CENTER_ALLOWED_IPS` (lista po przecinku)

Token **nie jest** tokenem JWT użytkownika. Porównanie: `crypto.timingSafeEqual`.

## Konfiguracja (.env)

```env
AI_COMMAND_CENTER_READ_TOKEN=wygeneruj-min-32-znakow-losowych
AI_COMMAND_CENTER_ALLOWED_IPS=
AI_COMMAND_CENTER_RATE_LIMIT=60
AI_COMMAND_CENTER_RATE_LIMIT_WINDOW_MS=60000
MARKETING_INTEGRATION_PRIVACY_MIN_COUNT=5
MARKETING_INTEGRATION_MAX_DATE_RANGE_DAYS=90
MARKETING_INTEGRATION_MAX_CATEGORIES=20
MARKETING_INTEGRATION_MAX_LOCATIONS=20
MARKETING_INTEGRATION_CACHE_TTL_SECONDS=300
MARKETING_INTEGRATION_MAX_RESPONSE_BYTES=1048576
```

## Kontrakt odpowiedzi (envelope)

Każdy endpoint zwraca:

```json
{
  "schemaVersion": "helpfli-marketing-data-v1",
  "generatedAt": "2026-07-14T10:00:00.000Z",
  "sourceVersion": "helpfli-backend-catalog-v1:…",
  "dataFreshness": {
    "ttlSeconds": 300,
    "expiresAt": "2026-07-14T10:05:00.000Z"
  },
  "data": { }
}
```

## Endpointy

### GET `/catalog`

Aktywny katalog kategorii z `data/categories_pl.json`, wzbogacony metadanymi z kolekcji `Service` (pilność, planowanie, zdalne).

Pola kategorii: `categoryId`, `categoryName`, `subcategories[]`, `active`, `emergencySupported`, `scheduledSupported`, `remoteSupported`, `serviceCount`.

### POST `/demand-summary`

Body (JSON):

```json
{
  "categoryIds": ["hydraulika"],
  "locations": ["warszawa"],
  "dateFrom": "2026-01-01T00:00:00.000Z",
  "dateTo": "2026-02-01T00:00:00.000Z"
}
```

Zwraca wyłącznie agregaty: `orderCount`, `openCount`, `fillRate`, `urgencyDistribution`, `peakPeriods` — z **suppression** gdy grupa &lt; `privacyMinCount` (domyślnie 5).

Źródło: kolekcja `Order` (bez identyfikatorów zleceń/użytkowników).

### POST `/supply-summary`

Analogiczne filtry `categoryIds`, `locations` (bez wymaganego zakresu dat).

Agregaty: `activeContractorCount`, `availableContractorCount` (sygnał `provider_status.isOnline`), `ratingBands`, `avgResponseRatePercent`, `coverageGap`.

Źródło: kolekcja `User` (role=provider), bez identyfikatorów wykonawców.

### GET `/platform-facts`

Fakty z kodu/konfiguracji (`MarketingPlatformFactsService`). Pola: `code`, `statement`, `value`, `verified`, `source`, `updatedAt`.

Niezweryfikowane fakty mają `verified: false` (np. brak gwarancji 24/7).

### GET `/claims`

Jawny rejestr: `data/marketing_claims_registry.json`.

Statusy: `verified` | `unverified` | `forbidden`. Każdy claim: `code`, `statement`, `status`, `evidenceReference`, `allowedAudiences`, `allowedChannels`, opcjonalnie `reason`.

## Prywatność

- Próg suppression: domyślnie **5** rekordów w grupie
- Brak e-maili, telefonów, nazw, adresów, współrzędnych, `userId`/`orderId`/`providerId`
- Lokalizacja maksymalnie: miasto + województwo (z `seoCities`)
- Oceny jako pasma / średnia przy wystarczającej próbce

## Błędy

| Kod HTTP | error | Opis |
|----------|-------|------|
| 401 | unauthorized | Brak tokenu |
| 403 | forbidden | Zły token / IP |
| 400 | invalid_date_range | dateFrom &gt; dateTo |
| 400 | date_range_too_large | &gt; 90 dni (domyślnie) |
| 422 | unsupported_location | Miasto spoza `TOP_PL_CITIES` |
| 422 | unsupported_category | Nieznane categoryIds |
| 429 | rate_limited | Limit ACC |
| 413 | response_too_large | Przekroczony rozmiar odpowiedzi |
| 504 | aggregation_timeout | Timeout agregacji MongoDB |
| 503 | integration_unavailable | Brak tokenu na serwerze |

Format zgodny z resztą API: `{ error, message, details? }` — bez stack trace w produkcji.

## curl (smoke)

```bash
export TOKEN="twoj-ai-command-center-read-token"
export BASE="http://localhost:5000/api/integrations/marketing/v1"

curl -s -H "Authorization: Bearer $TOKEN" "$BASE/health" | jq .
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/catalog" | jq '.schemaVersion, (.data.categories | length)'
curl -s -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"categoryIds":["hydraulika"],"locations":["warszawa"],"dateFrom":"2026-01-01","dateTo":"2026-02-01"}' \
  "$BASE/demand-summary" | jq '.data.aggregates'
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/platform-facts" | jq '.data.verifiedCount'
curl -s -H "Authorization: Bearer $TOKEN" "$BASE/claims" | jq '.data.counts'
```

## Deployment (VPS / Docker)

1. **Env:** ustaw `AI_COMMAND_CENTER_READ_TOKEN` (openssl rand -hex 32).
2. **Indeksy:** istniejące indeksy `Order`/`User` wystarczają na start (`scripts/add_indexes_optimization.js` opcjonalnie).
3. **Build:** `docker build -t helpfli-backend ./backend`
4. **Restart:** `docker compose up -d backend` (lub restart kontenera Node).
5. **Health:** `GET /api/integrations/marketing/v1/health` + smoke curl powyżej.
6. **Rollback:** przywróć poprzedni obraz / usuń mount route — endpointy są izolowane, brak migracji DB.

## Konfiguracja AI Command Center (po deploy)

```env
HELPFLI_DATA_MODE=real
HELPFLI_API_BASE_URL=https://twoj-backend.helpfli.pl/api/integrations/marketing/v1
HELPFLI_READ_API_TOKEN=<ten sam co AI_COMMAND_CENTER_READ_TOKEN>
```

Uwaga: jeśli ACC nie obsługuje sufiksu `/v1`, zaktualizuj `RealHelpfliReadClient` przed smoke testem kampanii.

## Pliki implementacji

- `routes/integrationsMarketing.js`
- `middleware/aiCommandCenterAuth.js`
- `middleware/marketingIntegrationRateLimiter.js`
- `services/MarketingReadService.js`
- `services/MarketingPlatformFactsService.js`
- `data/marketing_claims_registry.json`
- `config/marketingIntegration.js`
- `utils/marketingResponseEnvelope.js`
- `__tests__/integrations/marketingReadApi.test.js`
