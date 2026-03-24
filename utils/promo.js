exports.isActive = (date) => !!date && new Date(date) > new Date();

exports.getPromoBoost = (user) => {
  const now = new Date();
  let boost = 0;

  // Punkty rankingowe z aktywnego pakietu
  if (user?.promo?.rankBoostUntil && user.promo.rankBoostUntil > now) {
    boost += (user.promo.rankBoostPoints || 0);
  }

  return boost;
};
