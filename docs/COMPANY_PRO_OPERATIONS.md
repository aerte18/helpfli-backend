# Company PRO - Operations Note

Ten dokument opisuje szybkie utrzymanie funkcji Company PRO:
- polityka zakupowa,
- SLA v2,
- auto follow-up (manual + cron),
- metryki w Admin Analytics.

## 1) Wymagane ENV

Podstawowe:

- `ENABLE_JOBS=1`  
  Włącza harmonogram jobów po stronie backendu.

Auto follow-up cron:

- `COMPANY_PRO_AUTOFOLLOWUP_CRON`  
  Cron spec, domyślnie: `*/30 * * * *` (co 30 minut).
- `COMPANY_PRO_AUTOFOLLOWUP_MAX_COMPANIES`  
  Limit firm skanowanych w jednym runie (domyślnie `50`).
- `COMPANY_PRO_AUTOFOLLOWUP_MAX_ORDERS_PER_COMPANY`  
  Limit zleceń na firmę w jednym runie (domyślnie `20`).
- `COMPANY_PRO_AUTOFOLLOWUP_LOOKBACK_DAYS`  
  Jak stare zlecenia skanować (domyślnie `7` dni).
- `COMPANY_PRO_AUTOFOLLOWUP_HEALTH_STALE_MINUTES`  
  Po ilu minutach bez zakończonego runu health uznaje cron za stale (domyślnie `90`).

## 2) Kluczowe endpointy (admin i firma)

Firma:

- `GET /api/companies/:companyId/procurement-policy`
- `PATCH /api/companies/:companyId/procurement-policy`
- `GET /api/companies/:companyId/orders/:orderId/shortlist`
- `GET /api/companies/:companyId/orders/:orderId/sla-status`
- `POST /api/companies/:companyId/orders/:orderId/followup`
- `POST /api/companies/:companyId/orders/:orderId/followup/auto-check`

Admin:

- `GET /api/admin/analytics/ai-insights`
- `GET /api/admin/analytics/company-pro-cron-health`

## 3) Sygnały telemetryczne Company PRO

- `company_ai_shortlist_generated`
- `company_ai_followup_sent`
- `company_ai_auto_followup_sent`
- `company_ai_auto_followup_cron_run`
- `company_ai_sla_breach_detected`

## 4) Jak czytać metryki PRO (Admin Analytics)

Sekcja "Firma PRO: shortlist, follow-up i SLA":

- `Shortlist wygenerowane` - ile razy uruchomiono shortlistę.
- `Follow-up wysłane` - manualny follow-up.
- `Auto follow-up wysłane` - follow-up wysłany automatycznie.
- `Auto follow-up cron runs` - liczba zakończonych przebiegów cron.
- `SLA breach` + rozbicia:
  - `brak 1. oferty`,
  - `brak 1. kwalifikowanej`.

Skuteczność auto-follow-up:

- `Auto FU: śledzone ordery` - liczba zleceń, gdzie mierzymy efekt.
- `sukces <=12h / <=24h / <=48h` - zlecenia, gdzie po auto-follow-up pojawiła się oferta z `aiQuality >= 45` w danym oknie.
- `success rate` - udział sukcesów względem śledzonych orderów.

Porównanie PRO vs non-PRO:

- `offer coverage`,
- `acceptance rate`,
- `avg 1st offer (h)`,
- oraz delty (PRO - non-PRO).

## 5) Cron health - szybka checklista

Endpoint: `GET /api/admin/analytics/company-pro-cron-health`

Sprawdź:

- `health.lastStatus` powinien być zwykle `ok` lub chwilowo `running`.
- `stale` powinno być `false`.
- `health.lastRunFinishedAt` powinno być świeże względem ustawionego progu.
- `health.lastError` nie powinno być ustawione.

Jeśli `stale=true`:

1. sprawdź `ENABLE_JOBS`,
2. sprawdź cron spec i logi backendu,
3. sprawdź połączenie DB i dostępność modeli/eventów.

## 6) Najczęstsze problemy

- Brak efektu auto-follow-up mimo runów cron:
  - polityka ma `autoFollowupEnabled=false`,
  - firma nie spełnia warunków PRO,
  - działa limit dzienny `maxAutoFollowupsPerDay`,
  - cooldown 12h blokuje kolejne notyfikacje.

- SLA breach jest wykrywany, ale nie ma follow-up:
  - brak ofert/prowadzących do powiadomienia,
  - wszystkie możliwe follow-upy są w cooldownie,
  - limit dzienny został wyczerpany.

## 7) Minimalna checklist before release

- [ ] `ENABLE_JOBS=1` na środowisku runtime backendu
- [ ] cron health endpoint zwraca `stale=false`
- [ ] w Admin Analytics widać `cron runs > 0`
- [ ] rośnie licznik `company_ai_auto_followup_sent`
- [ ] polityka PRO ma poprawne progi SLA (`slaFirstOfferHours`, `slaThresholdHours`)

