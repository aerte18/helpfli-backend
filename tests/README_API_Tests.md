?# Helpfli API Tests - Postman Collection

## 📋 Opis

Kompletna kolekcja testów Postman/Thunder Client dla wszystkich endpointów API Helpfli, w tym nowych funkcjonalności:
- AI Claude Integration
- Web Search Tools
- Push Notifications
- Knowledge Base Manager

## 🚀 Instalacja i konfiguracja

### 1. Import kolekcji

**Postman:**
1. Otwórz Postman
2. Kliknij "Import"
3. Wybierz plik `Helpfli_API_Tests.postman_collection.json`
4. Kliknij "Import"

**Thunder Client (VS Code):**
1. Otwórz VS Code
2. Zainstaluj rozszerzenie "Thunder Client"
3. Kliknij ikonę Thunder Client w sidebar
4. Kliknij "Import" → "From File"
5. Wybierz plik `Helpfli_API_Tests.postman_collection.json`

### 2. Konfiguracja zmiennych

Kolekcja używa następujących zmiennych:

| Zmienna | Domyślna wartość | Opis |
|---------|------------------|------|
| `base_url` | `http://localhost:5000` | URL serwera API |
| `auth_token` | (pusty) | Token autoryzacji (ustawiany automatycznie) |
| `user_id` | (pusty) | ID użytkownika (ustawiany automatycznie) |
| `article_id` | (pusty) | ID artykułu KB (ustawiany automatycznie) |

### 3. Uruchomienie serwera

```bash
# Uruchom backend
cd backend
npm run dev

# Lub z Docker
docker-compose -f docker-compose.dev.yml up backend
```

## 🧪 Struktura testów

### 1. Authentication
- **Login** - Logowanie użytkownika (automatycznie ustawia token)
- **Get Current User** - Pobieranie danych bieżącego użytkownika

### 2. AI Claude Integration
- **Claude Status** - Status integracji z Claude 3.5
- **Test Claude Connection** - Test połączenia z Claude API
- **Claude Analyze Problem** - Analiza problemu przez Claude
- **Compare Claude vs Ollama** - Porównanie wyników Claude i Ollama
- **Configure LLM Provider** - Konfiguracja dostawcy LLM

### 3. Web Search Tools
- **Web Search Status** - Status dostawców wyszukiwania
- **Test Web Search** - Test wyszukiwania internetowego
- **Search Service Info** - Wyszukiwanie informacji o usługach
- **Compare Search Providers** - Porównanie dostawców wyszukiwania
- **Configure Web Search** - Konfiguracja wyszukiwania

### 4. Push Notifications
- **Get Push Config** - Konfiguracja push notifications
- **Subscribe to Push** - Subskrypcja powiadomień
- **Test Push Notification** - Test wysyłania powiadomienia
- **Admin Broadcast Push** - Broadcast do wszystkich użytkowników
- **Unsubscribe from Push** - Anulowanie subskrypcji

### 5. Knowledge Base Manager
- **Get KB Stats** - Statystyki bazy wiedzy
- **List KB Articles** - Lista artykułów z paginacją
- **Create KB Article** - Tworzenie nowego artykułu
- **Get KB Article by ID** - Pobieranie artykułu po ID
- **Update KB Article** - Aktualizacja artykułu
- **Filter KB Articles** - Filtrowanie artykułów
- **Delete KB Article** - Usuwanie artykułu

### 6. AI Concierge
- **Analyze Problem** - Analiza problemu przez AI Concierge
- **Concierge with Web Search** - Analiza z wyszukiwaniem internetowym

### 7. Public KB Access
- **Search KB Articles** - Wyszukiwanie w bazie wiedzy
- **Get KB Article by Slug** - Pobieranie artykułu po slug
- **List All KB Articles** - Lista wszystkich artykułów

## 🔧 Wymagania środowiskowe

### Zmienne środowiskowe (backend/.env)

```env
# AI/LLM Configuration
LLM_PROVIDER=auto
LLM_FALLBACK_ENABLED=true
ANTHROPIC_API_KEY=sk-ant-your-key-here

# Web Search Configuration
WEB_SEARCH_PROVIDER=bing
WEB_SEARCH_FALLBACK_ENABLED=true
BING_API_KEY=your-bing-key
SERPAPI_KEY=your-serpapi-key
PERPLEXITY_API_KEY=your-perplexity-key

# Push Notifications
VAPID_PUBLIC_KEY=your-vapid-public-key
VAPID_PRIVATE_KEY=your-vapid-private-key
VAPID_SUBJECT=mailto:admin@helpfli.app

# Database
MONGO_URI=mongodb://localhost:27017/helpfli

# Redis (optional)
REDIS_URL=redis://localhost:6379
```

