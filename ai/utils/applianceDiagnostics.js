const APPLIANCE_PATTERNS = [
  { key: 'washing_machine', label: 'pralka', genitive: 'pralki', pattern: /(pralk|washing machine)/i },
  { key: 'dishwasher', label: 'zmywarka', genitive: 'zmywarki', pattern: /(zmywark|dishwasher)/i },
  { key: 'fridge', label: 'lodówka', genitive: 'lodówki', pattern: /(lod[oó]wk|chłodziark|zamra[zż]ark|fridge|refrigerator)/i },
  { key: 'oven', label: 'piekarnik', genitive: 'piekarnika', pattern: /(piekarnik|kuchenk|oven)/i },
  { key: 'tv', label: 'telewizor', genitive: 'telewizora', pattern: /(\btv\b|telewizor|smart tv)/i }
];

const ERROR_CODES = {
  washing_machine: {
    e10: {
      meaning: 'problem z dopływem wody',
      checks: ['Sprawdź, czy zawór wody jest odkręcony.', 'Sprawdź, czy wąż dopływowy nie jest zagięty.', 'Oczyść sitko na wejściu wody, jeśli masz do niego łatwy dostęp.']
    },
    e20: {
      meaning: 'problem z odpompowaniem wody',
      checks: ['Wyłącz pralkę z prądu.', 'Sprawdź filtr pompy odpływowej.', 'Sprawdź, czy wąż odpływowy nie jest zagięty lub zatkany.']
    },
    e30: {
      meaning: 'problem z układem wody, wyciekiem albo czujnikiem poziomu wody (zależy od marki)',
      checks: ['Odłącz pralkę od prądu i zakręć dopływ wody.', 'Sprawdź, czy pod pralką nie ma wody.', 'Sprawdź filtr oraz wąż odpływowy.', 'Zapisz markę i model pralki, bo znaczenie E30 różni się między producentami.']
    },
    f05: {
      meaning: 'najczęściej problem z odpompowaniem wody',
      checks: ['Wyłącz pralkę z prądu.', 'Wyczyść filtr pompy.', 'Sprawdź drożność odpływu i węża odpływowego.']
    }
  },
  dishwasher: {
    e15: {
      meaning: 'wykryty wyciek lub aktywny system AquaStop',
      checks: ['Odłącz zmywarkę od prądu.', 'Zakręć dopływ wody.', 'Sprawdź, czy pod zmywarką lub w podstawie nie ma wody.']
    },
    e24: {
      meaning: 'problem z odpływem wody',
      checks: ['Wyczyść filtr zmywarki.', 'Sprawdź wąż odpływowy.', 'Sprawdź, czy odpływ w zlewie nie jest zatkany.']
    }
  },
  fridge: {},
  oven: {},
  tv: {}
};

function detectApplianceIssue(text = '') {
  const raw = String(text || '');
  const lower = raw.toLowerCase();
  const appliance = APPLIANCE_PATTERNS.find((item) => item.pattern.test(lower));
  const codeMatch = lower.match(/\b([ef][0-9]{1,3}|[a-z]{1,2}[0-9]{1,3})\b/i);

  if (!appliance && !/(agd|rtv|urządzen|urzadzen|sprzęt|sprzet)/i.test(lower)) {
    return null;
  }

  const code = codeMatch ? codeMatch[1].toLowerCase() : null;
  const knownCode = appliance && code ? ERROR_CODES[appliance.key]?.[code] : null;
  const hasWaterRisk = /(woda|zalewa|wyciek|ciekn|mokro|pod pralk|pod zmywark)/i.test(lower) || ['e30', 'e15'].includes(code);
  const hasElectricRisk = /(iskr|dym|spalen|bezpiecznik|kopie|pora[zż]enie)/i.test(lower);
  const safetyFlag = hasElectricRisk || /(gaz|ogień|plomien|płomień)/i.test(lower);

  const label = appliance?.label || 'urządzenie AGD/RTV';
  const genitiveLabel = appliance?.genitive || 'urządzenia AGD/RTV';
  const details = [
    `${label}${code ? `, kod błędu ${code.toUpperCase()}` : ''}`,
    knownCode?.meaning
  ].filter(Boolean);

  const questions = [];
  if (!/(bosch|siemens|electrolux|whirlpool|beko|samsung|lg|amica|indesit|aeg)/i.test(lower)) {
    questions.push(`Jaka to marka i model ${genitiveLabel}?`);
  }
  if (hasWaterRisk) {
    questions.push('Czy pod urządzeniem widać wodę albo wilgoć?');
  }
  questions.push('W jakim mieście potrzebujesz pomocy?');

  const checks = knownCode?.checks || [
    'Odłącz urządzenie od prądu na kilka minut.',
    'Sprawdź oczywiste przyczyny: zasilanie, węże, filtr i komunikat na ekranie.',
    'Zrób zdjęcie kodu błędu oraz tabliczki znamionowej z modelem.'
  ];

  const reply = knownCode
    ? `Kod ${code.toUpperCase()} przy urządzeniu typu ${label} oznacza zwykle: ${knownCode.meaning}. Na początek: ${checks.slice(0, 2).join(' ')} Jeśli problem wraca albo widzisz wodę, lepiej zamówić serwis AGD.`
    : `Wygląda to na problem z ${label}. Najbardziej pomoże marka, model i zdjęcie komunikatu błędu. Możesz też sprawdzić podstawy: zasilanie, filtr, wąż odpływowy/dopływowy i czy nie ma wycieku.`;

  return {
    service: 'agd-rtv-naprawa-agd',
    parentService: 'agd-rtv',
    appliance: label,
    code: code ? code.toUpperCase() : null,
    knownCode: !!knownCode,
    urgency: safetyFlag || hasWaterRisk ? 'urgent' : 'standard',
    nextStep: safetyFlag ? 'suggest_providers' : 'suggest_diy',
    confidence: appliance ? 0.92 : 0.75,
    reply,
    checks,
    questions: questions.slice(0, 4),
    details,
    safety: {
      flag: safetyFlag,
      reason: safetyFlag ? 'Możliwe zagrożenie elektryczne lub pożarowe' : null,
      recommendation: safetyFlag ? 'Odłącz urządzenie od prądu i skontaktuj się z fachowcem.' : null
    }
  };
}

module.exports = {
  detectApplianceIssue
};
