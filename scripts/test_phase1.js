/**
 * Script do testowania Fazy 1
 * Uruchamia wszystkie testy i pokazuje wyniki
 */

const { spawn } = require('child_process');
const path = require('path');

console.log('🧪 Testowanie Fazy 1: Fundamenty\n');
console.log('📦 Testowane komponenty:');
console.log('   1. Memory & Context Management');
console.log('   2. Feedback Loop');
console.log('   3. Analytics & Monitoring');
console.log('   4. Streaming Responses (jeśli API key dostępny)');
console.log('   5. Integration Tests\n');

// Uruchom testy
const testProcess = spawn('npm', ['test', '--', 'phase1'], {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
  shell: true
});

testProcess.on('close', (code) => {
  if (code === 0) {
    console.log('\n✅ Wszystkie testy Fazy 1 przeszły pomyślnie!');
  } else {
    console.log(`\n❌ Niektóre testy nie przeszły (kod: ${code})`);
    process.exit(1);
  }
});

testProcess.on('error', (error) => {
  console.error('❌ Błąd podczas uruchamiania testów:', error);
  process.exit(1);
});

