?// Load testing script dla endpointów Helpfli
// Uruchom: node scripts/load_test.js

const http = require('http');
const https = require('https');

const BASE_URL = process.env.API_URL || 'http://localhost:5000';
const CONCURRENT_REQUESTS = parseInt(process.env.CONCURRENT || '10', 10);
const TOTAL_REQUESTS = parseInt(process.env.TOTAL || '100', 10);
const ENDPOINT = process.env.ENDPOINT || '/api/providers/match-top?serviceCode=hydraulik&lat=52.2297&lng=21.0122';

// Statystyki
const stats = {
  total: 0,
  success: 0,
  errors: 0,
  times: [],
  statusCodes: {}
};

function makeRequest() {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();
    const url = new URL(ENDPOINT, BASE_URL);
    
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname + url.search,
      method: 'GET',
      headers: {
        'Content-Type': 'application/json'
      }
    };

    const client = url.protocol === 'https:' ? https : http;
    
    const req = client.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        const duration = Date.now() - startTime;
        stats.total++;
        stats.times.push(duration);
        
        if (res.statusCode >= 200 && res.statusCode < 300) {
          stats.success++;
        } else {
          stats.errors++;
        }
        
        stats.statusCodes[res.statusCode] = (stats.statusCodes[res.statusCode] || 0) + 1;
        
        resolve({ statusCode: res.statusCode, duration, data });
      });
    });
    
    req.on('error', (error) => {
      stats.total++;
      stats.errors++;
      reject(error);
    });
    
    req.setTimeout(10000, () => {
      req.destroy();
      stats.total++;
      stats.errors++;
      reject(new Error('Request timeout'));
    });
    
    req.end();
  });
}

async function runLoadTest() {
  console.log('🚀 Rozpoczynam load test...');
  console.log(`📍 Endpoint: ${BASE_URL}${ENDPOINT}`);
  console.log(`👥 Concurrent requests: ${CONCURRENT_REQUESTS}`);
  console.log(`📊 Total requests: ${TOTAL_REQUESTS}`);
  console.log('---\n');

  const startTime = Date.now();
  const promises = [];
  
  // Wykonaj wszystkie requesty
  for (let i = 0; i < TOTAL_REQUESTS; i++) {
    promises.push(makeRequest().catch(err => ({ error: err.message })));
    
    // Ogranicz concurrent requests
    if (promises.length >= CONCURRENT_REQUESTS) {
      await Promise.all(promises);
      promises.length = 0;
    }
  }
  
  // Wykonaj pozostałe
  if (promises.length > 0) {
    await Promise.all(promises);
  }
  
  const totalTime = Date.now() - startTime;
  
  // Oblicz statystyki
  const sortedTimes = stats.times.sort((a, b) => a - b);
  const avgTime = stats.times.length > 0 
    ? Math.round(stats.times.reduce((a, b) => a + b, 0) / stats.times.length)
    : 0;
  const minTime = sortedTimes[0] || 0;
  const maxTime = sortedTimes[sortedTimes.length - 1] || 0;
  const medianTime = sortedTimes.length > 0
    ? sortedTimes[Math.floor(sortedTimes.length / 2)]
    : 0;
  const p95Time = sortedTimes.length > 0
    ? sortedTimes[Math.floor(sortedTimes.length * 0.95)]
    : 0;
  const p99Time = sortedTimes.length > 0
    ? sortedTimes[Math.floor(sortedTimes.length * 0.99)]
    : 0;
  
  const successRate = stats.total > 0 ? ((stats.success / stats.total) * 100).toFixed(2) : 0;
  const rps = (stats.total / (totalTime / 1000)).toFixed(2);
  
  // Wyświetl wyniki
  console.log('\n📊 WYNIKI LOAD TESTU\n');
  console.log(`⏱️  Czas całkowity: ${(totalTime / 1000).toFixed(2)}s`);
  console.log(`📈 Requests per second: ${rps}`);
  console.log(`✅ Sukces: ${stats.success}/${stats.total} (${successRate}%)`);
  console.log(`❌ Błędy: ${stats.errors}/${stats.total}`);
  console.log('\n⏱️  CZASY ODPOWIEDZI:');
  console.log(`   Średnia: ${avgTime}ms`);
  console.log(`   Mediana: ${medianTime}ms`);
  console.log(`   Min: ${minTime}ms`);
  console.log(`   Max: ${maxTime}ms`);
  console.log(`   P95: ${p95Time}ms`);
  console.log(`   P99: ${p99Time}ms`);
  
  if (Object.keys(stats.statusCodes).length > 0) {
    console.log('\n📋 KODY STATUSU:');
    Object.entries(stats.statusCodes).forEach(([code, count]) => {
      console.log(`   ${code}: ${count}`);
    });
  }
  
  console.log('\n✅ Load test zakończony!\n');
}

// Uruchom test
runLoadTest().catch(err => {
  console.error('❌ Błąd podczas load testu:', err);
  process.exit(1);
});













