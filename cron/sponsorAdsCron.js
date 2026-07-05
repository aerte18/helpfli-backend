/**
 * Cron job do automatycznego zarządzania reklamami sponsorowanymi
 * - Sprawdzanie dat końca kampanii
 * - Automatyczne wygaszanie reklam
 * - Sprawdzanie budżetu
 * - Powiadomienia o końcu kampanii
 */

const SponsorAd = require('../models/SponsorAd');
const { sendMail } = require('../utils/mailer');
const { getFrontendUrl } = require('../utils/publicUrl');
const { createSponsorAdRenewalPaymentIntent } = require('../services/sponsorAdPaymentService');
const FRONTEND = getFrontendUrl();

/**
 * Sprawdź i zaktualizuj status reklam
 * Uruchamiane co godzinę
 */
async function checkSponsorAdsStatus() {
  try {
    const now = new Date();
    
    // Znajdź reklamy, które powinny być wygaszone
    const expiredAds = await SponsorAd.find({
      status: 'active',
      $or: [
        { 'campaign.endDate': { $lt: now } },
        { $expr: { $gte: ['$campaign.spent', '$campaign.budget'] } },
      ],
    });

    for (const ad of expiredAds) {
      // Sprawdź czy data końca minęła
      if (ad.campaign.endDate < now) {
        ad.status = 'expired';
        await ad.save();
        
        // Wyślij email do firmy
        await sendExpirationEmail(ad, 'date');
      }
      
      // Sprawdź czy budżet został wyczerpany
      if (ad.campaign.spent >= ad.campaign.budget) {
        ad.status = 'expired';
        await ad.save();
        
        // Wyślij email do firmy
        await sendExpirationEmail(ad, 'budget');
      }
    }

    // Znajdź reklamy, które wkrótce się kończą (3 dni przed końcem)
    const soonToExpire = await SponsorAd.find({
      status: 'active',
      'campaign.endDate': {
        $gte: now,
        $lte: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000) // 3 dni
      },
      'campaign.notificationSent': { $ne: true }
    });

    for (const ad of soonToExpire) {
      await sendExpirationWarningEmail(ad);
      ad.campaign.notificationSent = true;
      await ad.save();
    }

    // Sprawdź darmowe próby, które się kończą
    const expiringTrials = await SponsorAd.find({
      status: 'active',
      'freeTrial.isFreeTrial': true,
      'freeTrial.convertedToPackage': false,
      $or: [
        { 'freeTrial.trialEndDate': { $lte: new Date(now.getTime() + 24 * 60 * 60 * 1000) } },
        { $expr: { $gte: ['$freeTrial.trialImpressionsUsed', '$freeTrial.trialImpressionsLimit'] } },
      ],
      'freeTrial.conversionOfferSent': false
    });

    for (const ad of expiringTrials) {
      await sendFreeTrialConversionOffer(ad);
      ad.freeTrial.conversionOfferSent = true;
      await ad.save();
    }

    // Wygaś darmowe próby, które się skończyły
    const expiredTrials = await SponsorAd.find({
      status: 'active',
      'freeTrial.isFreeTrial': true,
      'freeTrial.convertedToPackage': false,
      $or: [
        { 'freeTrial.trialEndDate': { $lt: now } },
        { $expr: { $gte: ['$freeTrial.trialImpressionsUsed', '$freeTrial.trialImpressionsLimit'] } }
      ]
    });

    for (const ad of expiredTrials) {
      ad.status = 'expired';
      await ad.save();
      await sendFreeTrialExpiredEmail(ad);
    }

    // Sprawdź kampanie z włączonym auto-renew (3 dni przed końcem)
    const autoRenewAds = await SponsorAd.find({
      status: 'active',
      'campaign.autoRenew': true,
      'campaign.endDate': {
        $gte: now,
        $lte: new Date(now.getTime() + 3 * 24 * 60 * 60 * 1000) // 3 dni przed końcem
      },
      'freeTrial.isFreeTrial': { $ne: true } // Tylko płatne kampanie
    });

    let renewalOffersSent = 0;
    for (const ad of autoRenewAds) {
      try {
        if (ad.campaign.renewalPaymentOfferSent && ad.campaign.renewalPendingPaymentIntentId) {
          continue;
        }

        const renewalCost = ad.campaign.budget;
        const intent = await createSponsorAdRenewalPaymentIntent(ad);
        const checkoutUrl = `${FRONTEND}/checkout?pi=${encodeURIComponent(intent.id)}&cs=${encodeURIComponent(intent.client_secret)}&type=sponsor_ad_renewal&adId=${encodeURIComponent(String(ad._id))}`;

        ad.campaign.renewalPendingPaymentIntentId = intent.id;
        ad.campaign.renewalPaymentOfferSent = true;
        await ad.save();

        await sendAutoRenewalPaymentRequiredEmail(ad, checkoutUrl, renewalCost);
        renewalOffersSent++;

        console.log(`[Cron] Wysłano link płatności za przedłużenie kampanii ${ad.title} (ID: ${ad._id})`);
      } catch (error) {
        console.error(`[Cron] Błąd przygotowania płatności za przedłużenie ${ad._id}:`, error);
        try {
          await sendAutoRenewalFailedEmail(ad);
        } catch (mailErr) {
          console.error('[Cron] Błąd emaila o nieudanym renew:', mailErr);
        }
      }
    }

    console.log(`[Cron] Sprawdzono reklamy: ${expiredAds.length} wygasło, ${soonToExpire.length} wkrótce się kończy, ${expiringTrials.length} prób do konwersji, ${expiredTrials.length} prób wygasło, ${renewalOffersSent} ofert płatności za auto-renew`);
  } catch (error) {
    console.error('[Cron] Błąd sprawdzania reklam:', error);
  }
}

