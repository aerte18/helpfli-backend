?const express = require('express');
const router = express.Router();
const SponsorAd = require('../models/SponsorAd');
const SponsorImpression = require('../models/SponsorImpression');

/**
 * GET /pixel/:adId.gif
 * Pixel tracking - 1x1px transparent GIF
 * Automatycznie rejestruje konwersję typu 'purchase' gdy pixel jest załadowany
 */
router.get('/:adId', async (req, res) => {
  try {
    // Usuń rozszerzenie .gif z adId jeśli istnieje
    let adId = req.params.adId;
    if (adId.endsWith('.gif')) {
      adId = adId.slice(0, -4);
    }
    const { 
      type = 'purchase', // purchase, inquiry, signup, download, other
      value = 0, // Wartość konwersji w groszach (z query string)
      currency = 'pln',
      orderId, // ID zamówienia (z query string)
      productId // ID produktu (z query string)
    } = req.query;

    const ad = await SponsorAd.findById(adId);
    if (!ad) {
      // Zwróć pusty pixel nawet jeśli reklama nie istnieje (dla prywatności)
      return sendPixel(res);
    }

    // Sprawdź czy reklama jest aktywna
    if (!ad.isActive()) {
      return sendPixel(res);
    }

    // Zarejestruj konwersję
    try {
      const metadata = {};
      if (orderId) metadata.orderId = orderId;
      if (productId) metadata.productId = productId;
      if (req.query.metadata) {
        try {
          Object.assign(metadata, JSON.parse(req.query.metadata));
        } catch (e) {
          // Ignoruj błąd parsowania metadata
        }
      }

      await SponsorImpression.create({
        ad: adId,
        user: null, // Pixel tracking nie ma użytkownika
        type: 'conversion',
        date: new Date().toISOString().split('T')[0],
        context: {
          keywords: [],
          serviceCategory: null,
          orderType: null,
          location: null
        },
        conversion: {
          type: type,
          value: parseInt(value) || 0,
          currency: currency,
          metadata: metadata
        }
      });

      // Zaktualizuj statystyki reklamy
      ad.stats.conversions += 1;
      ad.stats.conversionRate = ad.stats.clicks > 0 
        ? (ad.stats.conversions / ad.stats.clicks) * 100 
        : 0;
      await ad.save();
    } catch (error) {
      // Loguj błąd, ale zwróć pixel (nie psuj strony firmy)
      console.error('Error recording conversion from pixel:', error);
    }

    // Zwróć 1x1px transparent GIF
    return sendPixel(res);
  } catch (error) {
    console.error('Error in pixel tracking:', error);
    // Zawsze zwróć pixel, nawet przy błędzie
    return sendPixel(res);
  }
});

/**
 * Funkcja pomocnicza do wysłania 1x1px transparent GIF
 */
function sendPixel(res) {
  // 1x1px transparent GIF (43 bytes)
  const pixel = Buffer.from(
    'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
    'base64'
  );
  
  res.setHeader('Content-Type', 'image/gif');
  res.setHeader('Content-Length', pixel.length);
  res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.send(pixel);
}

/**
 * GET /api/sponsor-ads/:id/pixel-code
 * Pobierz kod pixel tracking do wstawienia na stronę
 */
router.get('/:id/pixel-code', async (req, res) => {
  try {
    const ad = await SponsorAd.findById(req.params.id);
    if (!ad) {
      return res.status(404).json({ message: 'Reklama nie znaleziona' });
    }

    // Sprawdź uprawnienia (tylko właściciel reklamy lub admin)
    if (req.user && req.user.role !== 'admin' && ad.advertiser.email !== req.user.email) {
      return res.status(403).json({ message: 'Brak uprawnień' });
    }

    const baseUrl = process.env.FRONTEND_URL || process.env.API_URL || 'http://localhost:5003';
    const pixelUrl = `${baseUrl}/pixel/${ad._id}.gif`;

    // Kod HTML do wstawienia
    const htmlCode = `<!-- Helpfli Pixel Tracking -->
<img src="${pixelUrl}" width="1" height="1" style="display:none;" alt="" />
<!-- Koniec Helpfli Pixel -->`;

    // Kod JavaScript (dla zaawansowanych - z możliwością przekazania danych)
    const jsCode = `<!-- Helpfli Pixel Tracking (JavaScript) -->
<script>
(function() {
  var pixel = new Image();
  var params = new URLSearchParams();
  
  // Opcjonalnie: przekaż dane konwersji
  // params.append('type', 'purchase');
  // params.append('value', '10000'); // w groszach
  // params.append('orderId', 'ORDER_123');
  
  pixel.src = '${pixelUrl}' + (params.toString() ? '?' + params.toString() : '');
  pixel.width = 1;
  pixel.height = 1;
  pixel.style.display = 'none';
  document.body.appendChild(pixel);
})();
</script>
<!-- Koniec Helpfli Pixel -->`;

    // Kod dla różnych platform e-commerce
    const shopifyCode = `<!-- Helpfli Pixel Tracking dla Shopify -->
{% if first_time_accessed %}
  <img src="${pixelUrl}?type=purchase&value={{ checkout.total_price | times: 100 }}" 
       width="1" height="1" style="display:none;" alt="" />
{% endif %}`;

    const woocommerceCode = `<!-- Helpfli Pixel Tracking dla WooCommerce -->
<?php
if (is_order_received_page()) {
  $order = wc_get_order(get_query_var('order-received'));
  if ($order) {
    $total = $order->get_total() * 100; // w groszach
    echo '<img src="${pixelUrl}?type=purchase&value=' . $total . '&orderId=' . $order->get_id() . '" 
         width="1" height="1" style="display:none;" alt="" />';
  }
}
?>`;

    res.json({
      success: true,
      pixelUrl: pixelUrl,
      codes: {
        html: htmlCode,
        javascript: jsCode,
        shopify: shopifyCode,
        woocommerce: woocommerceCode
      },
      instructions: {
        basic: 'Wstaw kod HTML na stronę potwierdzenia zamówienia (thank you page)',
        advanced: 'Użyj kodu JavaScript, jeśli chcesz przekazać dodatkowe dane (wartość zamówienia, ID produktu, itp.)',
        shopify: 'Wstaw kod w pliku checkout.liquid w sekcji {% if first_time_accessed %}',
        woocommerce: 'Wstaw kod w pliku functions.php lub w szablonie strony potwierdzenia zamówienia'
      }
    });
  } catch (error) {
    console.error('Error fetching pixel code:', error);
    res.status(500).json({ message: 'Błąd pobierania kodu pixel', error: error.message });
  }
});

module.exports = router;






