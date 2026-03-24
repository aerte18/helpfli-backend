const fs = require('fs');
const path = require('path');

const routesDir = path.join(__dirname, '../routes');
const files = fs.readdirSync(routesDir).filter(f => f.endsWith('.js'));

console.log('Testing route files loading...\n');

const express = require('express');

files.forEach(file => {
  try {
    const filePath = path.join(routesDir, file);
    console.log(`Testing ${file}...`);
    
    // Spróbuj załadować router
    const router = express.Router();
    delete require.cache[require.resolve(filePath)];
    const routeModule = require(filePath);
    
    // Jeśli moduł eksportuje router, spróbuj go użyć
    if (routeModule && typeof routeModule === 'function') {
      // To jest router
    } else if (routeModule && routeModule.default) {
      // To może być default export
    }
    
    console.log(`✅ ${file} loaded successfully\n`);
  } catch (error) {
    console.log(`❌ ${file} FAILED:`);
    console.log(`   ${error.message}`);
    if (error.message.includes('path-to-regexp') || error.message.includes('Missing parameter')) {
      console.log(`   ⚠️  THIS IS THE PROBLEMATIC FILE!\n`);
      process.exit(1);
    }
    console.log('');
  }
});

console.log('✅ All files tested');

