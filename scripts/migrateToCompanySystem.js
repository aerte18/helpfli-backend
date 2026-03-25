const mongoose = require('mongoose');
require('dotenv').config();

const User = require('../models/User');
const Company = require('../models/Company');

// Połącz z MongoDB
mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/helpfli', {
  useNewUrlParser: true,
  useUnifiedTopology: true,
});

async function migrateToCompanySystem() {
  try {
    console.log('🚀 Rozpoczynam migrację do systemu firm...');

    // Znajdź wszystkich providerów z flagą isB2B
    const b2bProviders = await User.find({ 
      role: 'provider', 
      isB2B: true 
    });

    console.log(`📊 Znaleziono ${b2bProviders.length} providerów B2B`);

    let companiesCreated = 0;
    let usersMigrated = 0;

    for (const provider of b2bProviders) {
      try {
        // Sprawdź czy provider już należy do firmy
        if (provider.company) {
          console.log(`⚠️  Provider ${provider.email} już należy do firmy`);
          continue;
        }

        // Utwórz firmę dla tego providera
        const companyData = {
          name: provider.kyc?.companyName || `${provider.name} - Firma`,
          nip: provider.kyc?.nip || '0000000000', // placeholder NIP
          email: provider.email,
          phone: provider.phone,
          owner: provider._id,
          providers: [provider._id],
          status: 'pending', // będzie wymagać weryfikacji
          verified: false
        };

        const company = new Company(companyData);
        await company.save();

        // Zaktualizuj providera
        provider.company = company._id;
        provider.roleInCompany = 'owner';
        provider.role = 'company_owner';
        await provider.save();

        companiesCreated++;
        usersMigrated++;

        console.log(`✅ Utworzono firmę "${company.name}" dla ${provider.email}`);

      } catch (error) {
        console.error(`❌ Błąd podczas migracji ${provider.email}:`, error.message);
      }
    }

    console.log('\n📈 Podsumowanie migracji:');
    console.log(`   - Utworzonych firm: ${companiesCreated}`);
    console.log(`   - Zmigrowanych użytkowników: ${usersMigrated}`);
    console.log('\n🎉 Migracja zakończona pomyślnie!');

    // Wyświetl statystyki
    const totalCompanies = await Company.countDocuments();
    const totalCompanyOwners = await User.countDocuments({ role: 'company_owner' });
    const totalCompanyMembers = await User.countDocuments({ company: { $ne: null } });

    console.log('\n📊 Aktualne statystyki:');
    console.log(`   - Łączna liczba firm: ${totalCompanies}`);
    console.log(`   - Właściciele firm: ${totalCompanyOwners}`);
    console.log(`   - Członkowie firm: ${totalCompanyMembers}`);

  } catch (error) {
    console.error('💥 Błąd podczas migracji:', error);
  } finally {
    mongoose.disconnect();
  }
}

// Uruchom migrację tylko jeśli skrypt jest wywołany bezpośrednio
if (require.main === module) {
  migrateToCompanySystem();
}

module.exports = migrateToCompanySystem;











