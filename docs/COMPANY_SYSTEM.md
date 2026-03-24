?# System Zarządzania Firmami - Helpfli

## 📋 Przegląd

System zarządzania firmami pozwala firmom na zarządzanie wieloma wykonawcami pod jedną marką. Właściciele firm mogą zapraszać wykonawców, zarządzać ich rolami i monitorować statystyki zespołu.

## 🏗️ Architektura

### Modele danych

#### Company (Firma)
- **Podstawowe dane**: nazwa, NIP, REGON, KRS
- **Kontakt**: email, telefon, strona internetowa
- **Adres**: pełny adres firmy
- **Zespół**: właściciel, managerzy, wykonawcy
- **Status**: pending, active, suspended, rejected
- **Ustawienia**: konfiguracja zarządzania zespołem
- **Statystyki**: zlecenia, przychody, oceny

#### User (rozszerzony)
- **Nowe role**: `company_owner`, `company_manager`
- **Pola firmowe**: `company`, `roleInCompany`, `companyInvitation`
- **Metody**: `isCompanyOwner()`, `canManageCompany()`, `acceptCompanyInvitation()`

### Role i uprawnienia

#### Właściciel firmy (`company_owner`)
- ✅ Pełne zarządzanie firmą
- ✅ Dodawanie/usuwanie członków
- ✅ Zmiana ról członków
- ✅ Edycja ustawień firmy
- ✅ Usuwanie firmy

#### Manager firmy (`company_manager`)
- ✅ Zarządzanie wykonawcami
- ✅ Zapraszanie nowych członków
- ✅ Zmiana ról wykonawców
- ❌ Usuwanie firmy
- ❌ Zmiana właściciela

#### Wykonawca w firmie (`provider` w firmie)
- ✅ Dostęp do danych firmy
- ✅ Wykonywanie zleceń pod marką firmy
- ❌ Zarządzanie zespołem

## 🔌 API Endpoints

### Zarządzanie firmami

#### `GET /api/companies`
Lista firm użytkownika
```json
{
  "success": true,
  "companies": [
    {
      "_id": "...",
      "name": "Nazwa firmy",
      "nip": "1234567890",
      "verified": true,
      "teamSize": 5,
      "userRole": "owner"
    }
  ]
}
```

#### `POST /api/companies`
Utwórz nową firmę
```json
{
  "name": "Nazwa firmy",
  "nip": "1234567890",
  "email": "firma@example.com",
  "address": {
    "street": "ul. Przykładowa 123",
    "city": "Warszawa",
    "postalCode": "00-000",
    "country": "Polska"
  }
}
```

#### `GET /api/companies/:companyId`
Szczegóły firmy z pełnym zespołem

#### `PUT /api/companies/:companyId`
Aktualizuj dane firmy

### Zarządzanie zespołem

#### `POST /api/companies/:companyId/invite`
Zaproś użytkownika do firmy
```json
{
  "email": "user@example.com",
  "role": "provider"
}
```

#### `POST /api/companies/:companyId/accept-invitation`
Zaakceptuj zaproszenie do firmy

#### `DELETE /api/companies/:companyId/members/:userId`
Usuń członka z firmy

#### `PUT /api/companies/:companyId/members/:userId/role`
Zmień rolę członka
```json
{
  "role": "manager"
}
```

## 🛡️ Middleware

### `requireCompanyAccess`
Sprawdza dostęp do konkretnej firmy

### `requireCompanyManagement`
Wymaga uprawnień do zarządzania firmą

### `requireCompanyOwner`
Tylko dla właścicieli firm

### `requireInvitePermission`
Uprawnienia do zapraszania

### `checkCompanyLimits`
Sprawdza limity liczby członków

## 🎨 Frontend

### Komponenty

#### `CompanyDashboard`
- Przegląd firmy i statystyk
- Lista członków zespołu
- Zarządzanie rolami
- Zapraszanie nowych członków

#### `CreateCompany`
- Formularz tworzenia firmy
- Walidacja danych
- Podstawowe dane i kontakt

#### `CompanySettings`
- Edycja danych firmy
- Ustawienia zespołu
- Konfiguracja uprawnień

### Routing

```
/company/dashboard          - Panel zarządzania firmą
/company/create            - Utwórz nową firmę
/company/:id/settings      - Ustawienia firmy
```

## 🔄 Migracja

### Skrypt migracyjny
```bash
node backend/scripts/migrateToCompanySystem.js
```

Skrypt automatycznie:
1. Znajdzie wszystkich providerów z flagą `isB2B: true`
2. Utworzy dla nich firmy
3. Zaktualizuje role na `company_owner`
4. Przypisze do odpowiednich firm

## 📊 Statystyki

### Metryki firmy
- **Zlecenia**: łączna liczba, zakończone, w toku
- **Przychody**: całkowite, średnie, miesięczne
- **Oceny**: średnia ocena, liczba recenzji
- **Zespół**: liczba członków, aktywni wykonawcy

### Raporty
- Miesięczne raporty działalności
- Analiza wydajności zespołu
- Porównanie z poprzednimi okresami

## 🔒 Bezpieczeństwo

### Walidacja
- Sprawdzanie NIP w bazie REGON
- Weryfikacja dokumentów firmowych
- Kontrola uprawnień na każdym poziomie

### Ograniczenia
- Limit członków zespołu (domyślnie 50)
- Wymagana weryfikacja przed pełnym dostępem
- Kontrola dostępu do wrażliwych danych

## 🚀 Przyszłe rozszerzenia

### Planowane funkcje
- [ ] Integracja z systemami księgowymi
- [ ] Automatyczne faktury firmowe
- [ ] Dashboard analityczny
- [ ] Integracja z CRM
- [ ] Mobilna aplikacja dla managerów
- [ ] System powiadomień push
- [ ] Eksport raportów do PDF/Excel

### Integracje
- [ ] API do systemów HR
- [ ] Połączenie z bankowością
- [ ] Integracja z systemami płatności
- [ ] Połączenie z platformami księgowymi

## 🐛 Rozwiązywanie problemów

### Częste problemy

#### "Brak uprawnień do firmy"
- Sprawdź czy użytkownik należy do firmy
- Zweryfikuj rolę w firmie
- Sprawdź czy firma jest aktywna

#### "Firma nie została znaleziona"
- Sprawdź poprawność ID firmy
- Zweryfikuj czy firma nie została usunięta
- Sprawdź uprawnienia użytkownika

#### "Limit członków osiągnięty"
- Zwiększ limit w ustawieniach firmy
- Usuń nieaktywnych członków
- Rozważ upgrade subskrypcji

### Logi
Wszystkie operacje firmowe są logowane z poziomem `info`:
```
[Company] User {userId} created company {companyId}
[Company] User {userId} invited {email} to company {companyId}
[Company] User {userId} changed role of {targetUserId} to {role}
```

## 📞 Wsparcie

W przypadku problemów z systemem firmowym:
1. Sprawdź logi aplikacji
2. Zweryfikuj uprawnienia użytkownika
3. Sprawdź status firmy w bazie danych
4. Skontaktuj się z administratorem systemu











