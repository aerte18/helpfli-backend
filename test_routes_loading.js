const express = require('express');
const fs = require('fs');
const path = require('path');

const routesDir = path.join(__dirname, 'routes');
const files = fs.readdirSync(routesDir).filter(f => f.endsWith('.js'));

console.log('Testing route files loading...\n');

for (const file of files) {
  try {
    const filePath = path.join(routesDir, file);
    const app = express();
    const router = express.Router();
    
    // Próbuj załadować router
    delete require.cache[require.resolve(filePath)];
    const routeModule = require(filePath);
    
    console.log(`✅ ${file} - Loaded successfully`);
  } catch (error) {
    if (error.message.includes('Missing parameter name') || error.message.includes('path-to-regexp')) {
      console.log(`❌ ${file} - ERROR: ${error.message}`);
      console.log(`   Stack: ${error.stack.split('\n')[0]}`);
    } else {
      // Ignoruj inne błędy (np. brakujące moduły)
      console.log(`⚠️  ${file} - Other error: ${error.message.split('\n')[0]}`);
    }
  }
}

console.log('\nDone testing routes loading.');

