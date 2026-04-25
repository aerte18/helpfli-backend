function buildOrderFollowup(order, viewerRole = 'client') {
  if (!order) return null;

  const status = order.status || 'open';
  const offersCount = Array.isArray(order.offers) ? order.offers.length : 0;
  const ageHours = order.createdAt ? Math.max(0, (Date.now() - new Date(order.createdAt).getTime()) / 36e5) : 0;
  const hasAttachments = Array.isArray(order.attachments) && order.attachments.length > 0;
  const aiBrief = order.aiBrief || null;
  const missingForPro = aiBrief?.quality?.missingForPro || [];
  const suggestedAttachments = aiBrief?.suggestedAttachments || [];

  if (viewerRole === 'provider') {
    return providerFollowup(order, { status, offersCount, aiBrief });
  }

  if ((status === 'open' || status === 'collecting_offers') && offersCount === 0) {
    if (!hasAttachments && suggestedAttachments.length > 0) {
      return action({
        priority: 'high',
        title: 'Zwiększ szansę na szybkie oferty',
        tip: `Dodaj zdjęcia: ${suggestedAttachments.slice(0, 2).join(', ')}. Wykonawcy szybciej wycenią zlecenie.`,
        cta: 'Dodaj zdjęcia',
        seedQuery: 'Jakie zdjęcia powinienem dodać do tego zlecenia?',
        actionType: 'add_attachments'
      });
    }
    if (ageHours >= 2) {
      return action({
        priority: 'medium',
        title: 'Brak ofert od kilku godzin',
        tip: 'Doprecyzuj opis, dodaj zdjęcia albo wydłuż/podbij zlecenie, żeby trafiło do większej liczby wykonawców.',
        cta: 'Popraw zlecenie z AI',
        seedQuery: 'Pomóż mi poprawić zlecenie, żeby dostać więcej ofert.',
        actionType: 'improve_order'
      });
    }
    return action({
      priority: 'low',
      title: 'AI pilnuje zlecenia',
      tip: 'Zlecenie jest aktywne. Jeśli chcesz przyspieszyć oferty, dodaj zdjęcie lub konkretny termin.',
      cta: 'Zapytaj AI',
      seedQuery: 'Co mogę zrobić, żeby szybciej dostać oferty?',
      actionType: 'ask_ai'
    });
  }

  if ((status === 'open' || status === 'collecting_offers') && offersCount > 0) {
    return action({
      priority: 'high',
      title: `Masz ${offersCount} ${offersCount === 1 ? 'ofertę' : offersCount < 5 ? 'oferty' : 'ofert'}`,
      tip: 'AI może porównać cenę, jakość, termin i dopasowanie wykonawców, żeby pomóc wybrać najlepszą ofertę.',
      cta: 'Porównaj oferty z AI',
      seedQuery: 'Porównaj moje oferty i wskaż najlepszy wybór.',
      actionType: 'compare_offers'
    });
  }

  if (status === 'accepted' || status === 'awaiting_payment') {
    return action({
      priority: 'high',
      title: 'Oferta zaakceptowana',
      tip: order.paymentPreference === 'external'
        ? 'Ustal szczegóły płatności i termin w czacie z wykonawcą.'
        : 'Opłać zlecenie w systemie, żeby uruchomić Helpfli Protect i zabezpieczyć środki.',
      cta: order.paymentPreference === 'external' ? 'Zapytaj o termin' : 'Zapytaj o płatność',
      seedQuery: 'Co powinienem zrobić po zaakceptowaniu oferty?',
      actionType: 'payment_or_schedule'
    });
  }

  if (status === 'funded' || status === 'paid') {
    return action({
      priority: 'medium',
      title: 'Środki zabezpieczone',
      tip: 'Umów konkretny termin realizacji i potwierdź, czy wykonawca ma wszystkie dane.',
      cta: 'Przygotuj wiadomość',
      seedQuery: 'Przygotuj krótką wiadomość do wykonawcy z ustaleniem terminu.',
      actionType: 'schedule_work'
    });
  }

  if (status === 'in_progress') {
    return action({
      priority: 'medium',
      title: 'Zlecenie w realizacji',
      tip: 'Jeśli zakres się zmienił, poproś o zmianę zakresu lub dopłatę przed zakończeniem pracy.',
      cta: 'Zapytaj AI',
      seedQuery: 'Jak opisać zmianę zakresu zlecenia?',
      actionType: 'scope_change'
    });
  }

  if (status === 'completed') {
    return action({
      priority: 'high',
      title: 'Potwierdź odbiór',
      tip: 'Sprawdź efekt pracy. Jeśli wszystko jest OK, potwierdź odbiór i wystaw ocenę.',
      cta: 'Zapytaj o odbiór',
      seedQuery: 'Na co zwrócić uwagę przed potwierdzeniem odbioru zlecenia?',
      actionType: 'confirm_receipt'
    });
  }

  if (status === 'released' || status === 'rated') {
    return action({
      priority: 'low',
      title: 'Zlecenie zakończone',
      tip: followupServiceTip(order.service),
      cta: 'Zaplanuj kolejne',
      seedQuery: 'Jakie prace warto zaplanować po takim zleceniu?',
      actionType: 'retention'
    });
  }

  if (missingForPro.length > 0) {
    return action({
      priority: 'low',
      title: 'Ulepsz opis zlecenia',
      tip: `Do lepszych ofert brakuje: ${missingForPro.slice(0, 3).join(', ')}.`,
      cta: 'Ulepsz z AI',
      seedQuery: 'Pomóż mi uzupełnić brakujące dane w zleceniu.',
      actionType: 'improve_order'
    });
  }

  return null;
}

