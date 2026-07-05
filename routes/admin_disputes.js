const express = require("express");
const mongoose = require("mongoose");
const { authMiddleware } = require("../middleware/authMiddleware");
const adminMiddleware = require("../middleware/adminMiddleware");
const Order = require("../models/Order");
const User = require("../models/User");

const router = express.Router();
router.use(authMiddleware, adminMiddleware);

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildDisputeFilter(tab) {
  const t = String(tab || "all").toLowerCase();
  if (t === "resolved") {
    return { disputeStatus: "resolved" };
  }
  if (t === "escalated") {
    return {
      disputeEscalatedAt: { $ne: null },
      $or: [
        { disputeStatus: { $in: ["reported", "refund_requested", "resolved", "closed"] } },
        { status: "disputed" },
      ],
    };
  }
  if (t === "open") {
    return {
      $or: [
        { disputeStatus: "reported" },
        { disputeStatus: "refund_requested" },
        {
          $and: [
            { status: "disputed" },
            { disputeStatus: { $nin: ["resolved", "closed"] } },
          ],
        },
      ],
    };
  }
  return {
    $or: [
      { disputeStatus: { $in: ["reported", "refund_requested", "resolved", "closed"] } },
      { status: "disputed" },
    ],
  };
}

/**
 * @param {string} tab
 * @param {string} qRaw
 * @returns {Promise<object>}
 */
async function buildMongoFilter(tab, qRaw) {
  const base = buildDisputeFilter(tab);
  const q = String(qRaw || "")
    .trim()
    .slice(0, 200);
  if (!q) return base;

  const or = [];
  if (mongoose.Types.ObjectId.isValid(q)) {
    const oid = new mongoose.Types.ObjectId(q);
    or.push({ _id: oid }, { client: oid }, { provider: oid });
  }

  const rx = new RegExp(escapeRegex(q), "i");
  const users = await User.find({ $or: [{ email: rx }, { name: rx }] })
    .select("_id")
    .lean();
  const userIds = users.map((u) => u._id);
  if (userIds.length) {
    or.push({ client: { $in: userIds } }, { provider: { $in: userIds } });
  }

  if (or.length === 0) {
    return { $and: [base, { _id: { $in: [] } }] };
  }
  return { $and: [base, { $or: or }] };
}

function mapOrderRow(o) {
  const st = o.disputeSettlement || {};
  return {
    _id: o._id,
    service: o.service,
    status: o.status,
    disputeStatus: o.disputeStatus,
    disputeReason: o.disputeReason || "",
    disputeReportedAt: o.disputeReportedAt,
    disputeMediationEndsAt: o.disputeMediationEndsAt,
    disputeEscalatedAt: o.disputeEscalatedAt,
    messageCount: Array.isArray(o.disputeMessages) ? o.disputeMessages.length : 0,
    settlement: {
      status: st.status || "none",
      amountPln: st.amountPln,
      refundMethod: st.refundMethod || null,
      refundProcessedAt: st.refundProcessedAt || null,
    },
    client: o.client
      ? { _id: o.client._id, name: o.client.name, email: o.client.email }
      : null,
    provider: o.provider
      ? { _id: o.provider._id, name: o.provider.name, email: o.provider.email }
      : null,
    updatedAt: o.updatedAt,
  };
}

