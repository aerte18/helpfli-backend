/**
 * Skrypt do tworzenia wszystkich użytkowników testowych
 * Uruchom: node scripts/create_all_test_users.js
 */

require('dotenv').config();
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const Company = require('../models/Company');

const TEST_PASSWORD = 'Test123!'; // Wspólne hasło dla wszystkich użytkowników testowych

async function createTestUsers() {
  try {
    const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/helpfli';
    console.log('🔌 Łączenie z MongoDB:', uri.replace(/\/\/.*@/, '//***@')); // Ukryj credentials
    
    await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
    console.log('✅ Połączono z MongoDB\n');

    const hashedPassword = await bcrypt.hash(TEST_PASSWORD, 10);

    // 1. Admin
    console.log('📝 Tworzenie użytkownika ADMIN...');
    const admin = await User.findOneAndUpdate(
      { email: 'admin@helpfli.test' },
      {
        $set: {
          name: 'Admin Testowy',
          email: 'admin@helpfli.test',
          password: hashedPassword,
          role: 'admin',
          emailVerified: true,
          onboardingCompleted: true,
          isActive: true,
          phone: '+48 111 111 111'
        }
      },
      { upsert: true, new: true }
    );
    console.log('✅ Admin utworzony:', admin.email);

    // 2. Client
    console.log('\n📝 Tworzenie użytkownika CLIENT...');
    const client = await User.findOneAndUpdate(
      { email: 'client@helpfli.test' },
      {
        $set: {
          name: 'Jan Klient',
          email: 'client@helpfli.test',
          password: hashedPassword,
          role: 'client',
          emailVerified: true,
          onboardingCompleted: true,
          isActive: true,
          phone: '+48 222 222 222',
          location: 'Warszawa',
          locationLat: 52.2297,
          locationLon: 21.0122
        }
      },
      { upsert: true, new: true }
    );
    console.log('✅ Client utworzony:', client.email);

    // 3. Provider
    console.log('\n📝 Tworzenie użytkownika PROVIDER...');
    const provider = await User.findOneAndUpdate(
      { email: 'provider@helpfli.test' },
      {
        $set: {
          name: 'Jan Kowalski - Hydraulik',
          email: 'provider@helpfli.test',
          password: hashedPassword,
          role: 'provider',
          emailVerified: true,
          onboardingCompleted: true,
          isActive: true,
          phone: '+48 333 333 333',
          location: 'Warszawa',
          locationLat: 52.2297,
          locationLon: 21.0122,
          bio: 'Profesjonalny hydraulik z 10-letnim doświadczeniem. Naprawiam krany, instalacje wodne, ogrzewanie.',
          providerTier: 'pro',
          verified: true,
          provider_status: {
            isOnline: true,
            lastSeenAt: new Date()
          }
        }
      },
      { upsert: true, new: true }
    );
    console.log('✅ Provider utworzony:', provider.email);

    // 4. Company Owner
    console.log('\n📝 Tworzenie użytkownika COMPANY OWNER...');
    let company = await Company.findOne({ nip: '1234567890' });
    
    if (!company) {
      // Najpierw utwórz użytkownika company_owner
      const companyOwner = await User.findOneAndUpdate(
        { email: 'company@helpfli.test' },
        {
          $set: {
            name: 'Jan Firma',
            email: 'company@helpfli.test',
            password: hashedPassword,
            role: 'company_owner',
            emailVerified: true,
            onboardingCompleted: true,
            isActive: true,
            phone: '+48 444 444 444'
          }
        },
        { upsert: true, new: true }
      );

      // Utwórz firmę
      company = await Company.create({
        name: 'Firma Testowa Sp. z o.o.',
        nip: '1234567890',
        regon: '123456789',
        email: 'company@helpfli.test',
        phone: '+48 444 444 444',
        address: 'ul. Marszałkowska 1, 00-001 Warszawa',
        owner: companyOwner._id,
        status: 'active',
        description: 'Firma testowa do demonstracji funkcji B2B'
      });

      // Przypisz użytkownika do firmy
      companyOwner.company = company._id;
      companyOwner.roleInCompany = 'owner';
      await companyOwner.save();

      console.log('✅ Company Owner utworzony:', companyOwner.email);
      console.log('✅ Firma utworzona:', company.name);
    } else {
      // Firma już istnieje, zaktualizuj użytkownika
      const companyOwner = await User.findOneAndUpdate(
        { email: 'company@helpfli.test' },
        {
          $set: {
            name: 'Jan Firma',
            email: 'company@helpfli.test',
            password: hashedPassword,
            role: 'company_owner',
            emailVerified: true,
            onboardingCompleted: true,
            isActive: true,
            phone: '+48 444 444 444',
            company: company._id,
            roleInCompany: 'owner'
          }
        },
        { upsert: true, new: true }
      );
      console.log('✅ Company Owner zaktualizowany:', companyOwner.email);
    }

    console.log('\n' + '='.repeat(60));
    console.log('✅ WSZYSCY UŻYTKOWNICY TESTOWI UTWORZENI!');
    console.log('='.repeat(60));
    console.log('\n📋 DANE LOGOWANIA:\n');
    console.log('👤 ADMIN:');
    console.log('   Email: admin@helpfli.test');
    console.log('   Hasło: ' + TEST_PASSWORD);
    console.log('\n👤 CLIENT:');
    console.log('   Email: client@helpfli.test');
    console.log('   Hasło: ' + TEST_PASSWORD);
    console.log('\n👤 PROVIDER:');
    console.log('   Email: provider@helpfli.test');
    console.log('   Hasło: ' + TEST_PASSWORD);
    console.log('\n👤 COMPANY OWNER:');
    console.log('   Email: company@helpfli.test');
    console.log('   Hasło: ' + TEST_PASSWORD);
    console.log('   Firma: ' + company.name);
    console.log('\n' + '='.repeat(60));
    console.log('Możesz się teraz zalogować używając powyższych danych!\n');

    await mongoose.disconnect();
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Błąd podczas tworzenia użytkowników:', error.message);
    if (error.message.includes('timeout') || error.message.includes('ECONNREFUSED')) {
      console.error('\n💡 Wskazówka: Upewnij się, że MongoDB jest uruchomione!');
      console.error('   Uruchom: docker-compose up mongo');
      console.error('   Lub: mongod (jeśli masz MongoDB lokalnie)');
    }
    process.exit(1);
  }
}

// Uruchom skrypt
createTestUsers();

