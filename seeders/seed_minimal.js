?require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');
const Service = require('../models/Service');

(async () => {
  await mongoose.connect(process.env.MONGO_URI);

  await Service.deleteMany({});
  await User.deleteMany({ email: { $in: ['pro1@helpfli.test','pro2@helpfli.test'] } });

  const s1 = await Service.create({ name: 'Hydraulik – naprawa kranu', code: 'hydro_fix_tap' });
  const s2 = await Service.create({ name: 'Elektryk – montaż gniazdka', code: 'elec_socket' });

  const pro1 = await User.create({
    name: 'Jan Pro',
    email: 'pro1@helpfli.test',
    password: 'Haslo!123',
    role: 'provider',
    kycStatus: 'verified', // dodaj, jeśli masz to pole; w KYC wprowadzimy
    services: [s1._id, s2._id],
  });

  const pro2 = await User.create({
    name: 'Anna Tech',
    email: 'pro2@helpfli.test',
    password: 'Haslo!123',
    role: 'provider',
    kycStatus: 'verified',
    services: [s1._id],
  });

  console.log('Seed done:', { services: [s1.name, s2.name], providers: [pro1.email, pro2.email] });
  await mongoose.disconnect();
  process.exit(0);
})();
