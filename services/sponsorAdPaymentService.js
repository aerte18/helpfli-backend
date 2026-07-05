const SponsorAd = require('../models/SponsorAd');

const stripe = process.env.STRIPE_SECRET_KEY
  ? require('stripe')(process.env.STRIPE_SECRET_KEY)
  : null;

/**
 * Aktywacja reklamy sponsorowanej po payment_intent.succeeded (idempotentne).
 */
async function fulfillSponsorAdPaymentFromWebhook(intent) {
  const md = intent.metadata || {};
  if (md.type !== 'sponsor_ad_payment') return false;

  const adId = md.adId;
  if (!adId) return false;

  const ad = await SponsorAd.findById(adId);
  if (!ad) return false;

  if (
    ad.payment?.paymentIntentId === intent.id &&
    ad.status === 'active'
  ) {
    return true;
  }

  if (intent.status !== 'succeeded') return false;
  if (String(md.adId) !== String(ad._id)) return false;
  if (intent.amount < (ad.campaign?.budget || 0)) return false;

  ad.status = 'active';
  ad.campaign.spent = 0;
  ad.payment = {
    paymentIntentId: intent.id,
    amount: intent.amount,
    currency: intent.currency,
    paidAt: new Date(),
    status: 'succeeded',
  };
  await ad.save();
  return true;
}

/**
 * Utwórz PaymentIntent na przedłużenie kampanii (auto-renew wymaga opłaty).
 */
async function createSponsorAdRenewalPaymentIntent(ad) {
  if (!stripe) {
    throw new Error('Stripe nie jest skonfigurowany');
  }
  const amount = ad.campaign?.budget || 0;
  if (amount <= 0) {
    throw new Error('Brak budżetu kampanii do przedłużenia');
  }

  return stripe.paymentIntents.create({
    amount,
    currency: ad.payment?.currency || 'pln',
    payment_method_types: ['card', 'p24', 'blik'],
    metadata: {
      type: 'sponsor_ad_renewal',
      adId: String(ad._id),
      advertiserEmail: ad.advertiser?.email || '',
    },
    description: `Przedłużenie kampanii reklamowej: ${ad.title}`,
  });
}

/**
 * Po opłaceniu PI przedłuż kampanię (idempotentne).
 */
async function fulfillSponsorAdRenewalFromWebhook(intent) {
  const md = intent.metadata || {};
  if (md.type !== 'sponsor_ad_renewal') return false;

  const adId = md.adId;
  if (!adId || intent.status !== 'succeeded') return false;

  const ad = await SponsorAd.findById(adId);
  if (!ad) return false;

  if (ad.payment?.lastRenewalPaymentIntentId === intent.id) {
    return true;
  }
  if (intent.amount < (ad.campaign?.budget || 0)) return false;

  const renewalPeriod = ad.campaign?.renewalPeriod || 30;
  const baseMs = Math.max(Date.now(), ad.campaign.endDate?.getTime() || Date.now());
  ad.campaign.endDate = new Date(baseMs + renewalPeriod * 24 * 60 * 60 * 1000);
  ad.campaign.spent = 0;
  ad.campaign.renewalCount = (ad.campaign.renewalCount || 0) + 1;
  ad.campaign.notificationSent = false;
  ad.campaign.renewalPendingPaymentIntentId = null;
  ad.campaign.renewalPaymentOfferSent = false;
  ad.status = 'active';
  ad.payment = {
    ...(ad.payment || {}),
    paymentIntentId: intent.id,
    amount: intent.amount,
    currency: intent.currency,
    paidAt: new Date(),
    status: 'succeeded',
    lastRenewalPaymentIntentId: intent.id,
  };
  await ad.save();
  return true;
}

module.exports = {
  fulfillSponsorAdPaymentFromWebhook,
  createSponsorAdRenewalPaymentIntent,
  fulfillSponsorAdRenewalFromWebhook,
};
