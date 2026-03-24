?require('dotenv').config();
const mongoose = require('mongoose');
const SponsorAd = require('../models/SponsorAd');

async function checkAds() {
  try {
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://localhost:27017/helpfli');
    console.log('✅ Połączono z bazą danych\n');

    const now = new Date();
    
    // Wszystkie reklamy
    const allAds = await SponsorAd.find({}).lean();
    console.log(`📊 Wszystkie reklamy w bazie: ${allAds.length}\n`);

    // Aktywne reklamy
    const activeAds = await SponsorAd.find({
      status: 'active',
      'campaign.startDate': { $lte: now },
      'campaign.endDate': { $gte: now }
    }).lean();
    
    console.log(`✅ Aktywne reklamy (status=active, w przedziale czasowym): ${activeAds.length}\n`);

    activeAds.forEach((ad, i) => {
      console.log(`\n--- Reklama ${i + 1} ---`);
      console.log(`ID: ${ad._id}`);
      console.log(`Tytuł: ${ad.title}`);
      console.log(`Status: ${ad.status}`);
      console.log(`Media Type: ${ad.mediaType || 'brak'}`);
      console.log(`Video URL: ${ad.videoUrl || 'BRAK'}`);
      console.log(`Image URL: ${ad.imageUrl || 'BRAK'}`);
      console.log(`Display Locations: ${ad.displayLocations?.length || 0} - [${ad.displayLocations?.join(', ') || 'BRAK'}]`);
      console.log(`Priority: ${ad.priority || 0}`);
      console.log(`Package: ${ad.package || 'brak'}`);
      console.log(`Budget: ${ad.campaign?.budget || 0} groszy (${((ad.campaign?.budget || 0) / 100).toFixed(2)} zł)`);
      console.log(`Spent: ${ad.campaign?.spent || 0} groszy`);
      console.log(`Monthly Limit: ${ad.campaign?.monthlyLimit || 'brak'}`);
      console.log(`Keywords: ${ad.keywords?.join(', ') || 'brak'}`);
      console.log(`Start Date: ${ad.campaign?.startDate ? new Date(ad.campaign.startDate).toLocaleString('pl-PL') : 'brak'}`);
      console.log(`End Date: ${ad.campaign?.endDate ? new Date(ad.campaign.endDate).toLocaleString('pl-PL') : 'brak'}`);
    });

    // Sprawdź czy są jakieś problemy
    console.log('\n\n🔍 DIAGNOSTYKA:');
    
    const adsWithoutDisplayLocations = activeAds.filter(ad => !ad.displayLocations || ad.displayLocations.length === 0);
    if (adsWithoutDisplayLocations.length > 0) {
      console.log(`⚠️ Reklamy bez displayLocations: ${adsWithoutDisplayLocations.length}`);
    }
    
    const adsWithoutMedia = activeAds.filter(ad => !ad.imageUrl && !ad.videoUrl);
    if (adsWithoutMedia.length > 0) {
      console.log(`⚠️ Reklamy bez obrazu/wideo: ${adsWithoutMedia.length}`);
    }
    
    const adsWithExpiredBudget = activeAds.filter(ad => (ad.campaign?.spent || 0) >= (ad.campaign?.budget || 0));
    if (adsWithExpiredBudget.length > 0) {
      console.log(`⚠️ Reklamy z wyczerpanym budżetem: ${adsWithExpiredBudget.length}`);
    }

    await mongoose.disconnect();
  } catch (error) {
    console.error('❌ Błąd:', error);
    process.exit(1);
  }
}

checkAds();






