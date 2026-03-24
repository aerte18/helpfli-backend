?const mongoose = require('mongoose');
const User = require('../models/User');
const UserSubscription = require('../models/UserSubscription');
const SubscriptionPlan = require('../models/SubscriptionPlan');

async function createProSubscription() {
  try {
    // Połącz z bazą danych
    await mongoose.connect(process.env.MONGO_URI || 'mongodb://mongo:27017/helpfli');
    console.log('Połączono z bazą danych');

    // Znajdź użytkownika Jan Kowalski
    const user = await User.findOne({ name: { $regex: /Jan.*Kowalski/i } });
    if (!user) {
      console.log('Nie znaleziono użytkownika Jan Kowalski');
      return;
    }
    console.log('Znaleziono użytkownika:', user.name, user.email);

    // Znajdź plan PRO dla providerów
    const proPlan = await SubscriptionPlan.findOne({ key: 'PROV_PRO' });
    if (!proPlan) {
      console.log('Nie znaleziono planu PROV_PRO');
      return;
    }
    console.log('Znaleziono plan PRO:', proPlan.name);

    // Sprawdź czy użytkownik już ma subskrypcję
    const existingSub = await UserSubscription.findOne({ user: user._id });
    if (existingSub) {
      console.log('Użytkownik już ma subskrypcję:', existingSub.planKey);
      // Usuń starą subskrypcję
      await UserSubscription.deleteOne({ _id: existingSub._id });
      console.log('Usunięto starą subskrypcję');
    }

    // Utwórz nową subskrypcję PRO
    const now = new Date();
    const validUntil = new Date(now);
    validUntil.setMonth(validUntil.getMonth() + 1); // Ważna przez miesiąc

    const subscription = new UserSubscription({
      user: user._id,
      planKey: 'PROV_PRO',
      startedAt: now,
      validUntil: validUntil,
      renews: true,
      freeExpressLeft: 0
    });

    await subscription.save();
    console.log('Utworzono subskrypcję PRO:', subscription);

    // Zaktualizuj poziom użytkownika na 'pro'
    await User.findByIdAndUpdate(user._id, { level: 'pro' });
    console.log('Zaktualizowano poziom użytkownika na PRO');

    console.log('✅ Subskrypcja PRO została utworzona pomyślnie!');
    console.log('Ważna do:', validUntil.toISOString());

  } catch (error) {
    console.error('Błąd:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Rozłączono z bazą danych');
  }
}

createProSubscription();
