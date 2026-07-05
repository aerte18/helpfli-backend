const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { authMiddleware } = require('../middleware/authMiddleware');
const { requireRole } = require('../middleware/roles');
const User = require('../models/User');

const MAX_MB = parseInt(process.env.MAX_FILE_SIZE_MB || '10', 10);
const BUCKET = process.env.AWS_BUCKET_NAME || process.env.AWS_S3_BUCKET;
const useS3 = !!(BUCKET && process.env.AWS_ACCESS_KEY_ID);

const s3 = useS3
  ? new S3Client({
      region: process.env.AWS_REGION || 'eu-central-1',
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
    })
  : null;

const KYC_UPLOAD_DIR = () => {
  const dir = path.join(__dirname, '..', process.env.UPLOAD_DIR || 'uploads', 'kyc');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const ALLOWED_MIME = new Set([
  'image/jpeg',
  'image/jpg',
  'image/png',
  'application/pdf',
]);

const storage = useS3
  ? multer.memoryStorage()
  : multer.diskStorage({
      destination: (req, file, cb) => cb(null, KYC_UPLOAD_DIR()),
      filename: (req, file, cb) => {
        const ext = path.extname(file.originalname || '');
        const safe = file.fieldname + '-' + Date.now() + '-' + Math.random().toString(36).slice(2) + ext;
        cb(null, safe);
      },
    });

const upload = multer({
  storage,
  limits: { fileSize: MAX_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIME.has(file.mimetype)) return cb(null, true);
    cb(new Error('Niedozwolony typ pliku. Dozwolone: JPG, PNG, PDF'));
  },
});

const toPublicUrl = (filename) => `/uploads/kyc/${filename}`;

async function persistKycFile(file, userId, fieldName) {
  if (useS3 && file.buffer) {
    const ext = path.extname(file.originalname || '') || '';
    const key = `kyc/${userId}/${fieldName}-${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`;
    await s3.send(
      new PutObjectCommand({
        Bucket: BUCKET,
        Key: key,
        Body: file.buffer,
        ContentType: file.mimetype,
      })
    );
    return { storage: 's3', key, bucket: BUCKET };
  }
  if (file.filename) return { storage: 'local', url: toPublicUrl(file.filename) };
  throw new Error('Nie udało się zapisać pliku');
}

function docRefFromPersistResult(result) {
  if (!result) return null;
  if (typeof result === 'string') return result;
  if (result.storage === 'local') return result.url;
  if (result.storage === 's3') return `s3://${result.bucket}/${result.key}`;
  return null;
}

async function streamKycDoc(stored, res) {
  if (stored.startsWith('s3://')) {
    const without = stored.slice('s3://'.length);
    const slash = without.indexOf('/');
    const bucket = without.slice(0, slash);
    const key = without.slice(slash + 1);
    const obj = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
    res.setHeader('Content-Type', obj.ContentType || 'application/octet-stream');
    res.setHeader('Cache-Control', 'private, max-age=60');
    obj.Body.pipe(res);
    return true;
  }
  if (stored.startsWith('/uploads/')) {
    const fs = require('fs');
    const filePath = path.join(__dirname, '..', stored.replace(/^\//, ''));
    if (!fs.existsSync(filePath)) return false;
    res.sendFile(path.resolve(filePath));
    return true;
  }
  return false;
}

function getMissingDocs(kyc) {
  const docs = kyc?.docs || {};
  const missing = [];
  if (!docs.idFrontUrl) missing.push('idFront');
  if (!docs.idBackUrl) missing.push('idBack');
  if (!docs.selfieUrl) missing.push('selfie');
  if (kyc?.type === 'company' && !docs.companyDocUrl) missing.push('companyDoc');
  return missing;
}

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

  if (['not_started', 'rejected'].includes(user.kyc.status)) {
    user.kyc.status = 'in_progress';
    user.kyc.rejectionReason = '';
  }
  await user.save();
  res.json({ message: 'Zapisano', kyc: user.kyc });
});

