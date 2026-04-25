const { body, param, query, validationResult } = require('express-validator');

// Middleware do sprawdzania wyników walidacji
const validateRequest = (req, res, next) => {
  const errors = validationResult(req);
  if (!errors.isEmpty()) {
    return res.status(400).json({
      error: 'Błąd walidacji danych',
      details: errors.array().map(err => ({
        field: err.path,
        message: err.msg,
        value: err.value
      }))
    });
  }
  next();
};

// Walidacja rejestracji
const validateRegistration = [
  body('name')
    .trim()
    .isLength({ min: 2, max: 100 })
    .withMessage('Imię i nazwisko musi mieć 2-100 znaków')
    .matches(/^[a-zA-ZąćęłńóśźżĄĆĘŁŃÓŚŹŻ\s\-\.]+$/)
    .withMessage('Imię i nazwisko może zawierać tylko litery, spacje, myślniki i kropki'),
  
  body('email')
    .trim()
    .isEmail()
    .withMessage('Nieprawidłowy adres email')
    .normalizeEmail()
    .isLength({ max: 255 })
    .withMessage('Email jest zbyt długi'),
  
  body('password')
    .isLength({ min: 8, max: 128 })
    .withMessage('Hasło musi mieć 8-128 znaków')
    .matches(/^(?=.*[a-z])(?=.*[A-Z])(?=.*\d)(?=.*[@$!%*?&])[A-Za-z\d@$!%*?&]/)
    .withMessage('Hasło musi zawierać małą literę, wielką literę, cyfrę i znak specjalny'),
  
  body('phone')
    .optional()
    .trim()
    .matches(/^(\+48\s?)?\d{3}[\s\-]?\d{3}[\s\-]?\d{3}$/)
    .withMessage('Nieprawidłowy numer telefonu (format: +48 123 456 789)'),
  
  body('role')
    .isIn(['client', 'provider'])
    .withMessage('Rola musi być "client" lub "provider"'),
  
  body('address')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Adres jest zbyt długi'),
  
  body('name').trim(),
  body('email').trim().toLowerCase(),
  body('phone').trim(),
  body('address').trim(),
  
  validateRequest
];

// Walidacja logowania
const validateLogin = [
  body('email')
    .trim()
    .isEmail()
    .withMessage('Nieprawidłowy adres email')
    .normalizeEmail(),
  
  body('password')
    .notEmpty()
    .withMessage('Hasło jest wymagane')
    .isLength({ max: 128 })
    .withMessage('Hasło jest zbyt długie'),
  
  body('email').trim().toLowerCase(),
  
  validateRequest
];

// Walidacja wyszukiwania
const validateSearch = [
  query('q')
    .optional()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Zapytanie wyszukiwania musi mieć 1-100 znaków')
    .matches(/^[a-zA-ZąćęłńóśźżĄĆĘŁŃÓŚŹŻ0-9\s\-\.]+$/)
    .withMessage('Zapytanie zawiera niedozwolone znaki'),
  
  query('city')
    .optional()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Nazwa miasta jest zbyt długa'),
  
  query('location')
    .optional()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Nazwa lokalizacji jest zbyt długa'),
  
  query('service')
    .optional()
    .trim()
    .isLength({ min: 1, max: 200 })
    .withMessage('Parametr service jest zbyt długi'),

  query('category')
    .optional()
    .trim()
    .isLength({ min: 1, max: 100 })
    .withMessage('Parametr category jest zbyt długi'),
  
  query('minRating')
    .optional()
    .isFloat({ min: 0, max: 5 })
    .withMessage('Ocena musi być między 0 a 5'),
  
  query('budgetMin')
    .optional()
    .isInt({ min: 0, max: 100000 })
    .withMessage('Budżet minimalny musi być między 0 a 100000'),
  
  query('budgetMax')
    .optional()
    .isInt({ min: 0, max: 100000 })
    .withMessage('Budżet maksymalny musi być między 0 a 100000'),
  
  query('q').optional().trim(),
  query('city').optional().trim(),
  query('location').optional().trim(),
  query('service').optional().trim(),
  query('category').optional().trim(),
  
  validateRequest
];

