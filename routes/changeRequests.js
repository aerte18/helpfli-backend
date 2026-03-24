?const express = require("express");
const router = express.Router();
const auth = require("../middleware/auth");
const logger = require("../utils/logger");
const ChangeRequest = require("../models/ChangeRequest");
const Order = require("../models/Order");
const Offer = require("../models/Offer");
const Payment = require("../models/Payment");
const User = require("../models/User");
const mongoose = require("mongoose");

/**
 * POST /api/orders/:orderId/change-request
 * Provider proponuje dopłatę do zaakceptowanego zlecenia
 */
router.post("/orders/:orderId/change-request", auth, async (req, res) => {
  try {
    const { orderId } = req.params;
    const { amount, reason, type = 'additional_work' } = req.body;
    
    if (!amount || amount <= 0) {
      return res.status(400).json({ message: "Kwota dopłaty musi być większa od 0" });
    }
    if (!reason || reason.trim().length < 10) {
      return res.status(400).json({ message: "Powód dopłaty musi mieć co najmniej 10 znaków" });
    }
    
    const order = await Order.findById(orderId)
      .populate('client', 'name email')
      .populate('provider', 'name email');
    
    if (!order) {
      return res.status(404).json({ message: "Zlecenie nie istnieje" });
    }
    
    // Sprawdź czy użytkownik jest providerem tego zlecenia
    if (String(order.provider) !== String(req.user._id)) {
      return res.status(403).json({ message: "Tylko wykonawca zlecenia może zaproponować dopłatę" });
    }
    
    // Sprawdź czy zlecenie jest w odpowiednim statusie (accepted, funded, in_progress)
    if (!['accepted', 'funded', 'in_progress'].includes(order.status)) {
      return res.status(400).json({ 
        message: "Dopłatę można zaproponować tylko dla zaakceptowanych zleceń" 
      });
    }
    
    // Sprawdź czy nie ma już oczekującej dopłaty dla tego zlecenia
    const existingPending = await ChangeRequest.findOne({
      orderId: order._id,
      status: 'pending'
    });
    
    if (existingPending) {
      return res.status(400).json({ 
        message: "Masz już oczekującą propozycję dopłaty. Poczekaj na odpowiedź klienta lub anuluj poprzednią." 
      });
    }
    
    // Znajdź zaakceptowaną ofertę
    const offer = await Offer.findById(order.acceptedOfferId);
    if (!offer) {
      return res.status(404).json({ message: "Nie znaleziono zaakceptowanej oferty" });
    }
    
    // Utwórz change request
    const changeRequest = await ChangeRequest.create({
      orderId: order._id,
      offerId: offer._id,
      providerId: req.user._id,
      clientId: order.client,
      amount: Number(amount),
      reason: reason.trim(),
      type,
      status: 'pending'
    });
    
    // Wyślij powiadomienia
    const { notifyChangeRequest } = require("../utils/notifier");
    await notifyChangeRequest({ 
      app: req.app, 
      changeRequestId: changeRequest._id,
      orderId: order._id,
      clientId: order.client
    });
    
    res.json({ 
      success: true,
      changeRequest,
      message: "Propozycja dopłaty została wysłana do klienta"
    });
  } catch (e) {
    logger.error("CREATE_CHANGE_REQUEST_ERROR:", {
      message: e.message,
      stack: e.stack,
      orderId: req.params?.orderId,
      userId: req.user?._id
    });
    res.status(500).json({ message: "Błąd tworzenia propozycji dopłaty" });
  }
});

/**
 * POST /api/change-requests/:id/accept
 * Klient akceptuje dopłatę
 */
