/**
 * Script do testowania Fazy 2
 */

console.log('🧪 Testowanie Fazy 2: Zaawansowane\n');
console.log('📦 Testowane komponenty:');
console.log('   1. Tool Calling & Actions');
console.log('   2. Caching & Performance');
console.log('   3. Error Recovery & Resilience\n');

const { spawn } = require('child_process');
const path = require('path');

const testProcess = spawn('npm', ['test', '--', 'phase2'], {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
  shell: true
});

testProcess.on('close', (code) => {
  if (code === 0) {
    console.log('\n✅ Wszystkie testy Fazy 2 przeszły pomyślnie!');
  } else {
    console.log(`\n❌ Niektóre testy nie przeszły (kod: ${code})`);
    process.exit(1);
  }
});

testProcess.on('error', (error) => {
  console.error('❌ Błąd podczas uruchamiania testów:', error);
  process.exit(1);
});