// Walidacja tworzenia zlecenia
const validateCreateOrder = [
  body('service')
    .trim()
    .notEmpty()
    .withMessage('Usługa jest wymagana')
    .isLength({ min: 1, max: 100 })
    .withMessage('Nazwa usługi jest zbyt długa'),
  
  body('description')
    .optional()
    .trim()
    .isLength({ min: 10, max: 2000 })
    .withMessage('Opis musi mieć 10-2000 znaków'),
  
  body('location.address')
    .optional()
    .trim()
    .isLength({ max: 500 })
    .withMessage('Adres jest zbyt długi'),
  
  body('location.lat')
    .optional()
    .isFloat({ min: -90, max: 90 })
    .withMessage('Nieprawidłowa szerokość geograficzna'),
  
  body('location.lng')
    .optional()
    .isFloat({ min: -180, max: 180 })
    .withMessage('Nieprawidłowa długość geograficzna'),
  
  body('budget')
    .optional()
    .isInt({ min: 0, max: 100000 })
    .withMessage('Budżet musi być między 0 a 100000'),
  
  body('service').trim(),
  body('description').trim(),
  body('location.address').trim(),
  
  validateRequest
];

// Walidacja wyceny
const validateQuote = [
  body('price')
    .isInt({ min: 0, max: 100000 })
    .withMessage('Cena musi być między 0 a 100000'),
  
  body('estimatedTime')
    .optional()
    .trim()
    .isLength({ max: 200 })
    .withMessage('Szacowany czas jest zbyt długi'),
  
  body('comment')
    .optional()
    .trim()
    .isLength({ min: 1, max: 1000 })
    .withMessage('Komentarz musi mieć 1-1000 znaków'),
  
  body('estimatedTime').trim(),
  body('comment').trim(),
  
  validateRequest
];

// Walidacja ID parametrów
const validateObjectId = (paramName) => [
  param(paramName)
    .isMongoId()
    .withMessage(`Nieprawidłowy ${paramName}`),
  
  param(paramName),
  
  validateRequest
];

// Walidacja wiadomości w czacie
const validateChatMessage = [
  body('text')
    .trim()
    .isLength({ min: 1, max: 1000 })
    .withMessage('Wiadomość musi mieć 1-1000 znaków')
    .matches(/^[^<>]*$/)
    .withMessage('Wiadomość zawiera niedozwolone znaki'),
  
  body('orderId')
    .isMongoId()
    .withMessage('Nieprawidłowe ID zlecenia'),
  
  body('text').trim(),
  
  validateRequest
];

// Walidacja telemetry
const validateTelemetry = [
  body('eventType')
    .isIn(['page_view', 'provider_view', 'order_view', 'search', 'filter_applied',
           'category_selected', 'provider_contact', 'provider_compare', 'quote_request',
           'order_created', 'order_accepted', 'order_started', 'order_completed',
           'order_form_start', 'order_step_view', 'order_form_abandon', 'order_form_success',
           'offer_form_start', 'offer_step_view', 'offer_form_submit',
           'offer_form_preflight_blocked', 'offer_form_preflight_override',
           'provider_ai_message_preflight_blocked', 'provider_ai_message_preflight_override', 'provider_ai_message_sent',
           'company_ai_shortlist_generated', 'company_ai_followup_sent', 'company_ai_auto_followup_sent', 'company_ai_auto_followup_cron_run', 'company_ai_sla_breach_detected',
           'payment_intent_created', 'payment_succeeded', 'payment_failed',
           'login', 'register', 'onboarding_completed', 'dispute_reported', 'refund_requested',
           'client_api_error'])
    .withMessage('Nieprawidłowy typ eventu'),
  
  body('properties')
    .optional()
    .isObject()
    .withMessage('Properties musi być obiektem'),
  
  body('metadata')
    .optional()
    .isObject()
    .withMessage('Metadata musi być obiektem'),
  
  validateRequest
];

// Walidacja uploadu plików
const validateFileUpload = (req, res, next) => {
  if (!req.file && !req.files) {
    return res.status(400).json({ error: 'Brak pliku do uploadu' });
  }
  
  const file = req.file || (req.files && req.files[0]);
  if (!file) {
    return res.status(400).json({ error: 'Nieprawidłowy plik' });
  }
  
  // Sprawdź typ pliku
  const allowedMimeTypes = [
    'image/jpeg',
    'image/png',
    'image/gif',
    'application/pdf',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  ];
  
  if (!allowedMimeTypes.includes(file.mimetype)) {
    return res.status(400).json({ 
      error: 'Niedozwolony typ pliku. Dozwolone: JPG, PNG, GIF, PDF, DOC, DOCX' 
    });
  }
  
  // Sprawdź rozmiar pliku (max 10MB)
  const maxSize = 10 * 1024 * 1024; // 10MB
  if (file.size > maxSize) {
    return res.status(400).json({ 
      error: 'Plik jest zbyt duży. Maksymalny rozmiar: 10MB' 
    });
  }
  
  next();
};

module.exports = {
  validateRequest,
  validateRegistration,
  validateLogin,
  validateSearch,
  validateCreateOrder,
  validateQuote,
  validateObjectId,
  validateChatMessage,
  validateTelemetry,
  validateFileUpload
};