### Konta testowe

Domyślne konta testowe:
- **Admin:** `admin@helpfli.local` / `admin123`
- **Provider:** `provider@helpfli.local` / `provider123`
- **Client:** `client@helpfli.local` / `client123`

## 📊 Przykłady użycia

### 1. Testowanie AI Concierge

```bash
# 1. Zaloguj się jako admin
POST /api/auth/login
{
  "email": "admin@helpfli.local",
  "password": "admin123"
}

# 2. Sprawdź status Claude
GET /api/ai/claude/status

# 3. Przetestuj analizę problemu
POST /api/ai/claude/analyze
{
  "description": "Mam problem z zatkanym odpływem w kuchni",
  "lang": "pl"
}
```

### 2. Testowanie Push Notifications

```bash
# 1. Pobierz konfigurację push
GET /api/push/config

# 2. Zasubskrybuj powiadomienia
POST /api/push/subscribe
{
  "subscription": {
    "endpoint": "https://fcm.googleapis.com/fcm/send/...",
    "keys": {
      "p256dh": "...",
      "auth": "..."
    }
  }
}

# 3. Wyślij test push
POST /api/push/test
{
  "title": "Test",
  "body": "To jest test",
  "url": "/dashboard"
}
```

### 3. Testowanie KB Manager

```bash
# 1. Pobierz statystyki
GET /api/kb/stats

# 2. Utwórz nowy artykuł
POST /api/kb/articles
{
  "title": "Jak naprawić zatkany odpływ",
  "content": "Szczegółowy poradnik...",
  "category": "hydraulika",
  "tags": "odpływ, naprawa",
  "isActive": true,
  "priority": 2
}

# 3. Pobierz listę artykułów
GET /api/kb/articles?page=1&limit=10
```

## 🐛 Rozwiązywanie problemów

### Błędy autoryzacji
- Sprawdź czy token jest poprawnie ustawiony
- Upewnij się, że użytkownik ma odpowiednie uprawnienia (admin)

### Błędy Claude API
- Sprawdź czy `ANTHROPIC_API_KEY` jest ustawiony
- Upewnij się, że klucz jest poprawny i ma odpowiednie limity

### Błędy Web Search
- Sprawdź czy klucze API są ustawione (Bing, SerpAPI, Perplexity)
- Upewnij się, że dostawcy są dostępni

### Błędy Push Notifications
- Sprawdź czy VAPID keys są ustawione
- Upewnij się, że Service Worker jest zarejestrowany

## 📈 Monitorowanie

### Logi backend
```bash
# Docker
docker-compose -f docker-compose.dev.yml logs backend --follow

# Bezpośrednio
cd backend && npm run dev
```

### Sprawdzanie statusu
- **Health check:** `GET /health`
- **AI Status:** `GET /api/ai/claude/status`
- **Web Search Status:** `GET /api/ai/web-search/status`
- **KB Stats:** `GET /api/kb/stats`

## 🔄 Automatyzacja

### Uruchamianie wszystkich testów

**Postman:**
1. Otwórz kolekcję
2. Kliknij "Run collection"
3. Wybierz testy do uruchomienia
4. Kliknij "Run"

**Thunder Client:**
1. Otwórz kolekcję
2. Kliknij "Run All"
3. Wybierz testy do uruchomienia

### CI/CD Integration

Kolekcja może być używana w pipeline'ach CI/CD:
- GitHub Actions
- GitLab CI
- Jenkins
- Azure DevOps

## 📝 Dodatkowe informacje

- Wszystkie testy wymagają autoryzacji (oprócz publicznych endpointów KB)
- Token jest automatycznie ustawiany po logowaniu
- Zmienne są automatycznie aktualizowane podczas testów
- Kolekcja zawiera testy walidacji odpowiedzi
- Wszystkie endpointy mają odpowiednie kody błędów

## 🤝 Wsparcie

W przypadku problemów:
1. Sprawdź logi backend
2. Zweryfikuj zmienne środowiskowe
3. Upewnij się, że wszystkie serwisy są uruchomione
4. Sprawdź dokumentację API