/**
 * Wyślij email o wygaśnięciu reklamy
 */
async function sendExpirationEmail(ad, reason) {
  try {
    const reasonText = reason === 'date' 
      ? 'Data końca kampanii minęła' 
      : 'Budżet kampanii został wyczerpany';

    await sendMail({
      to: ad.advertiser.email,
      subject: `Reklama "${ad.title}" została wygaszona`,
      html: `
        <h2>Twoja reklama została wygaszona</h2>
        <p>Witaj ${ad.advertiser.companyName},</p>
        <p>Twoja reklama "<strong>${ad.title}</strong>" została automatycznie wygaszona.</p>
        <p><strong>Powód:</strong> ${reasonText}</p>
        <p><strong>Statystyki kampanii:</strong></p>
        <ul>
          <li>Wyświetlenia: ${ad.stats.impressions}</li>
          <li>Kliknięcia: ${ad.stats.clicks}</li>
          <li>CTR: ${ad.stats.ctr.toFixed(2)}%</li>
          <li>Wydane: ${(ad.campaign.spent / 100).toFixed(2)} zł</li>
        </ul>
        <p>Możesz utworzyć nową reklamę w panelu zarządzania.</p>
        <p><a href="${FRONTEND}/sponsor-ads">Zarządzaj reklamami</a></p>
      `
    });
  } catch (error) {
    console.error('[Cron] Błąd wysyłania emaila:', error);
  }
}

/**
 * Wyślij ostrzeżenie o zbliżającym się końcu kampanii
 */
async function sendExpirationWarningEmail(ad) {
  try {
    const daysLeft = Math.ceil((ad.campaign.endDate - new Date()) / (1000 * 60 * 60 * 24));

    await sendMail({
      to: ad.advertiser.email,
      subject: `Reklama "${ad.title}" kończy się za ${daysLeft} ${daysLeft === 1 ? 'dzień' : 'dni'}`,
      html: `
        <h2>Twoja reklama kończy się wkrótce</h2>
        <p>Witaj ${ad.advertiser.companyName},</p>
        <p>Twoja reklama "<strong>${ad.title}</strong>" kończy się za <strong>${daysLeft} ${daysLeft === 1 ? 'dzień' : 'dni'}</strong>.</p>
        <p><strong>Data końca:</strong> ${ad.campaign.endDate.toLocaleDateString('pl-PL')}</p>
        <p><strong>Pozostały budżet:</strong> ${((ad.campaign.budget - ad.campaign.spent) / 100).toFixed(2)} zł</p>
        <p>Jeśli chcesz przedłużyć kampanię, możesz to zrobić w panelu zarządzania.</p>
        <p><a href="${FRONTEND}/sponsor-ads">Zarządzaj reklamami</a></p>
      `
    });
  } catch (error) {
    console.error('[Cron] Błąd wysyłania ostrzeżenia:', error);
  }
}

/**
 * Wyślij ofertę konwersji z darmowej próby do pakietu
 */
