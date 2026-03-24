?require('dotenv').config();
const path = require('path');
const mongoose = require('mongoose');
const Offer = require(path.join(__dirname, '../models/Offer'));
const User = require(path.join(__dirname, '../models/User'));

async function main() {
  const uri = process.env.MONGO_URI || 'mongodb://127.0.0.1:27017/helpfli';
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 7000 });

  const provider = await User.findOne({ role: 'provider' }).lean();
  if (!provider) {
    console.log('Brak providera');
    await mongoose.disconnect();
    return;
  }

  const offers = await Offer.find({ providerId: provider._id }).sort({ createdAt: -1 }).lean();
  console.log(`Liczba ofert dla ${provider.email}: ${offers.length}`);
  
  offers.forEach((o, i) => {
    console.log(`${i+1}. Kwota: ${o.amount} zł, Status: ${o.status}, Data: ${new Date(o.createdAt).toLocaleString('pl-PL')}`);
  });

  await mongoose.disconnect();
}

main().catch(console.error);