function csvEscape(val) {
  const s = val == null ? "" : String(val);
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function rowToCsv(cols) {
  return cols.map(csvEscape).join(",") + "\r\n";
}

/**
 * GET /api/admin/disputes?tab=...&limit=&skip=&q=
 */
router.get("/", async (req, res) => {
  try {
    const tab = req.query.tab || "all";
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 30, 1), 100);
    const skip = Math.max(parseInt(req.query.skip, 10) || 0, 0);
    const filter = await buildMongoFilter(tab, req.query.q);

    const [total, rows] = await Promise.all([
      Order.countDocuments(filter),
      Order.find(filter)
        .sort({ disputeReportedAt: -1, updatedAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate("client", "name email")
        .populate("provider", "name email")
        .select(
          "service status disputeStatus disputeReason disputeReportedAt disputeMediationEndsAt disputeEscalatedAt disputeMessages disputeSettlement client provider createdAt updatedAt"
        )
        .lean(),
    ]);

    const items = rows.map(mapOrderRow);
    res.json({ ok: true, items, total, limit, skip, tab, q: String(req.query.q || "").trim().slice(0, 200) });
  } catch (e) {
    console.error("ADMIN_DISPUTES_LIST", e);
    res.status(500).json({ ok: false, message: "Błąd listy spraw" });
  }
});

/**
 * GET /api/admin/disputes/export?tab=&q=  — CSV (max 5000 wierszy)
 */
router.get("/export", async (req, res) => {
  try {
    const tab = req.query.tab || "all";
    const filter = await buildMongoFilter(tab, req.query.q);
    const cap = Math.min(Math.max(parseInt(req.query.limit, 10) || 3000, 1), 5000);

    const [exportTotal, rows] = await Promise.all([
      Order.countDocuments(filter),
      Order.find(filter)
        .sort({ disputeReportedAt: -1, updatedAt: -1 })
        .limit(cap)
        .populate("client", "name email")
        .populate("provider", "name email")
        .select(
          "service status disputeStatus disputeReason disputeReportedAt disputeMediationEndsAt disputeEscalatedAt disputeMessages disputeSettlement client provider updatedAt"
        )
        .lean(),
    ]);

    const header = [
      "orderId",
      "service",
      "orderStatus",
      "disputeStatus",
      "disputeReason",
      "reportedAt",
      "mediationEndsAt",
      "escalatedAt",
      "clientName",
      "clientEmail",
      "providerName",
      "providerEmail",
      "settlementStatus",
      "settlementAmountPln",
      "settlementRefundMethod",
      "refundProcessedAt",
      "messageCount",
      "updatedAt",
    ];

    let csv = "\ufeff" + rowToCsv(header);
    for (const o of rows) {
      const m = mapOrderRow(o);
      const st = m.settlement;
      csv += rowToCsv([
        String(m._id),
        m.service,
        m.status,
        m.disputeStatus,
        m.disputeReason,
        m.disputeReportedAt ? new Date(m.disputeReportedAt).toISOString() : "",
        m.disputeMediationEndsAt ? new Date(m.disputeMediationEndsAt).toISOString() : "",
        m.disputeEscalatedAt ? new Date(m.disputeEscalatedAt).toISOString() : "",
        m.client?.name || "",
        m.client?.email || "",
        m.provider?.name || "",
        m.provider?.email || "",
        st.status,
        st.amountPln != null ? Number(st.amountPln) : "",
        st.refundMethod || "",
        st.refundProcessedAt ? new Date(st.refundProcessedAt).toISOString() : "",
        m.messageCount,
        m.updatedAt ? new Date(m.updatedAt).toISOString() : "",
      ]);
    }

    const safeTab = String(tab).replace(/[^a-z0-9_-]/gi, "_");
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="admin-disputes-${safeTab}.csv"`);
    res.setHeader("X-Export-Total", String(exportTotal));
    res.setHeader("X-Export-Row-Count", String(rows.length));
    res.setHeader("X-Export-Cap", String(cap));
    res.setHeader("X-Export-Truncated", exportTotal > rows.length ? "1" : "0");
    res.send(csv);
  } catch (e) {
    console.error("ADMIN_DISPUTES_EXPORT", e);
    res.status(500).json({ ok: false, message: "Błąd eksportu CSV" });
  }
});

/**
 * GET /api/admin/disputes/:orderId — szczegóły sprawy
 */
router.get("/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).json({ ok: false, message: "Nieprawidłowe ID zlecenia" });
    }
    const order = await Order.findById(orderId)
      .populate("client", "name email")
      .populate("provider", "name email")
      .lean();
    if (!order) return res.status(404).json({ ok: false, message: "Nie znaleziono zlecenia" });
    res.json({ ok: true, order: mapOrderRow(order), disputeMessages: order.disputeMessages || [] });
  } catch (e) {
    console.error("ADMIN_DISPUTES_DETAIL", e);
    res.status(500).json({ ok: false, message: "Błąd pobierania sprawy" });
  }
});

/**
 * POST /api/admin/disputes/:orderId/close — zamknij spór (bez zwrotu Stripe)
 */
router.post("/:orderId/close", async (req, res) => {
  try {
    const { orderId } = req.params;
    const note = String(req.body?.note || "Zamknięte przez administratora").slice(0, 2000);
    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ ok: false, message: "Nie znaleziono zlecenia" });

    order.disputeStatus = "closed";
    order.disputeMessages = order.disputeMessages || [];
    order.disputeMessages.push({
      kind: "admin",
      body: note,
      createdAt: new Date(),
      authorRole: "admin",
    });
    if (order.status === "disputed") {
      order.status = order.clientCompletionStatus === "accepted" ? "completed" : "released";
    }
    await order.save();
    res.json({ ok: true, message: "Spór zamknięty", order: mapOrderRow(order.toObject()) });
  } catch (e) {
    console.error("ADMIN_DISPUTES_CLOSE", e);
    res.status(500).json({ ok: false, message: "Błąd zamykania sporu" });
  }
});

/**
 * POST /api/admin/disputes/:orderId/force-refund — admin wymusza zwrot (PLN)
 */
router.post("/:orderId/force-refund", async (req, res) => {
  try {
    const { applyDisputeSettlementRefund } = require("../utils/disputeSettlementRefund");
    const amountPln = Number(req.body?.amountPln);
    if (!Number.isFinite(amountPln) || amountPln < 0) {
      return res.status(400).json({ ok: false, message: "Nieprawidłowa kwota" });
    }

    const order = await Order.findById(req.params.orderId);
    if (!order) return res.status(404).json({ ok: false, message: "Nie znaleziono zlecenia" });

    const st = order.disputeSettlement || {};
    if (st.refundProcessedAt) {
      return res.status(409).json({ ok: false, message: "Zwrot dla tego zlecenia został już wykonany" });
    }

    const refundSummary = await applyDisputeSettlementRefund(order, amountPln, {
      idempotencyScope: `admin_${order._id}`,
    });
    if (!refundSummary.ok) {
      return res.status(400).json({ ok: false, message: refundSummary.message, code: refundSummary.code });
    }

    order.disputeSettlement = {
      ...st,
      status: "accepted",
      amountPln,
      refundProcessedAt: new Date(),
      refundAmountGrosze: refundSummary.amountGrosze,
      refundStripeRef: refundSummary.stripeRef || null,
      refundMethod: refundSummary.method,
      adminForced: true,
      adminForcedBy: req.user._id,
    };
    order.paymentStatus = refundSummary.orderPaymentStatus;
    if (refundSummary.orderPaymentSubStatus) {
      order.payment = order.payment || {};
      order.payment.status = refundSummary.orderPaymentSubStatus;
    }
    if (refundSummary.additionalPaymentStatus) {
      order.additionalPaymentStatus = refundSummary.additionalPaymentStatus;
    }
    order.disputeStatus = "resolved";
    order.disputeMessages = order.disputeMessages || [];
    order.disputeMessages.push({
      kind: "admin",
      body: `Administrator wykonał zwrot ${(refundSummary.amountGrosze / 100).toFixed(2)} PLN (${refundSummary.method}).`,
      createdAt: new Date(),
      authorRole: "admin",
    });
    await order.save();

    res.json({ ok: true, refund: refundSummary, order: mapOrderRow(order.toObject()) });
  } catch (e) {
    console.error("ADMIN_DISPUTES_FORCE_REFUND", e);
    res.status(500).json({ ok: false, message: "Błąd wymuszonego zwrotu" });
  }
});

module.exports = router;
