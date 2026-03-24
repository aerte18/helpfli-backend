const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const SponsorAd = require('../models/SponsorAd');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);

// POST /api/sponsor-ads/:id/pay - Zapłać za reklamę
router.post('/:id/pay', authMiddleware, async (req, res) => {
  try {
    const { paymentMethod, amount } = req.body;
    const ad = await SponsorAd.findById(req.params.id);
    
    if (!ad) {
      return res.status(404).json({ message: 'Reklama nie znaleziona' });
    }

    // Sprawdź uprawnienia
    if (req.user.role !== 'admin' && ad.advertiser.email !== req.user.email) {
      return res.status(403).json({ message: 'Brak uprawnień' });
    }

    // Sprawdź czy reklama wymaga płatności
    if (ad.status === 'active' && ad.campaign.spent < ad.campaign.budget) {
      return res.status(400).json({ 
        message: 'Reklama jest już aktywna i ma wystarczający budżet' 
      });
    }

    // Utwórz PaymentIntent w Stripe
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amount || ad.campaign.budget, // Kwota w groszach
      currency: 'pln',
      payment_method_types: ['card', 'p24', 'blik'],
      metadata: {
        adId: String(ad._id),
        advertiserEmail: ad.advertiser.email,
        type: 'sponsor_ad_payment'
      },
      description: `Płatność za reklamę: ${ad.title}`
    });

    res.json({
      clientSecret: paymentIntent.client_secret,
      paymentIntentId: paymentIntent.id
    });
  } catch (error) {
    console.error('Error creating payment:', error);
    res.status(500).json({ message: 'Błąd tworzenia płatności', error: error.message });
  }
});

// POST /api/sponsor-ads/:id/activate - Aktywuj reklamę po płatności
router.post('/:id/activate', authMiddleware, async (req, res) => {
  try {
    const { paymentIntentId } = req.body;
    const ad = await SponsorAd.findById(req.params.id);
    
    if (!ad) {
      return res.status(404).json({ message: 'Reklama nie znaleziona' });
    }

    // Sprawdź uprawnienia
    if (req.user.role !== 'admin' && ad.advertiser.email !== req.user.email) {
      return res.status(403).json({ message: 'Brak uprawnień' });
    }

    // Zweryfikuj płatność w Stripe
    const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);
    
    if (paymentIntent.status !== 'succeeded') {
      return res.status(400).json({ 
        message: 'Płatność nie została zakończona pomyślnie' 
      });
    }

    // Aktywuj reklamę
    ad.status = 'active';
    ad.campaign.spent = 0; // Reset wydatków (nowa płatność)
    ad.payment = {
      paymentIntentId: paymentIntentId,
      amount: paymentIntent.amount,
      currency: paymentIntent.currency,
      paidAt: new Date()
    };
    await ad.save();

    res.json({ success: true, ad });
  } catch (error) {
    console.error('Error activating ad:', error);
    res.status(500).json({ message: 'Błąd aktywacji reklamy', error: error.message });
  }
});

module.exports = router;






