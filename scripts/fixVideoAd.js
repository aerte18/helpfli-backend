require('dotenv').config();
const mongoose = require('mongoose');
const SponsorAd = require('../models/SponsorAd');

async function fixVideoAd() {
  try {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/helpfli');
    console.log('✅ Połączono z bazą danych');

    const ad = await SponsorAd.findOne({ 
      'advertiser.email': 'animacja@przyklad.pl' 
    });

    if (!ad) {
      console.log('❌ Reklama nie znaleziona');
      await mongoose.disconnect();
      return;
    }

    // Zmień na obraz statyczny zamiast wideo (które jest blokowane)
    // Lub użyj innego źródła wideo, które nie blokuje CORS
    ad.mediaType = 'image';
    ad.imageUrl = 'https://images.unsplash.com/photo-1504148455328-c376907d081c?w=1200&h=600&fit=crop'; // Obraz narzędzi
    ad.videoUrl = undefined; // Usuń wideo, które jest blokowane
    
    await ad.save();

    console.log('✅ Zaktualizowano reklamę:', ad.title);
    console.log('   Media Type:', ad.mediaType);
    console.log('   Image URL:', ad.imageUrl);
    console.log('   Video URL:', ad.videoUrl || 'usunięte');

    await mongoose.disconnect();
  } catch (error) {
    console.error('❌ Błąd:', error);
    process.exit(1);
  }
}

fixVideoAd();