async function sendFreeTrialConversionOffer(ad) {
  try {
    const daysLeft = Math.ceil((ad.freeTrial.trialEndDate - new Date()) / (1000 * 60 * 60 * 24));
    const impressionsLeft = ad.freeTrial.trialImpressionsLimit - ad.freeTrial.trialImpressionsUsed;

    await sendMail({
      to: ad.advertiser.email,
      subject: `🎁 Specjalna oferta: 20% zniżki na pakiet reklamowy!`,
      html: `
        <h2>Twoja darmowa próba kończy się wkrótce!</h2>
        <p>Witaj ${ad.advertiser.companyName},</p>
        <p>Twoja darmowa próba reklamy "<strong>${ad.title}</strong>" kończy się za <strong>${daysLeft} ${daysLeft === 1 ? 'dzień' : 'dni'}</strong>.</p>
        <p><strong>Statystyki próby:</strong></p>
        <ul>
          <li>Wyświetlenia: ${ad.freeTrial.trialImpressionsUsed} / ${ad.freeTrial.trialImpressionsLimit}</li>
          <li>Kliknięcia: ${ad.stats.clicks}</li>
          <li>CTR: ${ad.stats.ctr.toFixed(2)}%</li>
        </ul>
        <div style="background: #f0f9ff; border: 2px solid #0ea5e9; border-radius: 8px; padding: 20px; margin: 20px 0;">
          <h3 style="color: #0ea5e9; margin-top: 0;">🎁 Specjalna oferta: 20% zniżki!</h3>
          <p>Wykup pakiet w ciągu 7 dni i otrzymaj <strong>20% zniżki</strong> na pierwszy miesiąc!</p>
          <p><strong>Dostępne pakiety:</strong></p>
          <ul>
            <li><strong>Starter:</strong> 299 zł/mies. → <span style="color: #0ea5e9;">239 zł/mies.</span> (zniżka 20%)</li>
            <li><strong>Premium:</strong> 799 zł/mies. → <span style="color: #0ea5e9;">639 zł/mies.</span> (zniżka 20%)</li>
            <li><strong>Enterprise:</strong> 1999 zł/mies. → <span style="color: #0ea5e9;">1599 zł/mies.</span> (zniżka 20%)</li>
          </ul>
        </div>
        <p><a href="${FRONTEND}/sponsor-ads?offer=20percent" style="display: inline-block; background: #0ea5e9; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Wykup pakiet z 20% zniżką →</a></p>
        <p style="color: #666; font-size: 12px; margin-top: 20px;">Oferta ważna przez 7 dni od zakończenia próby.</p>
      `
    });
  } catch (error) {
    console.error('[Cron] Błąd wysyłania oferty konwersji:', error);
  }
}

/**
 * Wyślij email o wygaśnięciu darmowej próby
 */
async function sendFreeTrialExpiredEmail(ad) {
  try {
    await sendMail({
      to: ad.advertiser.email,
      subject: `Twoja darmowa próba dobiegła końca`,
      html: `
        <h2>Darmowa próba zakończona</h2>
        <p>Witaj ${ad.advertiser.companyName},</p>
        <p>Twoja darmowa próba reklamy "<strong>${ad.title}</strong>" dobiegła końca.</p>
        <p><strong>Statystyki próby:</strong></p>
        <ul>
          <li>Wyświetlenia: ${ad.freeTrial.trialImpressionsUsed} / ${ad.freeTrial.trialImpressionsLimit}</li>
          <li>Kliknięcia: ${ad.stats.clicks}</li>
          <li>CTR: ${ad.stats.ctr.toFixed(2)}%</li>
        </ul>
        <p>Dziękujemy za wypróbowanie Helpfli! Jeśli chcesz kontynuować reklamę, możesz wykupić jeden z naszych pakietów.</p>
        <p><a href="${FRONTEND}/sponsor-ads">Zobacz dostępne pakiety →</a></p>
      `
    });
  } catch (error) {
    console.error('[Cron] Błąd wysyłania emaila o wygaśnięciu próby:', error);
  }
}

/**
 * Wyślij email z linkiem do opłacenia przedłużenia kampanii
 */
