const Order = require("../models/Order");

// proste regexy na tel. i e-mail
const phoneRegex = /(?:\+?\d{1,3}[\s\-\.]?)?(?:\(?\d{2,3}\)?[\s\-\.]?)?(?:\d[\s\-\.]?){7,}/i;
const emailRegex = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

module.exports = async function chatGuard(req, res, next) {
  try {
    const { orderId, text } = req.body;
    if (!orderId || typeof text !== "string") return next();

    const order = await Order.findById(orderId).select("status");
    if (!order) return res.status(404).json({ message: "Zlecenie nie istnieje" });

    // jeśli nie zaakceptowane — maskuj wzmianki o numerach i mailach
    if (order.status !== "accepted") {
      let moderated = text;
      const hadPhone = phoneRegex.test(text);
      const hadEmail = emailRegex.test(text);

      if (hadPhone) moderated = moderated.replace(/\d/g, "•"); // zamiana cyfr na kropki
      if (hadEmail) moderated = moderated.replace(emailRegex, "•••@•••.••");

      req.body.text = moderated;
      req.body._moderation = { hadPhone, hadEmail, masked: hadPhone || hadEmail };
    }
    next();
  } catch (e) {
    console.error("chatGuard error", e);
    next();
  }
};





