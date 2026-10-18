const crypto = require('crypto');
const fs = require('fs');

const MIME_EXTENSIONS = Object.freeze({
  'image/jpeg': '.jpg',
  'image/jpg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
  'video/webm': '.webm',
  'video/x-msvideo': '.avi',
  'video/ogg': '.ogv',
  'application/pdf': '.pdf',
});

function extensionForMime(mime) {
  return MIME_EXTENSIONS[String(mime || '').toLowerCase()] || null;
}

function safeUploadName(prefix, file, ownerId = '') {
  const ext = extensionForMime(file?.mimetype);
  if (!ext) throw new Error('Niedozwolony typ pliku');
  const owner = String(ownerId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  const token = crypto.randomBytes(16).toString('hex');
  return [prefix, owner, token].filter(Boolean).join('-') + ext;
}

function startsWithBytes(buffer, bytes) {
  if (!Buffer.isBuffer(buffer) || buffer.length < bytes.length) return false;
  return bytes.every((byte, index) => buffer[index] === byte);
}

function hasExpectedMagicBytes(buffer, mime) {
  const normalized = String(mime || '').toLowerCase();
  if (normalized === 'image/jpeg' || normalized === 'image/jpg') {
    return startsWithBytes(buffer, [0xff, 0xd8, 0xff]);
  }
  if (normalized === 'image/png') {
    return startsWithBytes(buffer, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  }
  if (normalized === 'image/gif') {
    return buffer.subarray(0, 6).toString('ascii') === 'GIF87a' ||
      buffer.subarray(0, 6).toString('ascii') === 'GIF89a';
  }
  if (normalized === 'image/webp') {
    return buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 12).toString('ascii') === 'WEBP';
  }
  if (normalized === 'application/pdf') {
    return buffer.subarray(0, 5).toString('ascii') === '%PDF-';
  }
  if (normalized === 'video/mp4' || normalized === 'video/quicktime') {
    return buffer.subarray(4, 8).toString('ascii') === 'ftyp';
  }
  if (normalized === 'video/webm') {
    return startsWithBytes(buffer, [0x1a, 0x45, 0xdf, 0xa3]);
  }
  if (normalized === 'video/x-msvideo') {
    return buffer.subarray(0, 4).toString('ascii') === 'RIFF' &&
      buffer.subarray(8, 11).toString('ascii') === 'AVI';
  }
  if (normalized === 'video/ogg') {
    return buffer.subarray(0, 4).toString('ascii') === 'OggS';
  }
  return false;
}

function flattenUploadedFiles(files) {
  if (!files) return [];
  if (Array.isArray(files)) return files;
  return Object.values(files).flat().filter(Boolean);
}

function removeUploadedFiles(files) {
  for (const file of flattenUploadedFiles(files)) {
    if (file?.path) fs.unlink(file.path, () => {});
  }
}

async function validateUploadedFiles(files) {
  const uploaded = flattenUploadedFiles(files);
  for (const file of uploaded) {
    if (!file?.path || !extensionForMime(file.mimetype)) return false;
    const handle = await fs.promises.open(file.path, 'r');
    try {
      const header = Buffer.alloc(16);
      const { bytesRead } = await handle.read(header, 0, header.length, 0);
      if (!hasExpectedMagicBytes(header.subarray(0, bytesRead), file.mimetype)) return false;
    } finally {
      await handle.close();
    }
  }
  return true;
}

module.exports = {
  MIME_EXTENSIONS,
  extensionForMime,
  safeUploadName,
  hasExpectedMagicBytes,
  flattenUploadedFiles,
  removeUploadedFiles,
  validateUploadedFiles,
};
