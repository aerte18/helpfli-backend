/**
 * Meta sesji concierge (ścieżka wyboru użytkownika) — obok draftu w draftSessionStore
 */

const TTL_MS = 1000 * 60 * 60 * 6;
const meta = new Map();

function getChosenPath(sessionId) {
  if (!sessionId) return null;
  const entry = meta.get(sessionId);
  if (!entry) return null;
  if (Date.now() - entry.updatedAt > TTL_MS) {
    meta.delete(sessionId);
    return null;
  }
  return entry.chosenPath || null;
}

function setChosenPath(sessionId, chosenPath) {
  if (!sessionId || !chosenPath) return;
  meta.set(sessionId, { chosenPath, updatedAt: Date.now() });
}

function clearSessionMeta(sessionId) {
  if (sessionId) meta.delete(sessionId);
}

module.exports = {
  getChosenPath,
  setChosenPath,
  clearSessionMeta
};