// POST /api/kyc/upload – upload plików (krok 2)
router.post(
  '/upload',
  authMiddleware,
  (req, res, next) => {
    upload.fields([
      { name: 'idFront', maxCount: 1 },
      { name: 'idBack', maxCount: 1 },
      { name: 'selfie', maxCount: 1 },
      { name: 'companyDoc', maxCount: 1 },
    ])(req, res, (err) => {
      if (err) {
        const msg =
          err.code === 'LIMIT_FILE_SIZE'
            ? `Plik za duży (max ${MAX_MB} MB)`
            : err.message || 'Błąd uploadu';
        return res.status(400).json({ message: msg });
      }
      next();
    });
  },
  async (req, res) => {
    try {
      const user = await User.findById(req.user._id);
      if (user.role !== 'provider') return res.status(403).json({ message: 'Tylko dla wykonawców' });

      const hasAnyFile =
        req.files?.idFront?.[0] ||
        req.files?.idBack?.[0] ||
        req.files?.selfie?.[0] ||
        req.files?.companyDoc?.[0];
      if (!hasAnyFile) {
        return res.status(400).json({ message: 'Wybierz co najmniej jeden plik do wysłania' });
      }

      user.kyc = user.kyc || {};
      user.kyc.docs = user.kyc.docs || {};
      const uid = String(user._id);

      if (req.files?.idFront?.[0]) {
        user.kyc.docs.idFrontUrl = docRefFromPersistResult(await persistKycFile(req.files.idFront[0], uid, 'idFront'));
      }
      if (req.files?.idBack?.[0]) {
        user.kyc.docs.idBackUrl = docRefFromPersistResult(await persistKycFile(req.files.idBack[0], uid, 'idBack'));
      }
      if (req.files?.selfie?.[0]) {
        user.kyc.docs.selfieUrl = docRefFromPersistResult(await persistKycFile(req.files.selfie[0], uid, 'selfie'));
      }
      if (req.files?.companyDoc?.[0]) {
        user.kyc.docs.companyDocUrl = docRefFromPersistResult(await persistKycFile(req.files.companyDoc[0], uid, 'companyDoc'));
      }

      if (user.kyc.status === 'not_started') user.kyc.status = 'in_progress';
      await user.save();
      res.json({ message: 'Pliki zapisane', kyc: user.kyc, missing: getMissingDocs(user.kyc) });
    } catch (e) {
      console.error('[kyc/upload]', e);
      res.status(500).json({ message: 'Błąd zapisu plików na serwerze' });
    }
  }
);

// POST /api/kyc/submit – złożenie wniosku (krok 3)
router.post('/submit', authMiddleware, async (req, res) => {
  const user = await User.findById(req.user._id);
  if (user.role !== 'provider') return res.status(403).json({ message: 'Tylko dla wykonawców' });

  const missing = getMissingDocs(user.kyc);
  if (missing.length) {
    return res.status(400).json({
      message: 'Brak wymaganych dokumentów',
      missing,
      hint: 'Wybierz pliki w kroku 2 i kliknij „Zapisz pliki” przed wysłaniem wniosku.',
    });
  }

  user.kyc.status = 'submitted';
  user.kyc.submittedAt = new Date();
  user.kyc.rejectionReason = '';
  await user.save();
  res.json({ message: 'Wniosek wysłany. Oczekuje na weryfikację.', kyc: user.kyc });
});

// ADMIN – lista
router.get('/admin/list', authMiddleware, requireRole('admin'), async (req, res) => {
  const status = req.query.status || 'submitted';
  const users = await User.find({ role: 'provider', 'kyc.status': status }).select('name email kyc');
  res.json({ items: users });
});

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

const DOC_FIELD_MAP = {
  idFront: 'idFrontUrl',
  idBack: 'idBackUrl',
  selfie: 'selfieUrl',
  companyDoc: 'companyDocUrl',
};

router.get('/document/:field', authMiddleware, async (req, res) => {
  try {
    const docKey = DOC_FIELD_MAP[req.params.field];
    if (!docKey) return res.status(400).json({ message: 'Nieprawidłowe pole dokumentu' });

    const targetUserId = req.query.userId || req.user._id;
    const target = await User.findById(targetUserId).select('kyc role');
    if (!target) return res.status(404).json({ message: 'Nie znaleziono użytkownika' });

    const stored = target.kyc?.docs?.[docKey];
    const isAdmin = req.user.role === 'admin' || req.user.role === 'superadmin';
    if (String(req.user._id) !== String(targetUserId) && !isAdmin) {
      return res.status(403).json({ message: 'Brak dostępu do dokumentu' });
    }
    if (!stored) return res.status(404).json({ message: 'Brak dokumentu' });

    const ok = await streamKycDoc(stored, res);
    if (!ok) return res.status(404).json({ message: 'Plik niedostępny' });
  } catch (e) {
    console.error('[kyc/document]', e);
    res.status(500).json({ message: 'Błąd pobierania dokumentu' });
  }
});

module.exports = router;
