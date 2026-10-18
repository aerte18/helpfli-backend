const jwt = require('jsonwebtoken');
const path = require('path');

const PUBLIC_PREFIXES = new Set(['avatars', 'portfolio', 'sponsor-ads']);
const SENSITIVE_PREFIXES = [
  'kyc',
  'orders',
  'chat',
  'drafts',
  'concierge',
  'reports',
  'platform',
];

function extractToken(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) return auth.slice(7);
  if (req.query?.token && typeof req.query.token === 'string') return req.query.token;
  return null;
}

function verifyUploadToken(token) {
  if (!token || !process.env.JWT_SECRET) return null;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    return decoded?.id || decoded?.userId || null;
  } catch {
    return null;
  }
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function storedUploadUrlRegex(relativePath) {
  return new RegExp(`/uploads/${escapeRegex(relativePath)}(?:\\?.*)?$`, 'i');
}

function isSafeRelativePath(relativePath) {
  if (!relativePath || relativePath.includes('\0') || relativePath.includes('%')) return false;
  const normalized = relativePath.replace(/\\/g, '/');
  if (normalized.startsWith('/') || normalized.split('/').some((part) => !part || part === '.' || part === '..')) {
    return false;
  }
  return normalized === path.posix.normalize(normalized);
}

async function viewerFor(userId) {
  const User = require('../models/User');
  return User.findById(userId).select('_id role company isActive anonymized').lean();
}

async function canAccessKyc(relativePath, viewer) {
  const User = require('../models/User');
  const url = storedUploadUrlRegex(relativePath);
  const owner = await User.findOne({
    $or: [
      { 'kyc.docs.idFrontUrl': url },
      { 'kyc.docs.idBackUrl': url },
      { 'kyc.docs.selfieUrl': url },
      { 'kyc.docs.companyDocUrl': url },
    ],
  }).select('_id').lean();
  return Boolean(owner && String(owner._id) === String(viewer._id));
}

async function canAccessOrder(relativePath, viewer) {
  const Order = require('../models/Order');
  const { userCanAccessOrderSensitive } = require('../utils/orderAccess');
  const url = storedUploadUrlRegex(relativePath);
  const order = await Order.findOne({
    $or: [{ 'attachments.url': url }, { 'invoice.url': url }],
  }).select('client provider').lean();
  return Boolean(order && (await userCanAccessOrderSensitive(order, viewer)));
}

async function canAccessDraft(relativePath, viewer) {
  const OrderDraft = require('../models/orderDraft');
  const DraftQuote = require('../models/draftQuote');
  const url = storedUploadUrlRegex(relativePath);
  const draft = await OrderDraft.findOne({ 'attachments.url': url }).select('client').lean();
  if (!draft) return false;
  if (String(draft.client) === String(viewer._id)) return true;
  return Boolean(await DraftQuote.exists({ draft: draft._id, provider: viewer._id }));
}

async function canAccessChat(relativePath, viewer) {
  const Message = require('../models/Message');
  const Conversation = require('../models/Conversation');
  const filename = relativePath.split('/')[1];
  if (filename?.startsWith(`chat-${viewer._id}-`)) return true;
  const url = storedUploadUrlRegex(relativePath);
  const message = await Message.findOne({ 'attachments.url': url }).select('conversation sender').lean();
  if (!message) return false;
  if (String(message.sender) === String(viewer._id)) return true;
  return Boolean(await Conversation.exists({ _id: message.conversation, participants: viewer._id }));
}

async function canAccessReport(relativePath, viewer) {
  const Report = require('../models/Report');
  const url = storedUploadUrlRegex(relativePath);
  const report = await Report.findOne({ 'attachments.url': url }).select('user').lean();
  return Boolean(report && String(report.user) === String(viewer._id));
}

async function canAccessPlatformInvoice(relativePath, viewer) {
  const Invoice = require('../models/Invoice');
  const url = storedUploadUrlRegex(relativePath);
  const invoice = await Invoice.findOne({ pdfUrl: url }).select('owner ownerType').lean();
  if (!invoice) return false;
  if (invoice.ownerType === 'user') return String(invoice.owner) === String(viewer._id);
  if (invoice.ownerType !== 'company') return false;
  const Company = require('../models/Company');
  return Boolean(await Company.exists({
    _id: invoice.owner,
    $or: [
      { owner: viewer._id },
      { managers: viewer._id },
      { providers: viewer._id },
    ],
  }));
}

async function authorizeSensitiveUpload(relativePath, viewer) {
  if (!viewer?.isActive || viewer.anonymized) return false;
  if (viewer.role === 'admin' || viewer.role === 'superadmin') return true;

  const [top, filename] = relativePath.split('/');
  if (top === 'concierge') {
    return Boolean(filename && filename.startsWith(`concierge-${viewer._id}-`));
  }
  if (top === 'kyc') return canAccessKyc(relativePath, viewer);
  if (top === 'orders') return canAccessOrder(relativePath, viewer);
  if (top === 'drafts') return canAccessDraft(relativePath, viewer);
  if (top === 'chat') return canAccessChat(relativePath, viewer);
  if (top === 'reports') return canAccessReport(relativePath, viewer);
  if (top === 'platform') return canAccessPlatformInvoice(relativePath, viewer);
  return false;
}

/**
 * Public media uses an explicit allow-list. Every other upload requires a valid
 * JWT and resource-level authorization, so knowing a filename is not enough.
 */
async function secureUploads(req, res, next) {
  const relativePath = (req.path || '').replace(/^\/+/, '').replace(/\\/g, '/');
  if (!isSafeRelativePath(relativePath)) {
    return res.status(400).json({ message: 'Nieprawidłowa ścieżka pliku' });
  }

  const top = relativePath.split('/')[0];
  if (PUBLIC_PREFIXES.has(top)) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    return next();
  }

  const userId = verifyUploadToken(extractToken(req));
  if (!userId) {
    return res.status(401).json({ message: 'Wymagana autoryzacja do pobrania pliku' });
  }

  try {
    const viewer = await viewerFor(userId);
    const allowed = await authorizeSensitiveUpload(relativePath, viewer);
    if (!allowed) return res.status(404).json({ message: 'Plik nie istnieje' });

    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Cross-Origin-Resource-Policy', 'same-site');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    const ext = path.extname(relativePath).toLowerCase();
    const inlineTypes = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.mp4', '.mov', '.webm', '.avi', '.ogv']);
    if (!inlineTypes.has(ext)) {
      const safeName = path.basename(relativePath).replace(/["\\\r\n]/g, '_');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
    }
    req.uploadViewerId = userId;
    return next();
  } catch (error) {
    console.error('UPLOAD_AUTHORIZATION_ERROR:', error?.message || error);
    return res.status(500).json({ message: 'Nie udało się zweryfikować dostępu do pliku' });
  }
}

module.exports = {
  secureUploads,
  SENSITIVE_PREFIXES,
  PUBLIC_PREFIXES,
  authorizeSensitiveUpload,
  isSafeRelativePath,
};
