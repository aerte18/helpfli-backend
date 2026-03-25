require('dotenv').config();
const mongoose = require('mongoose');
const SponsorAd = require('../models/SponsorAd');

async function fixFirstAd() {
  try {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/helpfli');
    console.log('✅ Połączono z bazą danych');

    const ad = await SponsorAd.findOne({ 
      'advertiser.email': 'przyklad@sklepagd.pl' 
    });

    if (!ad) {
      console.log('❌ Reklama nie znaleziona');
      await mongoose.disconnect();
      return;
    }

    // Dodaj obraz do reklamy
    ad.imageUrl = 'https://images.unsplash.com/photo-1558618666-fcd25c85cd64?w=800&h=600&fit=crop';
    ad.mediaType = 'image';
    await ad.save();

    console.log('✅ Zaktualizowano reklamę:', ad.title);
    console.log('   Image URL:', ad.imageUrl);
    console.log('   Media Type:', ad.mediaType);

    await mongoose.disconnect();
  } catch (error) {
    console.error('❌ Błąd:', error);
    process.exit(1);
  }
}

fixFirstAd();






