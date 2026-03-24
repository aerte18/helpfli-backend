const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const { authMiddleware } = require('../middleware/authMiddleware');
const { requireRole } = require('../middleware/roles');
const User = require('../models/User');

const MAX_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '10', 10);
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, path.join(__dirname, '..', process.env.UPLOAD_DIR || 'uploads', 'kyc')),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname || '');
    const safe = file.fieldname + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + ext;
    cb(null, safe);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: MAX_MB * 1024 * 1024 },
});

const toPublicUrl = (filename) => `/uploads/kyc/${filename}`;

// GET /api/kyc/me – stan KYC i dane
router.get('/me', authMiddleware, async (req, res) => {
  const user = await User.findById(req.user._id).select('role kyc name email');
  res.json(user);
});

// POST /api/kyc/save – zapis danych (krok 1)
router.post('/save', authMiddleware, async (req, res) => {
  const { type, firstName, lastName, idNumber, companyName, nip } = req.body;
  const user = await User.findById(req.user._id);
  if (user.role !== 'provider') return res.status(403).json({ message: 'Tylko dla wykonawców' });

  user.kyc = user.kyc || {};
  if (type) user.kyc.type = type;
  if (firstName) user.kyc.firstName = firstName;
  if (lastName) user.kyc.lastName = lastName;
  if (idNumber) user.kyc.idNumber = idNumber;
  if (companyName) user.kyc.companyName = companyName;
  if (nip) user.kyc.nip = nip;

  // przejście do in_progress, tylko jeśli jeszcze nie submitted/verified
  if (['not_started','rejected'].includes(user.kyc.status)) {
    user.kyc.status = 'in_progress';
    user.kyc.rejectionReason = '';
  }
  await user.save();
  res.json({ message: 'Zapisano', kyc: user.kyc });
});

// POST /api/kyc/upload – upload plików (krok 2)
router.post('/upload', authMiddleware, upload.fields([
  { name: 'idFront', maxCount: 1 },
  { name: 'idBack', maxCount: 1 },
  { name: 'selfie', maxCount: 1 },
  { name: 'companyDoc', maxCount: 1 },
]), async (req, res) => {
  const user = await User.findById(req.user._id);
  if (user.role !== 'provider') return res.status(403).json({ message: 'Tylko dla wykonawców' });

  user.kyc = user.kyc || {};
  user.kyc.docs = user.kyc.docs || {};

  if (req.files?.idFront?.[0]) user.kyc.docs.idFrontUrl = toPublicUrl(req.files.idFront[0].filename);
  if (req.files?.idBack?.[0]) user.kyc.docs.idBackUrl = toPublicUrl(req.files.idBack[0].filename);
  if (req.files?.selfie?.[0]) user.kyc.docs.selfieUrl = toPublicUrl(req.files.selfie[0].filename);
  if (req.files?.companyDoc?.[0]) user.kyc.docs.companyDocUrl = toPublicUrl(req.files.companyDoc[0].filename);

  if (user.kyc.status === 'not_started') user.kyc.status = 'in_progress';
  await user.save();
  res.json({ message: 'Pliki zapisane', kyc: user.kyc });
});

// POST /api/kyc/submit – złożenie wniosku (krok 3)
router.post('/submit', authMiddleware, async (req, res) => {
  const user = await User.findById(req.user._id);
  if (user.role !== 'provider') return res.status(403).json({ message: 'Tylko dla wykonawców' });

  // prosta walidacja
  const docs = user.kyc?.docs || {};
  const hasId = !!(docs.idFrontUrl && docs.idBackUrl);
  const hasSelfie = !!docs.selfieUrl;
  const forCompany = user.kyc?.type === 'company';
  const hasCompanyDoc = forCompany ? !!docs.companyDocUrl : true;

  if (!hasId || !hasSelfie || !hasCompanyDoc) {
    return res.status(400).json({ message: 'Brak wymaganych dokumentów' });
  }

  user.kyc.status = 'submitted';
  user.kyc.submittedAt = new Date();
  user.kyc.rejectionReason = '';
  await user.save();
  res.json({ message: 'Wniosek wysłany. Oczekuje na weryfikację.', kyc: user.kyc });
});

// ADMIN – lista
// GET /api/kyc/admin/list?status=pending|submitted|rejected|verified
router.get('/admin/list', authMiddleware, requireRole('admin'), async (req, res) => {
  const status = req.query.status || 'submitted';
  const users = await User.find({ role: 'provider', 'kyc.status': status })
    .select('name email kyc');
  res.json({ items: users });
});

// ADMIN – akceptacja
router.post('/admin/:userId/approve', authMiddleware, requireRole('admin'), async (req, res) => {
  const u = await User.findById(req.params.userId);
  if (!u) return res.status(404).json({ message: 'Not found' });
  if (u.role !== 'provider') return res.status(400).json({ message: 'Nie-dotyczy' });

  u.kyc.status = 'verified';
  u.kyc.verifiedAt = new Date();
  u.kyc.rejectionReason = '';
  await u.save();

  res.json({ message: 'KYC zatwierdzone', kyc: u.kyc });
});

// ADMIN – odrzucenie
router.post('/admin/:userId/reject', authMiddleware, requireRole('admin'), async (req, res) => {
  const { reason = 'Brak zgodności dokumentów' } = req.body || {};
  const u = await User.findById(req.params.userId);
  if (!u) return res.status(404).json({ message: 'Not found' });
  if (u.role !== 'provider') return res.status(400).json({ message: 'Nie-dotyczy' });

  u.kyc.status = 'rejected';
  u.kyc.rejectionReason = reason;
  await u.save();

  res.json({ message: 'KYC odrzucone', kyc: u.kyc });
});

module.exports = router;
