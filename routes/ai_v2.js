/**
 * Nowe endpointy AI Concierge V2 (Agent-based)
 * Równolegle do istniejącego /api/ai/concierge/analyze
 */

const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const { conciergeHandler } = require('../ai');

/**
 * POST /api/ai/concierge/v2
 * Nowy endpoint z architekturą agentów
 * 
 * Body:
 * {
 *   messages: [{ role: "user"|"assistant", content: "..." }],
 *   userContext?: { location?: string, lat?: number, lng?: number },
 *   allowedServicesHint?: string[]
 * }
 * 
 * Lub backward compatibility:
 * {
 *   description: "tekst problemu",
 *   locationText?: string,
 *   lat?: number,
 *   lon?: number
 * }
 */
router.post('/concierge/v2', authMiddleware, conciergeHandler);

module.exports = router;

