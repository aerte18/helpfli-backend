// backend/routes/ai_claude.js
// Endpointy do testowania i zarządzania integracją z Claude 3.5

const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const { requireRole } = require('../middleware/roles');
const claudeService = require('../services/claude');
const llmService = require('../services/llm_service');

// GET /api/ai/claude/status - Status integracji z Claude
router.get('/status', authMiddleware, requireRole(['admin']), async (req, res) => {
  try {
    const status = llmService.getStatus();
    const connections = await llmService.testConnections();
    
    res.json({
      success: true,
      status,
      connections,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Claude status error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/ai/claude/test - Test połączenia z Claude
router.post('/test', authMiddleware, requireRole(['admin']), async (req, res) => {
  try {
    const testResult = await claudeService.testConnection();
    
    res.json({
      success: true,
      result: testResult,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Claude test error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/ai/claude/analyze - Test analizy problemu przez Claude
router.post('/analyze', authMiddleware, requireRole(['admin']), async (req, res) => {
  try {
    const { description, lang = 'pl' } = req.body;
    
    if (!description || description.length < 5) {
      return res.status(400).json({
        success: false,
        error: 'Opisz problem nieco dokładniej (minimum 5 znaków)'
      });
    }

    console.log('🧪 Testing Claude analysis:', { 
      description: description.substring(0, 100) + '...', 
      lang 
    });

    const result = await claudeService.analyzeWithClaude({
      description,
      imageUrls: [],
      lang
    });

    res.json({
      success: true,
      result,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Claude analyze error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/ai/claude/compare - Porównanie Claude vs Ollama
router.post('/compare', authMiddleware, requireRole(['admin']), async (req, res) => {
  try {
    const { description, lang = 'pl' } = req.body;
    
    if (!description || description.length < 5) {
      return res.status(400).json({
        success: false,
        error: 'Opisz problem nieco dokładniej (minimum 5 znaków)'
      });
    }

    console.log('🔄 Comparing Claude vs Ollama:', { 
      description: description.substring(0, 100) + '...', 
      lang 
    });

    const results = {
      claude: null,
      ollama: null,
      comparison: null
    };

    // Test Claude
    try {
      const claudeResult = await claudeService.analyzeWithClaude({
        description,
        imageUrls: [],
        lang
      });
      results.claude = {
        success: true,
        result: claudeResult,
        provider: 'claude'
      };
    } catch (error) {
      results.claude = {
        success: false,
        error: error.message,
        provider: 'claude'
      };
    }

    // Test Ollama
    try {
      const { analyzeWithOllama } = require('../services/llm_local');
      const ollamaResult = await analyzeWithOllama({
        description,
        imageUrls: [],
        lang
      });
      results.ollama = {
        success: true,
        result: ollamaResult,
        provider: 'ollama'
      };
    } catch (error) {
      results.ollama = {
        success: false,
        error: error.message,
        provider: 'ollama'
      };
    }

    // Porównanie wyników
    if (results.claude.success && results.ollama.success) {
      results.comparison = {
        serviceMatch: results.claude.result.serviceCandidate?.code === results.ollama.result.serviceCandidate?.code,
        claudeConfidence: results.claude.result.serviceCandidate?.confidence || 0,
        ollamaConfidence: results.ollama.result.serviceCandidate?.confidence || 0,
        diyStepsCount: {
          claude: results.claude.result.diySteps?.length || 0,
          ollama: results.ollama.result.diySteps?.length || 0
        },
        dangerFlags: {
          claude: results.claude.result.dangerFlags?.length || 0,
          ollama: results.ollama.result.dangerFlags?.length || 0
        }
      };
    }

    res.json({
      success: true,
      results,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Claude compare error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// POST /api/ai/claude/config - Konfiguracja dostawcy LLM
router.post('/config', authMiddleware, requireRole(['admin']), async (req, res) => {
  try {
    const { provider, fallbackEnabled } = req.body;
    
    // Walidacja
    if (provider && !['claude', 'ollama', 'auto'].includes(provider)) {
      return res.status(400).json({
        success: false,
        error: 'Nieprawidłowy dostawca. Dozwolone: claude, ollama, auto'
      });
    }

    // Aktualizuj konfigurację (w prawdziwej aplikacji zapisz to w bazie danych)
    if (provider) {
      process.env.LLM_PROVIDER = provider;
    }
    if (fallbackEnabled !== undefined) {
      process.env.LLM_FALLBACK_ENABLED = fallbackEnabled.toString();
    }

    const newStatus = llmService.getStatus();
    
    res.json({
      success: true,
      message: 'Konfiguracja zaktualizowana',
      status: newStatus,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Claude config error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

module.exports = router;