function buildProviderOrderMatch(order, provider = {}) {
  if (!order) return null;
  const service = normalize(order.service || order.serviceDetails || '');
  const providerServiceText = [
    provider.service,
    ...(Array.isArray(provider.services) ? provider.services.map((s) => `${s.slug || ''} ${s.parent_slug || ''} ${s.name_pl || ''} ${s.name || ''}`) : [])
  ].join(' ');
  const providerServices = normalize(providerServiceText);
  const sameService = service && providerServices && (providerServices.includes(service) || service.includes(providerServices));

  let score = 48;
  const reasons = [];

  if (sameService) {
    score += 25;
    reasons.push('Usługa pasuje do Twojej specjalizacji');
  } else if (service && providerServices && service.split(/\s+/).some((word) => word.length > 3 && providerServices.includes(word))) {
    score += 14;
    reasons.push('Zakres jest zbliżony do Twoich usług');
  }

  if (order.aiBrief?.quality?.percent >= 70 || order.aiBrief?.quality?.level === 'pro') {
    score += 10;
    reasons.push('Opis jest dobrze przygotowany przez AI');
  } else if (order.aiBrief?.title) {
    score += 6;
    reasons.push('AI brief podsumowuje najważniejsze informacje');
  }

  if (Array.isArray(order.attachments) && order.attachments.length > 0) {
    score += 7;
    reasons.push('Są załączniki do szybkiej wyceny');
  }
  if (order.budget || order.budgetRange?.max) {
    score += 5;
    reasons.push('Klient podał budżet');
  }
  if (provider.location && order.location && normalize(JSON.stringify(order.location)).includes(normalize(provider.location))) {
    score += 5;
    reasons.push('Lokalizacja wygląda zgodnie z Twoim obszarem');
  }
  if (Number(provider.ratingAvg) >= 4.5) {
    score += 4;
    reasons.push('Twoja wysoka ocena zwiększa szansę wygranej');
  }
  if (Number(provider.successRate) >= 40) {
    score += 3;
    reasons.push('Masz dobrą skuteczność ofert');
  }

  const percent = Math.max(35, Math.min(98, Math.round(score)));
  return {
    score: percent,
    label: percent >= 82 ? 'Bardzo dobre zlecenie dla Ciebie' : percent >= 68 ? 'Dobre dopasowanie' : 'Warto sprawdzić',
    reasons: reasons.length ? reasons.slice(0, 4) : ['AI ocenia potencjał na podstawie opisu, budżetu i danych zlecenia'],
    highlights: {
      serviceMatch: Boolean(sameService),
      hasBrief: Boolean(order.aiBrief?.title),
      hasAttachments: Array.isArray(order.attachments) && order.attachments.length > 0
    }
  };
}

function providerFollowup(order, context) {
  if (['open', 'collecting_offers'].includes(context.status)) {
    return action({
      priority: 'medium',
      title: 'AI brief pomaga wycenić szybciej',
      tip: order.aiBrief?.title
        ? `Najważniejsze: ${order.aiBrief.title}. Sprawdź pytania pomocnicze przed ofertą.`
        : 'Przeczytaj opis, sprawdź załączniki i złóż konkretną ofertę z terminem.',
      cta: 'Przygotuj ofertę z AI',
      seedQuery: 'Pomóż mi przygotować dobrą ofertę do tego zlecenia.',
      actionType: 'provider_offer'
    });
  }
  if (context.status === 'accepted' || context.status === 'funded' || context.status === 'paid') {
    return action({
      priority: 'medium',
      title: 'Ustal termin i zakres',
      tip: 'Napisz do klienta krótko: termin, zakres pracy, co ma przygotować i czy potrzebujesz zdjęć.',
      cta: 'Przygotuj wiadomość',
      seedQuery: 'Przygotuj wiadomość do klienta po zaakceptowaniu oferty.',
      actionType: 'provider_schedule'
    });
  }
  return null;
}

function followupServiceTip(service = '') {
  const s = String(service).toLowerCase();
  if (s.includes('hydraul')) return 'Warto zaplanować kontrolę instalacji wodnej za kilka miesięcy, żeby uniknąć kolejnych wycieków.';
  if (s.includes('elektr')) return 'Warto sprawdzić pozostałe punkty instalacji, szczególnie jeśli problem dotyczył zwarcia lub iskrzenia.';
  if (s.includes('agd')) return 'Zapisz model urządzenia i kod błędu. Przy kolejnej awarii diagnoza będzie szybsza.';
  return 'Możesz zapisać wykonawcę do ulubionych albo utworzyć kolejne zlecenie, jeśli masz następny temat.';
}

function action({ priority, title, tip, cta, seedQuery, actionType }) {
  return {
    ok: true,
    agent: 'order_followup',
    priority,
    title,
    tip,
    cta,
    seedQuery,
    actionType,
    generatedAt: new Date().toISOString()
  };
}

module.exports = {
  buildOrderFollowup,
  buildProviderOrderMatch
};

function normalize(value = '') {
  return String(value)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
