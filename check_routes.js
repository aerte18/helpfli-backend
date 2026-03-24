const fs = require('fs');
const path = require('path');

const routesDir = path.join(__dirname, 'routes');
const files = fs.readdirSync(routesDir).filter(f => f.endsWith('.js'));

console.log('Checking routes files for invalid patterns...\n');

for (const file of files) {
  const filePath = path.join(routesDir, file);
  const content = fs.readFileSync(filePath, 'utf8');
  
  // Szukaj router.(get|post|put|delete|patch) z potencjalnie błędnymi wzorcami
  const routePattern = /router\.(get|post|put|delete|patch)\(['"]([^'"]+)['"]/g;
  let match;
  let foundIssue = false;
  
  while ((match = routePattern.exec(content)) !== null) {
    const routePath = match[2];
    const lineNumber = content.substring(0, match.index).split('\n').length;
    
    // Sprawdź czy jest : bez nazwy parametru
    if (routePath.includes(':/') || routePath.match(/:\s*['"]/) || routePath.match(/:\s*\)/)) {
      console.log(`❌ ${file}:${lineNumber} - Invalid route pattern: "${routePath}"`);
      foundIssue = true;
    }
    
    // Sprawdź czy jest : na końcu bez nazwy
    if (routePath.match(/:\s*$/)) {
      console.log(`❌ ${file}:${lineNumber} - Route ends with colon: "${routePath}"`);
      foundIssue = true;
    }
  }
  
  if (!foundIssue) {
    console.log(`✅ ${file} - OK`);
  }
}

console.log('\nDone checking routes.');