async function sendAutoRenewalPaymentRequiredEmail(ad, checkoutUrl, renewalCostGrosze) {
  try {
    const renewalPeriod = ad.campaign.renewalPeriod || 30;
    await sendMail({
      to: ad.advertiser.email,
      subject: `Opłać przedłużenie kampanii "${ad.title}"`,
      html: `
        <h2>Automatyczne przedłużenie kampanii</h2>
        <p>Witaj ${ad.advertiser.companyName},</p>
        <p>Twoja kampania "<strong>${ad.title}</strong>" kończy się za kilka dni. Włączone jest automatyczne przedłużanie — opłać kolejny okres, aby kampania działała bez przerwy.</p>
        <p><strong>Kwota:</strong> ${(renewalCostGrosze / 100).toFixed(2)} zł</p>
        <p><strong>Okres przedłużenia:</strong> ${renewalPeriod} dni</p>
        <p><strong>Obecna data końca:</strong> ${ad.campaign.endDate.toLocaleDateString('pl-PL')}</p>
        <p><a href="${checkoutUrl}" style="display: inline-block; background: #0ea5e9; color: white; padding: 12px 24px; text-decoration: none; border-radius: 6px; font-weight: bold;">Opłać przedłużenie →</a></p>
        <p style="color: #666; font-size: 12px;">Bez opłaty kampania wygaśnie po bieżącej dacie końca.</p>
      `
    });
  } catch (error) {
    console.error('[Cron] Błąd wysyłania emaila o płatności za renew:', error);
  }
}

/**
 * Wyślij email o automatycznym przedłużeniu kampanii (po opłaceniu)
 */
async function sendAutoRenewalEmail(ad, renewalPeriod) {
  try {
    await sendMail({
      to: ad.advertiser.email,
      subject: `✅ Kampania "${ad.title}" została automatycznie przedłużona`,
      html: `
        <h2>Twoja kampania została przedłużona</h2>
        <p>Witaj ${ad.advertiser.companyName},</p>
        <p>Twoja kampania "<strong>${ad.title}</strong>" została automatycznie przedłużona o <strong>${renewalPeriod} dni</strong>.</p>
        <p><strong>Nowa data końca:</strong> ${ad.campaign.endDate.toLocaleDateString('pl-PL')}</p>
        <p><strong>Liczba przedłużeń:</strong> ${ad.campaign.renewalCount}</p>
        <p><strong>Statystyki kampanii:</strong></p>
        <ul>
          <li>Wyświetlenia: ${ad.stats.impressions}</li>
          <li>Kliknięcia: ${ad.stats.clicks}</li>
          <li>CTR: ${ad.stats.ctr.toFixed(2)}%</li>
          <li>Wydane: ${(ad.campaign.spent / 100).toFixed(2)} zł</li>
        </ul>
        <p>Kampania będzie kontynuowana automatycznie, dopóki nie wyłączysz opcji "Automatyczne przedłużanie" w panelu zarządzania.</p>
        <p><a href="${FRONTEND}/sponsor-ads">Zarządzaj reklamami</a></p>
      `
    });
  } catch (error) {
    console.error('[Cron] Błąd wysyłania emaila o przedłużeniu:', error);
  }
}

/**
 * Wyślij email o nieudanym przedłużeniu (brak środków)
 */
async function sendAutoRenewalFailedEmail(ad) {
  try {
    await sendMail({
      to: ad.advertiser.email,
      subject: `⚠️ Nie udało się przedłużyć kampanii "${ad.title}"`,
      html: `
        <h2>Nie udało się przedłużyć kampanii</h2>
        <p>Witaj ${ad.advertiser.companyName},</p>
        <p>Twoja kampania "<strong>${ad.title}</strong>" kończy się wkrótce, ale nie udało się jej automatycznie przedłużyć.</p>
        <p><strong>Powód:</strong> Brak wystarczających środków na przedłużenie kampanii.</p>
        <p><strong>Data końca:</strong> ${ad.campaign.endDate.toLocaleDateString('pl-PL')}</p>
        <p>Jeśli chcesz przedłużyć kampanię ręcznie, możesz to zrobić w panelu zarządzania.</p>
        <p><a href="${FRONTEND}/sponsor-ads">Zarządzaj reklamami</a></p>
      `
    });
  } catch (error) {
    console.error('[Cron] Błąd wysyłania emaila o nieudanym przedłużeniu:', error);
  }
}

module.exports = {
  checkSponsorAdsStatus,
  sendExpirationEmail,
  sendExpirationWarningEmail,
  sendFreeTrialConversionOffer,
  sendFreeTrialExpiredEmail,
  sendAutoRenewalPaymentRequiredEmail,
  sendAutoRenewalEmail,
  sendAutoRenewalFailedEmail
};

