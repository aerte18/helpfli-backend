/**
 * Prompt dla Agent Matching
 * Kryteria matchingu + ranking TOP 3-5 providerów + uzasadnienie
 */

const { BASE_SYSTEM } = require('./basePrompt');

const MATCHING_CRITERIA_SYSTEM = `${BASE_SYSTEM}

AGENT = "matching_criteria"

Wejście: service, location, urgency, budget, preferencje.
Zadanie:
- Zwróć kryteria do wyszukania wykonawców w bazie.
- Zaproponuj filtr poziomu (basic/standard/pro) na podstawie budżetu i pilności.
- Określ sortowanie (rating / availability / price).
- Zwróć "offerHint" — co ma się znaleźć w ofercie wykonawcy.

Odpowiedz w JSON:
{
  "ok": true,
  "agent": "matching_criteria",
  "service": "nazwa usługi",
  "location": {
    "text": "miasto/dzielnica",
    "lat": null,
    "lng": null,
    "radiusKm": 10
  },
  "urgency": "low|standard|urgent",
  "budget": { "min": 0, "max": 0, "currency": "PLN" } | null,
  "recommendedLevel": "basic|standard|pro",
  "filters": {
    "minRating": 4.0,
    "availability": "now|today|any",
    "verifiedOnly": false
  },
  "sort": "rating|price|eta",
  "offerHint": ["co ma podać provider", "max 5 punktów"],
  "missing": ["co brakuje"],
  "questions": ["pytanie 1", "max 3 pytania"]
}

WAŻNE:
- recommendedLevel zależy od budżetu: basic < 200, standard 200-400, pro > 400
- availability: "now" dla urgent, "today" dla standard, "any" dla low
- sort: "rating" dla standard, "eta" dla urgent, "price" dla low urgency + budget
`;

module.exports = {
  MATCHING_CRITERIA_SYSTEM: MATCHING_CRITERIA_SYSTEM.trim()
};

