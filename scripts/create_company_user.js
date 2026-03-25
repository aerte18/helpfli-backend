require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Company = require('../models/Company');
const { initializeCompanyResourcePool } = require('../utils/resourcePool');

(async () => {
  try {
    const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/helpfli';
    await mongoose.connect(uri);
    console.log('Połączono z MongoDB');

    const hashedPassword = await bcrypt.hash('company123', 10);
    
    // Sprawdź czy użytkownik już istnieje
    let user = await User.findOne({ email: 'company@helpfli.local' });
    
    if (user) {
      console.log('Użytkownik już istnieje, aktualizuję...');
      user.password = hashedPassword;
      user.emailVerified = true;
      user.onboardingCompleted = true;
      user.isActive = true;
      await user.save();
    } else {
      // Utwórz użytkownika
      user = await User.create({
        name: 'Jan Firmowy',
        email: 'company@helpfli.local',
        password: hashedPassword,
        role: 'provider', // Provider żeby mógł korzystać z funkcji B2B
        emailVerified: true,
        onboardingCompleted: true,
        isActive: true,
        location: 'Warszawa',
        locationCoords: { lat: 52.2297, lng: 21.0122 },
        phone: '+48 123 456 789',
        isB2B: true,
        b2b: true,
        level: 'standard',
        providerLevel: 'standard',
        address: 'ul. Marszałkowska 1, Warszawa'
      });
      console.log('✅ Utworzono użytkownika:', user.email);
    }

    // Sprawdź czy firma już istnieje
    let company = await Company.findOne({ nip: '1234567890' });
    
    if (!company) {
      // Utwórz firmę
      company = await Company.create({
        name: 'Firma Testowa Sp. z o.o.',
        nip: '1234567890',
        regon: '123456789',
        email: 'company@helpfli.local',
        phone: '+48 123 456 789',
        address: 'ul. Marszałkowska 1, 00-001 Warszawa',
        owner: user._id,
        status: 'pending',
        description: 'Firma testowa do demonstracji funkcji B2B'
      });
      console.log('✅ Utworzono firmę:', company.name);
    } else {
      console.log('Firma już istnieje, aktualizuję właściciela...');
      company.owner = user._id;
      await company.save();
    }

    // Przypisz użytkownika do firmy
    user.company = company._id;
    user.roleInCompany = 'owner';
    user.role = 'company_owner';
    await user.save();

    // Zainicjalizuj resource pool (opcjonalnie - tylko jeśli ma plan biznesowy)
    // await initializeCompanyResourcePool(company._id);

    console.log('\n✅ Konto firmowe utworzone pomyślnie!');
    console.log('📧 Email: company@helpfli.local');
    console.log('🔑 Hasło: company123');
    console.log('🏢 Firma: ' + company.name);
    console.log('📋 NIP: ' + company.nip);
    console.log('\nMożesz się teraz zalogować i zobaczyć CompanyDashboard!');
    
    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('❌ Błąd:', error);
    process.exit(1);
  }
})();







