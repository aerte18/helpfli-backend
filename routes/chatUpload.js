const express = require('express');
const router = express.Router();
const multer = require('multer');
const sharp = require('sharp');
const { S3Client, PutObjectCommand } = require('@aws-sdk/client-s3');
const { verifyToken } = require('../middleware/authMiddleware');

const s3 = new S3Client({
  region: process.env.AWS_REGION || 'eu-central-1',
  credentials: process.env.AWS_ACCESS_KEY_ID
    ? {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
      }
    : undefined
});

// Use memory storage to access file buffer for thumbnail generation
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = ['image/png', 'image/jpeg', 'image/jpg', 'application/pdf'];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Niedozwolony typ pliku. Dozwolone: PNG, JPG, PDF'), false);
    }
  }
});

const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'application/pdf'];

router.post('/upload', verifyToken, upload.array('files', 5), async (req, res) => {
  try {
    if (!req.files || req.files.length === 0) {
      return res.status(400).json({ message: 'Brak plików do uploadu' });
    }

    const uploads = await Promise.all(req.files.map(async (file) => {
      // Validate file type
      if (!ALLOWED_TYPES.includes(file.mimetype)) {
        throw new Error(`Niedozwolony typ pliku: ${file.mimetype}`);
      }

      // Upload original file to S3
      const key = `chat/${Date.now()}_${file.originalname}`;
      await s3.send(new PutObjectCommand({
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: key,
        Body: file.buffer,
        ACL: 'public-read',
        ContentType: file.mimetype
      }));

      const url = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${key}`;

      // Generate thumbnail for images
      let thumbUrl = null;
      if (file.mimetype.startsWith('image/')) {
        try {
          const thumbBuffer = await sharp(file.buffer)
            .resize(200, 200, { fit: 'inside' })
            .webp({ quality: 75 })
            .toBuffer();

          const thumbKey = `chat/thumbs/${Date.now()}_${file.originalname}.webp`;
          await s3.send(new PutObjectCommand({
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: thumbKey,
            Body: thumbBuffer,
            ACL: 'public-read',
            ContentType: 'image/webp'
          }));

          thumbUrl = `https://${process.env.AWS_BUCKET_NAME}.s3.${process.env.AWS_REGION}.amazonaws.com/${thumbKey}`;
        } catch (thumbError) {
          console.warn('Thumbnail generation failed:', thumbError);
          // Continue without thumbnail
        }
      }

      return {
        url,
        thumbUrl,
        type: file.mimetype,
        size: file.size,
        name: file.originalname
      };
    }));

    res.json({ files: uploads });
  } catch (error) {
    console.error('Upload error:', error);
    res.status(400).json({ message: error.message || 'Błąd uploadu plików' });
  }
});

module.exports = router;