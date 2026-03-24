const fs = require('fs');
const path = require('path');

const routesDir = path.join(__dirname, '../routes');
const files = fs.readdirSync(routesDir).filter(f => f.endsWith('.js'));

console.log('Checking routes for path-to-regexp errors...\n');

const problematicPatterns = [
  /router\.(get|post|put|delete|patch)\(['"][^'"]*:\s*['"]/,  // : bez nazwy
  /router\.(get|post|put|delete|patch)\(['"][^'"]*:\s*\)/,   // : przed )
  /router\.(get|post|put|delete|patch)\(['"][^'"]*:\s*[^a-zA-Z_0-9]/, // : przed nieprawidłowym znakiem
];

let foundIssues = false;

files.forEach(file => {
  const filePath = path.join(routesDir, file);
  const content = fs.readFileSync(filePath, 'utf8');
  const lines = content.split('\n');
  
  lines.forEach((line, index) => {
    problematicPatterns.forEach((pattern, patternIndex) => {
      if (pattern.test(line)) {
        console.log(`❌ ${file}:${index + 1}`);
        console.log(`   Pattern ${patternIndex + 1} matched:`);
        console.log(`   ${line.trim()}\n`);
        foundIssues = true;
      }
    });
  });
});

if (!foundIssues) {
  console.log('✅ No obvious route pattern issues found.');
  console.log('\nChecking for routes with parameters...\n');
  
  // Sprawdź wszystkie routy z parametrami
  files.forEach(file => {
    const filePath = path.join(routesDir, file);
    const content = fs.readFileSync(filePath, 'utf8');
    const routes = content.match(/router\.(get|post|put|delete|patch)\(['"]([^'"]+)['"]/g);
    
    if (routes) {
      routes.forEach(route => {
        const pathMatch = route.match(/['"]([^'"]+)['"]/);
        if (pathMatch && pathMatch[1].includes(':')) {
          const routePath = pathMatch[1];
          // Sprawdź czy są poprawne parametry
          const params = routePath.match(/:[a-zA-Z_][a-zA-Z0-9_]*/g);
          const allColons = routePath.match(/:/g);
          
          if (allColons && (!params || params.length !== allColons.length)) {
            console.log(`⚠️  ${file}: Route with potential issue:`);
            console.log(`   ${route}`);
            console.log(`   Path: ${routePath}`);
            console.log(`   Found ${allColons.length} colons, ${params ? params.length : 0} valid params\n`);
            foundIssues = true;
          }
        }
      });
    }
  });
}

if (!foundIssues) {
  console.log('✅ All route patterns look correct.');
  console.log('\nThe issue might be with Express 5 compatibility.');
  console.log('Try checking if any route uses unsupported syntax.');
}

