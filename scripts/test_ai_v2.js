?/**
 * Prosty skrypt testowy dla endpointu /api/ai/concierge/v2
 * Użycie: node scripts/test_ai_v2.js
 */

require('dotenv').config();
const axios = require('axios');

const BASE_URL = process.env.SERVER_URL || 'http://localhost:5000';
const TEST_EMAIL = process.env.TEST_EMAIL || 'admin@helpfli.local';
const TEST_PASSWORD = process.env.TEST_PASSWORD || 'admin123';

async function testAIEndpointV2() {
  try {
    console.log('🧪 Testowanie AI Concierge V2 endpoint...\n');

    // 1. Login
    console.log('1️⃣ Logowanie...');
    const loginRes = await axios.post(`${BASE_URL}/api/auth/login`, {
      email: TEST_EMAIL,
      password: TEST_PASSWORD
    });
    
    const token = loginRes.data.token;
    if (!token) {
      throw new Error('Nie udało się zalogować - brak tokena');
    }
    console.log('✅ Zalogowano pomyślnie\n');

    // 2. Test endpoint V2
    console.log('2️⃣ Testowanie /api/ai/concierge/v2...');
    const testCases = [
      {
        name: 'Podstawowy problem (hydraulika)',
        body: {
          messages: [
            { role: 'user', content: 'Cieknie mi kran w kuchni, kapało całą noc' }
          ],
          userContext: {
            location: { text: 'Warszawa' }
          }
        }
      },
      {
        name: 'Backward compatibility (description)',
        body: {
          description: 'Mam problem z zatkanym odpływem w łazience',
          locationText: 'Kraków'
        }
      },
      {
        name: 'Niebezpieczna sytuacja (gaz)',
        body: {
          messages: [
            { role: 'user', content: 'Czuję zapach gazu w kuchni, co robić?' }
          ],
          userContext: {
            location: { text: 'Gdańsk' }
          }
        }
      }
    ];

    for (const testCase of testCases) {
      console.log(`\n📝 Test: ${testCase.name}`);
      try {
        const response = await axios.post(
          `${BASE_URL}/api/ai/concierge/v2`,
          testCase.body,
          {
            headers: {
              'Authorization': `Bearer ${token}`,
              'Content-Type': 'application/json'
            }
          }
        );

        const data = response.data;
        
        // Walidacja odpowiedzi
        if (!data.ok) {
          console.error('❌ Odpowiedź zwróciła ok: false');
          console.error('Error:', data.error, data.message);
          continue;
        }

        if (!data.result) {
          console.error('❌ Brak pola "result" w odpowiedzi');
          continue;
        }

        const result = data.result;
        console.log('✅ Status:', data.ok);
        console.log('✅ Agent:', data.agent);
        console.log('✅ Usługa:', result.detectedService);
        console.log('✅ Pilność:', result.urgency);
        console.log('✅ Next Step:', result.nextStep);
        console.log('✅ Intencja:', result.intent);
        console.log('✅ Odpowiedź:', result.reply?.substring(0, 100) + '...');
        
        if (result.safety?.flag) {
          console.log('⚠️  Bezpieczeństwo:', result.safety.reason);
        }
        
        if (result.questions?.length > 0) {
          console.log('❓ Pytania:', result.questions);
        }

      } catch (error) {
        console.error('❌ Błąd:', error.response?.data || error.message);
        if (error.response?.status === 401) {
          console.error('⚠️  Błąd autoryzacji - sprawdź token');
        } else if (error.response?.status === 500) {
          console.error('⚠️  Błąd serwera - sprawdź logi backendu');
        }
      }
    }

    console.log('\n✅ Testy zakończone');

  } catch (error) {
    console.error('❌ Błąd podczas testów:', error.message);
    if (error.response) {
      console.error('Status:', error.response.status);
      console.error('Data:', error.response.data);
    }
    process.exit(1);
  }
}

// Uruchom testy
if (require.main === module) {
  testAIEndpointV2()
    .then(() => {
      console.log('\n🎉 Wszystko OK!');
      process.exit(0);
    })
    .catch((error) => {
      console.error('\n💥 Testy nie przeszły:', error.message);
      process.exit(1);
    });
}

module.exports = { testAIEndpointV2 };

