const mjmlPkg = require("mjml");
// mjml bywa eksportowane jako default albo jako obiekt z `mjml2html` — wspieramy oba przypadki
const mjml2html = mjmlPkg.mjml2html || mjmlPkg;

const APP_URL = process.env.APP_URL || "http://localhost:5174";

function render(mjml) {
  const { html } = mjml2html(mjml, { keepComments: false, beautify: false, minify: true });
  return html;
}

function tplOfferNew({ orderId, amount }) {
  const link = `${APP_URL}/orders/${orderId}`;
  const mjml = `
<mjml>
  <mj-head>
    <mj-attributes>
      <mj-text font-family="Inter, Arial" />
      <mj-button background-color="#111111" color="#ffffff" border-radius="12px" />
    </mj-attributes>
  </mj-head>
  <mj-body background-color="#f6f7f9">
    <mj-section>
      <mj-column>
        <mj-text font-size="20px" font-weight="700">Nowa oferta do Twojego zlecenia</mj-text>
        <mj-text>Otrzymałeś nową ofertę: <strong>${amount} zł</strong>.</mj-text>
        <mj-button href="${link}">Zobacz oferty</mj-button>
        <mj-text font-size="12px" color="#888888">Helpfli – Gwarancja tylko przy komunikacji i płatnościach w systemie.</mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;
  return render(mjml);
}

function tplOfferAccepted({ orderId, amount }) {
  const link = `${APP_URL}/orders/${orderId}`;
  const mjml = `
<mjml>
  <mj-head>
    <mj-attributes>
      <mj-text font-family="Inter, Arial" />
      <mj-button background-color="#111111" color="#ffffff" border-radius="12px" />
    </mj-attributes>
  </mj-head>
  <mj-body background-color="#f6f7f9">
    <mj-section>
      <mj-column>
        <mj-text font-size="20px" font-weight="700">Twoja oferta została zaakceptowana</mj-text>
        <mj-text>Gratulacje! Klient wybrał Twoją ofertę za <strong>${amount} zł</strong>.</mj-text>
        <mj-button href="${link}">Przejdź do zlecenia</mj-button>
        <mj-text font-size="12px" color="#888888">Helpfli – dbamy o bezpieczeństwo transakcji.</mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;
  return render(mjml);
}

function tplVerifiedGranted({ providerName }) {
  const mjml = `
<mjml>
  <mj-body background-color="#f6f7f9">
    <mj-section>
      <mj-column>
        <mj-text font-size="20px" font-weight="700">Status: Verified / KYC</mj-text>
        <mj-text>Gratulacje, ${providerName}! Twój profil został zweryfikowany. Otrzymałeś odznakę <strong>Verified</strong>.</mj-text>
        <mj-text font-size="12px" color="#888888">Wyszukiwanie promuje zweryfikowanych wykonawców.</mj-text>
      </mj-column>
    </mj-section>
  </mj-body>
</mjml>`;
  return render(mjml);
}

module.exports = {
  tplOfferNew,
  tplOfferAccepted,
  tplVerifiedGranted,
};



