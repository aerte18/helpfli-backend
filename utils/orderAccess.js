const mongoose = require('mongoose');

async function companyTeamHasOrderProvider(companyId, orderProviderId) {
  if (!companyId || !orderProviderId) return false;
  const Company = require('../models/Company');
  const company = await Company.findById(companyId).lean();
  if (!company) return false;
  const pid = String(orderProviderId);
  const memberIds = [
    company.owner?.toString(),
    ...(company.managers || []).map((m) => m.toString()),
    ...(company.providers || []).map((p) => p.toString()),
  ].filter(Boolean);
  return memberIds.includes(pid);
}

/**
 * Klient, przypisany wykonawca lub członek firmy wykonawcy.
 */
async function getOrderPartyAccess(order, user) {
  if (!order || !user?._id) {
    return { ok: false, isClient: false, isProvider: false, side: null };
  }
  const uid = String(user._id);
  const clientId = String(order.client?._id || order.client);
  const providerId = order.provider ? String(order.provider._id || order.provider) : null;

  if (clientId === uid) {
    return { ok: true, isClient: true, isProvider: false, side: 'client' };
  }
  if (providerId && providerId === uid) {
    return { ok: true, isClient: false, isProvider: true, side: 'provider' };
  }
  if (user.company && providerId && (await companyTeamHasOrderProvider(user.company, providerId))) {
    return { ok: true, isClient: false, isProvider: true, side: 'provider' };
  }
  if (user.role === 'admin' || user.role === 'superadmin') {
    return { ok: true, isClient: false, isProvider: false, side: 'admin' };
  }
  return { ok: false, isClient: false, isProvider: false, side: null };
}

async function getOrderPartySide(order, user) {
  const access = await getOrderPartyAccess(order, user);
  return access.side;
}

async function userCanAccessOrderSensitive(order, user) {
  const access = await getOrderPartyAccess(order, user);
  return access.ok;
}

module.exports = {
  companyTeamHasOrderProvider,
  getOrderPartyAccess,
  getOrderPartySide,
  userCanAccessOrderSensitive,
};
