/**
 * Walidacja polskiego numeru NIP (10 cyfr)
 * @param {String} nip - Numer NIP do walidacji
 * @returns {Object} { valid: Boolean, error: String }
 */
function validateNIP(nip) {
  if (!nip) {
    return { valid: false, error: 'NIP jest wymagany' };
  }

  // Usuń wszystkie niecyfrowe znaki
  const digits = nip.replace(/\D/g, '');

  // Sprawdź długość
  if (digits.length !== 10) {
    return { valid: false, error: 'NIP musi składać się z 10 cyfr' };
  }

  // Sprawdź czy wszystkie znaki to cyfry
  if (!/^\d{10}$/.test(digits)) {
    return { valid: false, error: 'NIP może zawierać tylko cyfry' };
  }

  // Walidacja sumy kontrolnej NIP
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  let sum = 0;

  for (let i = 0; i < 9; i++) {
    sum += parseInt(digits[i]) * weights[i];
  }

  const checkDigit = sum % 11;
  
  // Jeśli reszta = 10, NIP jest nieprawidłowy
  if (checkDigit === 10) {
    return { valid: false, error: 'NIP jest nieprawidłowy (suma kontrolna)' };
  }

  // Ostatnia cyfra (10) powinna być równa reszcie z dzielenia przez 11
  if (parseInt(digits[9]) !== checkDigit) {
    return { valid: false, error: 'NIP jest nieprawidłowy (suma kontrolna)' };
  }

  return { valid: true, error: null, normalized: digits };
}

/**
 * Walidacja polskiego numeru REGON (9 lub 14 cyfr)
 * @param {String} regon - Numer REGON do walidacji
 * @returns {Object} { valid: Boolean, error: String }
 */
function validateREGON(regon) {
  if (!regon) {
    return { valid: true, error: null }; // REGON jest opcjonalny
  }

  // Usuń wszystkie niecyfrowe znaki
  const digits = regon.replace(/\D/g, '');

  // REGON może mieć 9 lub 14 cyfr
  if (digits.length !== 9 && digits.length !== 14) {
    return { valid: false, error: 'REGON musi składać się z 9 lub 14 cyfr' };
  }

  // Sprawdź czy wszystkie znaki to cyfry
  if (!/^\d+$/.test(digits)) {
    return { valid: false, error: 'REGON może zawierać tylko cyfry' };
  }

  // Walidacja sumy kontrolnej REGON (9 cyfr)
  if (digits.length === 9) {
    const weights = [8, 9, 2, 3, 4, 5, 6, 7];
    let sum = 0;

    for (let i = 0; i < 8; i++) {
      sum += parseInt(digits[i]) * weights[i];
    }

    const checkDigit = sum % 11;
    const expectedDigit = checkDigit === 10 ? 0 : checkDigit;

    if (parseInt(digits[8]) !== expectedDigit) {
      return { valid: false, error: 'REGON jest nieprawidłowy (suma kontrolna)' };
    }
  }

  // Walidacja REGON 14 cyfr (dla jednostek lokalnych)
  if (digits.length === 14) {
    // Pierwsze 9 cyfr to REGON główny
    const mainRegon = digits.substring(0, 9);
    const mainRegonValid = validateREGON(mainRegon);
    if (!mainRegonValid.valid) {
      return { valid: false, error: 'REGON główny (pierwsze 9 cyfr) jest nieprawidłowy' };
    }

    // Walidacja sumy kontrolnej dla 14 cyfr
    const weights = [2, 4, 8, 5, 0, 9, 7, 3, 6, 1, 2, 4, 8];
    let sum = 0;

    for (let i = 0; i < 13; i++) {
      sum += parseInt(digits[i]) * weights[i];
    }

    const checkDigit = sum % 11;
    const expectedDigit = checkDigit === 10 ? 0 : checkDigit;

    if (parseInt(digits[13]) !== expectedDigit) {
      return { valid: false, error: 'REGON jest nieprawidłowy (suma kontrolna)' };
    }
  }

  return { valid: true, error: null, normalized: digits };
}

/**
 * Walidacja danych firmy
 * @param {Object} companyData - Dane firmy { name, nip, regon, ... }
 * @returns {Object} { valid: Boolean, errors: Object }
 */
function validateCompanyData(companyData) {
  const errors = {};

  // Walidacja nazwy firmy
  if (!companyData.name || !companyData.name.trim()) {
    errors.name = 'Nazwa firmy jest wymagana';
  } else if (companyData.name.trim().length < 2) {
    errors.name = 'Nazwa firmy musi mieć co najmniej 2 znaki';
  } else if (companyData.name.trim().length > 200) {
    errors.name = 'Nazwa firmy jest zbyt długa (max 200 znaków)';
  }

  // Walidacja NIP
  if (companyData.nip) {
    const nipValidation = validateNIP(companyData.nip);
    if (!nipValidation.valid) {
      errors.nip = nipValidation.error;
    }
  } else {
    errors.nip = 'NIP jest wymagany';
  }

  // Walidacja REGON (opcjonalny)
  if (companyData.regon) {
    const regonValidation = validateREGON(companyData.regon);
    if (!regonValidation.valid) {
      errors.regon = regonValidation.error;
    }
  }

  // Walidacja adresu
  if (companyData.address && companyData.address.trim().length > 500) {
    errors.address = 'Adres jest zbyt długi (max 500 znaków)';
  }

  // Walidacja email
  if (companyData.email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(companyData.email)) {
      errors.email = 'Nieprawidłowy adres email';
    }
  }

  // Walidacja telefonu
  if (companyData.phone) {
    const phoneRegex = /^(\+48\s?)?\d{3}[\s\-]?\d{3}[\s\-]?\d{3}$/;
    if (!phoneRegex.test(companyData.phone)) {
      errors.phone = 'Nieprawidłowy numer telefonu';
    }
  }

  return {
    valid: Object.keys(errors).length === 0,
    errors
  };
}

module.exports = {
  validateNIP,
  validateREGON,
  validateCompanyData
};







