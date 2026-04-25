const SAFETY_RULES = [
  {
    type: 'gas',
    level: 'critical',
    pattern: /(zapach gazu|wyciek gazu|ulatnia.*gaz|gaz.*ulatnia|czujnik gazu|gaz w mieszkaniu)/i,
    title: 'Możliwe zagrożenie gazowe',
    reason: 'Gaz może grozić wybuchem albo zatruciem.',
    actions: [
      'Nie włączaj światła, telefonu przy źródle gazu ani żadnych urządzeń elektrycznych.',
      'Zakręć zawór gazu, jeśli możesz zrobić to bezpiecznie.',
      'Otwórz okna i wyjdź z mieszkania.',
      'Zadzwoń pod 112 albo pogotowie gazowe.'
    ],
    recommendation: 'Nie próbuj naprawiać samodzielnie. Potrzebna jest pilna interwencja.'
  },
  {
    type: 'fire',
    level: 'critical',
    pattern: /(ogień|płonie|plonie|dym|spalenizn|iskry.*dym|czarny dym)/i,
    title: 'Możliwe zagrożenie pożarowe',
    reason: 'Dym, ogień albo zapach spalenizny mogą oznaczać realne zagrożenie.',
    actions: [
      'Jeśli jest ogień lub dużo dymu, wyjdź z mieszkania.',
      'Zadzwoń pod 112.',
      'Nie dotykaj instalacji ani urządzeń pod napięciem.',
      'Jeśli jest bezpiecznie, odłącz zasilanie głównym bezpiecznikiem.'
    ],
    recommendation: 'Nie wykonuj DIY. Najpierw bezpieczeństwo, potem fachowiec.'
  },
  {
    type: 'electricity',
    level: 'high',
    pattern: /(iskrzy|zwarcie|kopie prąd|kopie prad|porażenie|porazenie|bezpiecznik.*wybija|wywala korki|dym z gniazdka|gniazdko.*gorące|gniazdko.*gorace)/i,
    title: 'Ryzyko elektryczne',
    reason: 'Opis wskazuje na możliwość zwarcia, porażenia albo przegrzania instalacji.',
    actions: [
      'Wyłącz zasilanie w danym obwodzie albo główny bezpiecznik.',
      'Nie dotykaj mokrych lub iskrzących elementów.',
      'Odsuń dzieci i zwierzęta od miejsca awarii.',
      'Zamów elektryka z pilnym terminem.'
    ],
    recommendation: 'Nie proponuję samodzielnej naprawy przy ryzyku prądu.'
  },
  {
    type: 'flooding',
    level: 'high',
    pattern: /(zalewa|zalanie|woda.*leci|woda.*wszędzie|pękła rura|pekla rura|duży wyciek|duzy wyciek|cieknie mocno)/i,
    title: 'Ryzyko zalania',
    reason: 'Wyciek może szybko zwiększyć szkody i koszt naprawy.',
    actions: [
      'Zakręć główny zawór wody.',
      'Odłącz prąd w zalewanym pomieszczeniu, jeśli możesz zrobić to bezpiecznie.',
      'Zabezpiecz podłogę i wynieś rzeczy z miejsca zalania.',
      'Zamów pilną pomoc hydraulika lub serwisu AGD.'
    ],
    recommendation: 'Najpierw ogranicz szkody, potem wezwij fachowca.'
  },
  {
    type: 'heating',
    level: 'medium',
    pattern: /(brak ogrzewania|nie ma ogrzewania|piec nie działa|piec nie dziala|kocioł nie działa|kociol nie dziala|brak ciepłej wody|brak cieplej wody)/i,
    title: 'Awaria ogrzewania lub ciepłej wody',
    reason: 'To może wymagać szybkiej wizyty, szczególnie zimą albo przy dzieciach/seniorach.',
    actions: [
      'Nie rozkręcaj kotła ani instalacji gazowej.',
      'Sprawdź tylko podstawy: zasilanie, ciśnienie na manometrze i komunikat błędu.',
      'Zapisz kod błędu i model urządzenia.',
      'Umów serwisanta możliwie szybko.'
    ],
    recommendation: 'Możesz sprawdzić podstawy, ale naprawę zostaw serwisowi.'
  }
];

function detectSafetyTriage(text = '') {
  const raw = String(text || '');
  const matches = SAFETY_RULES.filter((rule) => rule.pattern.test(raw));
  if (matches.length === 0) {
    return {
      flag: false,
      level: 'none',
      type: null,
      title: null,
      reason: null,
      recommendation: null,
      actions: [],
      blockDIY: false
    };
  }

  const ordered = matches.sort((a, b) => severityScore(b.level) - severityScore(a.level));
  const primary = ordered[0];
  const actions = Array.from(new Set(ordered.flatMap((rule) => rule.actions))).slice(0, 5);

  return {
    flag: true,
    level: primary.level,
    type: primary.type,
    title: primary.title,
    reason: primary.reason,
    recommendation: primary.recommendation,
    actions,
    blockDIY: ['critical', 'high'].includes(primary.level),
    detectedTypes: ordered.map((rule) => rule.type)
  };
}

function applySafetyTriage(response = {}, text = '') {
  const triage = detectSafetyTriage(text);
  if (!triage.flag) return response;

  return {
    ...response,
    urgency: ['critical', 'high'].includes(triage.level) ? 'urgent' : response.urgency || 'standard',
    nextStep: triage.blockDIY ? 'suggest_providers' : response.nextStep,
    safety: {
      ...(response.safety || {}),
      ...triage
    }
  };
}

function severityScore(level) {
  return {
    none: 0,
    medium: 1,
    high: 2,
    critical: 3
  }[level] || 0;
}

module.exports = {
  detectSafetyTriage,
  applySafetyTriage
};
