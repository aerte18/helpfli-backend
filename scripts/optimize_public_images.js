/**
 * Konwertuje duże PNG z frontend/public/img do WebP (jakość 82).
 * Uruchom: node scripts/optimize_public_images.js
 */
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');

const IMG_DIR = path.join(__dirname, '../../frontend/public/img');
const MIN_BYTES = 150 * 1024;

async function main() {
  if (!fs.existsSync(IMG_DIR)) {
    console.error('Brak katalogu:', IMG_DIR);
    process.exit(1);
  }

  const files = fs.readdirSync(IMG_DIR).filter((f) => /\.png$/i.test(f));
  let converted = 0;

  for (const file of files) {
    const src = path.join(IMG_DIR, file);
    const stat = fs.statSync(src);
    if (stat.size < MIN_BYTES) continue;

    const dest = path.join(IMG_DIR, file.replace(/\.png$/i, '.webp'));
    await sharp(src)
      .webp({ quality: 82, effort: 4 })
      .toFile(dest);

    const outStat = fs.statSync(dest);
    console.log(
      `${file}: ${(stat.size / 1024).toFixed(0)} KB → ${path.basename(dest)} ${(outStat.size / 1024).toFixed(0)} KB`
    );
    converted += 1;
  }

  console.log(`Done. ${converted} WebP file(s) in ${IMG_DIR}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
