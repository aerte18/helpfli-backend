const mongoose = require('mongoose');
require('dotenv').config();

const User = require('../models/User');
const Company = require('../models/Company');

// Połącz z MongoDB
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/helpfli', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

async function testCompanySystem() {
  try {
    console.log('🧪 Testowanie systemu firm...');

    // Test 1: Sprawdź czy modele są dostępne
    console.log('\n1. Sprawdzanie modeli...');
    console.log('✅ Model User:', User.modelName);
    console.log('✅ Model Company:', Company.modelName);

    // Test 2: Sprawdź czy istnieją providerzy
    console.log('\n2. Sprawdzanie providerów...');
    const providers = await User.find({ role: 'provider' });
    console.log(`📊 Znaleziono ${providers.length} providerów`);

    // Test 3: Sprawdź czy istnieją firmy
    console.log('\n3. Sprawdzanie firm...');
    const companies = await Company.find({});
    console.log(`🏢 Znaleziono ${companies.length} firm`);

    // Test 4: Sprawdź nowe role
    console.log('\n4. Sprawdzanie nowych ról...');
    const companyOwners = await User.find({ role: 'company_owner' });
    const companyManagers = await User.find({ role: 'company_manager' });
    console.log(`👑 Właściciele firm: ${companyOwners.length}`);
    console.log(`👔 Managerzy firm: ${companyManagers.length}`);

    // Test 5: Sprawdź użytkowników w firmach
    console.log('\n5. Sprawdzanie członków firm...');
    const usersInCompanies = await User.find({ company: { $ne: null } });
    console.log(`👥 Użytkownicy w firmach: ${usersInCompanies.length}`);

    // Test 6: Sprawdź metody modelu User
    console.log('\n6. Testowanie metod modelu User...');
    if (companyOwners.length > 0) {
      const owner = companyOwners[0];
      console.log(`✅ ${owner.name} - isCompanyOwner(): ${owner.isCompanyOwner()}`);
      console.log(`✅ ${owner.name} - canManageCompany(): ${owner.canManageCompany()}`);
    }

    // Test 7: Sprawdź metody modelu Company
    console.log('\n7. Testowanie metod modelu Company...');
    if (companies.length > 0) {
      const company = companies[0];
      console.log(`✅ ${company.name} - teamSize: ${company.teamSize}`);
      console.log(`✅ ${company.name} - fullAddress: ${company.fullAddress}`);
    }

    console.log('\n🎉 Testy zakończone pomyślnie!');
    console.log('\n📋 Podsumowanie:');
    console.log(`   - Providerzy: ${providers.length}`);
    console.log(`   - Firmy: ${companies.length}`);
    console.log(`   - Właściciele firm: ${companyOwners.length}`);
    console.log(`   - Managerzy firm: ${companyManagers.length}`);
    console.log(`   - Członkowie firm: ${usersInCompanies.length}`);

  } catch (error) {
    console.error('💥 Błąd podczas testowania:', error);
  } finally {
    mongoose.disconnect();
  }
}

// Uruchom testy tylko jeśli skrypt jest wywołany bezpośrednio
if (require.main === module) {
  testCompanySystem();
}

module.exports = testCompanySystem;