router.post("/:id/accept", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body || {};
    
    const changeRequest = await ChangeRequest.findById(id)
      .populate('orderId')
      .populate('offerId');
    
    if (!changeRequest) {
      return res.status(404).json({ message: "Propozycja dopłaty nie istnieje" });
    }
    
    // Sprawdź uprawnienia
    if (String(changeRequest.clientId) !== String(req.user._id)) {
      return res.status(403).json({ message: "Tylko właściciel zlecenia może zaakceptować dopłatę" });
    }
    
    if (changeRequest.status !== 'pending') {
      return res.status(400).json({ message: "Ta propozycja dopłaty nie jest już aktywna" });
    }
    
    const order = changeRequest.orderId;
    
    // Jeśli płatność przez Helpfli - zwiększ escrow
    if (order.paymentMethod === 'system' && order.paymentId) {
      const payment = await Payment.findById(order.paymentId);
      if (payment && payment.status === 'held') {
        // TODO: Zwiększ kwotę w escrow przez Stripe
        // Na razie zapisz informację o dopłacie
        payment.extraAmount = (payment.extraAmount || 0) + changeRequest.amount;
        await payment.save();
      }
    }
    
    // Zaktualizuj change request
    changeRequest.status = 'accepted';
    changeRequest.respondedAt = new Date();
    if (message) changeRequest.clientMessage = message;
    await changeRequest.save();
    
    // Zaktualizuj zlecenie - dodaj dopłatę do ceny
    order.priceTotal = (order.priceTotal || 0) + changeRequest.amount;
    await order.save();
    
    // Wyślij powiadomienia
    const { notifyChangeRequestAccepted } = require("../utils/notifier");
    await notifyChangeRequestAccepted({ 
      app: req.app, 
      changeRequestId: changeRequest._id,
      orderId: order._id,
      providerId: changeRequest.providerId
    });
    
    res.json({ 
      success: true,
      changeRequest,
      message: "Dopłata została zaakceptowana"
    });
  } catch (e) {
    logger.error("ACCEPT_CHANGE_REQUEST_ERROR:", {
      message: e.message,
      stack: e.stack,
      changeRequestId: req.params?.id,
      userId: req.user?._id
    });
    res.status(500).json({ message: "Błąd akceptacji dopłaty" });
  }
});

/**
 * POST /api/change-requests/:id/reject
 * Klient odrzuca dopłatę
 */
router.post("/:id/reject", auth, async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body || {};
    
    const changeRequest = await ChangeRequest.findById(id)
      .populate('orderId');
    
    if (!changeRequest) {
      return res.status(404).json({ message: "Propozycja dopłaty nie istnieje" });
    }
    
    // Sprawdź uprawnienia
    if (String(changeRequest.clientId) !== String(req.user._id)) {
      return res.status(403).json({ message: "Tylko właściciel zlecenia może odrzucić dopłatę" });
    }
    
    if (changeRequest.status !== 'pending') {
      return res.status(400).json({ message: "Ta propozycja dopłaty nie jest już aktywna" });
    }
    
    // Zaktualizuj change request
    changeRequest.status = 'rejected';
    changeRequest.respondedAt = new Date();
    if (message) changeRequest.clientMessage = message;
    await changeRequest.save();
    
    // Wyślij powiadomienia
    const { notifyChangeRequestRejected } = require("../utils/notifier");
    await notifyChangeRequestRejected({ 
      app: req.app, 
      changeRequestId: changeRequest._id,
      orderId: changeRequest.orderId._id,
      providerId: changeRequest.providerId
    });
    
    res.json({ 
      success: true,
      changeRequest,
      message: "Dopłata została odrzucona"
    });
  } catch (e) {
    logger.error("REJECT_CHANGE_REQUEST_ERROR:", {
      message: e.message,
      stack: e.stack,
      changeRequestId: req.params?.id,
      userId: req.user?._id
    });
    res.status(500).json({ message: "Błąd odrzucenia dopłaty" });
  }
});

/**
 * GET /api/change-requests/order/:orderId
 * Pobierz change requests dla zlecenia
 */
router.get("/order/:orderId", auth, async (req, res) => {
  try {
    const { orderId } = req.params;
    
    const order = await Order.findById(orderId);
    if (!order) {
      return res.status(404).json({ message: "Zlecenie nie istnieje" });
    }
    
    // Sprawdź uprawnienia - tylko klient lub provider zlecenia
    const isClient = String(order.client) === String(req.user._id);
    const isProvider = String(order.provider) === String(req.user._id);
    
    if (!isClient && !isProvider) {
      return res.status(403).json({ message: "Brak uprawnień" });
    }
    
    const changeRequests = await ChangeRequest.find({ orderId: order._id })
      .sort({ createdAt: -1 })
      .lean();
    
    res.json({ changeRequests });
  } catch (e) {
    logger.error("GET_CHANGE_REQUESTS_ERROR:", {
      message: e.message,
      stack: e.stack,
      orderId: req.params?.orderId
    });
    res.status(500).json({ message: "Błąd pobierania dopłat" });
  }
});

module.exports = router;

