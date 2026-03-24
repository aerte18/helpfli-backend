const express = require('express');
const KbArticle = require('../models/KbArticle');
const Redis = require('ioredis');
const { authMiddleware } = require('../middleware/authMiddleware');
const { requireRole } = require('../middleware/roles');
const { validate } = require('../middleware/validation');

const router = express.Router();

// Redis client (optional - will work without it)
let redisClient = null;
if (process.env.REDIS_URL) {
  try {
    redisClient = new Redis(process.env.REDIS_URL, {
      retryDelayOnFailover: 100,
      maxRetriesPerRequest: 1,
      lazyConnect: true
    });
    redisClient.on('error', () => {
      // Silently ignore Redis errors
      redisClient = null;
    });
  } catch (error) {
    console.warn('Redis not available, KB will work without cache');
  }
}

router.get('/kb', async (req, res) => {
  const { q, slug, lang = 'pl' } = req.query;
  
  try {
    if (slug) {
      const cacheKey = `kb:slug:${lang}:${slug}`;
      
      // Try cache first
      if (redisClient) {
        try {
          const cached = await redisClient.get(cacheKey);
          if (cached) {
            return res.json(JSON.parse(cached));
          }
        } catch (e) {
          console.warn('Redis get error:', e.message);
        }
      }
      
      const art = await KbArticle.findOne({ slug, lang });
      if (!art) return res.status(404).json({ error: 'NOT_FOUND' });
      
      // Cache result
      if (redisClient) {
        try {
          await redisClient.setex(cacheKey, 300, JSON.stringify(art));
        } catch (e) {
          console.warn('Redis set error:', e.message);
        }
      }
      
      return res.json(art);
    }

    if (q) {
      const cacheKey = `kb:q:${lang}:${q}`;
      
      // Try cache first
      if (redisClient) {
        try {
          const cached = await redisClient.get(cacheKey);
          if (cached) {
            return res.json(JSON.parse(cached));
          }
        } catch (e) {
          console.warn('Redis get error:', e.message);
        }
      }
      
      const list = await KbArticle.find({ 
        lang, 
        $or: [
          { title: new RegExp(q, 'i') },
          { content: new RegExp(q, 'i') },
          { tags: q }
        ]
      }).limit(10);
      
      // Cache result
      if (redisClient) {
        try {
          await redisClient.setex(cacheKey, 300, JSON.stringify(list));
        } catch (e) {
          console.warn('Redis set error:', e.message);
        }
      }
      
      return res.json(list);
    }

    const all = await KbArticle.find({ lang }).limit(50);
    return res.json(all);
  } catch (e) {
    console.error('KB route error:', e);
    return res.status(500).json({ error: e.message });
  }
});

// ===== ADMIN CRUD ENDPOINTS =====

// GET /api/kb/articles - Lista wszystkich artykułów (admin)
router.get('/kb/articles', authMiddleware, requireRole(['admin']), async (req, res) => {
  try {
    const { category, isActive, page = 1, limit = 50 } = req.query;
    
    const filter = {};
    if (category) filter.category = category;
    if (isActive !== undefined) filter.isActive = isActive === 'true';
    
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const articles = await KbArticle.find(filter)
      .sort({ priority: -1, createdAt: -1 })
      .skip(skip)
      .limit(parseInt(limit))
      .lean();
    
    const total = await KbArticle.countDocuments(filter);
    
    res.json({
      articles,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('KB articles list error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/kb/articles/:id - Pobierz konkretny artykuł (admin)
router.get('/kb/articles/:id', authMiddleware, requireRole(['admin']), async (req, res) => {
  try {
    const article = await KbArticle.findById(req.params.id);
    if (!article) {
      return res.status(404).json({ error: 'Article not found' });
    }
    res.json(article);
  } catch (error) {
    console.error('KB article get error:', error);
    res.status(500).json({ error: error.message });
  }
});

// POST /api/kb/articles - Utwórz nowy artykuł (admin)
router.post('/kb/articles', authMiddleware, requireRole(['admin']), validate('kbCreate'), async (req, res) => {
  try {
    const { title, content, category, tags, isActive = true, priority = 1 } = req.body;
    
    if (!title || !content || !category) {
      return res.status(400).json({ error: 'Title, content and category are required' });
    }
    
    // Generuj slug z tytułu
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim('-');
    
    const article = new KbArticle({
      title,
      content,
      category,
      tags: Array.isArray(tags) ? tags : (tags ? tags.split(',').map(t => t.trim()) : []),
      isActive,
      priority: parseInt(priority),
      slug,
      lang: 'pl' // Domyślnie polski
    });
    
    await article.save();
    
    // Wyczyść cache
    if (redisClient) {
      try {
        await redisClient.del('kb:*');
      } catch (e) {
        console.warn('Redis clear cache error:', e.message);
      }
    }
    
    res.status(201).json(article);
  } catch (error) {
    console.error('KB article create error:', error);
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/kb/articles/:id - Aktualizuj artykuł (admin)
router.put('/kb/articles/:id', authMiddleware, requireRole(['admin']), validate('kbUpdate'), async (req, res) => {
  try {
    const { title, content, category, tags, isActive, priority } = req.body;
    
    const updateData = {};
    if (title !== undefined) updateData.title = title;
    if (content !== undefined) updateData.content = content;
    if (category !== undefined) updateData.category = category;
    if (tags !== undefined) {
      updateData.tags = Array.isArray(tags) ? tags : (tags ? tags.split(',').map(t => t.trim()) : []);
    }
    if (isActive !== undefined) updateData.isActive = isActive;
    if (priority !== undefined) updateData.priority = parseInt(priority);
    
    // Jeśli zmienił się tytuł, zaktualizuj slug
    if (title) {
      updateData.slug = title
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .replace(/-+/g, '-')
        .trim('-');
    }
    
    const article = await KbArticle.findByIdAndUpdate(
      req.params.id,
      updateData,
      { new: true, runValidators: true }
    );
    
    if (!article) {
      return res.status(404).json({ error: 'Article not found' });
    }
    
    // Wyczyść cache
    if (redisClient) {
      try {
        await redisClient.del('kb:*');
      } catch (e) {
        console.warn('Redis clear cache error:', e.message);
      }
    }
    
    res.json(article);
  } catch (error) {
    console.error('KB article update error:', error);
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/kb/articles/:id - Usuń artykuł (admin)
router.delete('/kb/articles/:id', authMiddleware, requireRole(['admin']), async (req, res) => {
  try {
    const article = await KbArticle.findByIdAndDelete(req.params.id);
    
    if (!article) {
      return res.status(404).json({ error: 'Article not found' });
    }
    
    // Wyczyść cache
    if (redisClient) {
      try {
        await redisClient.del('kb:*');
      } catch (e) {
        console.warn('Redis clear cache error:', e.message);
      }
    }
    
    res.json({ message: 'Article deleted successfully' });
  } catch (error) {
    console.error('KB article delete error:', error);
    res.status(500).json({ error: error.message });
  }
});

// GET /api/kb/stats - Statystyki bazy wiedzy (admin)
router.get('/kb/stats', authMiddleware, requireRole(['admin']), async (req, res) => {
  try {
    const totalArticles = await KbArticle.countDocuments();
    const activeArticles = await KbArticle.countDocuments({ isActive: true });
    const inactiveArticles = await KbArticle.countDocuments({ isActive: false });
    
    const categoryStats = await KbArticle.aggregate([
      {
        $group: {
          _id: '$category',
          count: { $sum: 1 },
          active: { $sum: { $cond: ['$isActive', 1, 0] } }
        }
      },
      { $sort: { count: -1 } }
    ]);
    
    const recentArticles = await KbArticle.find()
      .sort({ createdAt: -1 })
      .limit(5)
      .select('title category createdAt isActive')
      .lean();
    
    res.json({
      totalArticles,
      activeArticles,
      inactiveArticles,
      categoryStats,
      recentArticles
    });
  } catch (error) {
    console.error('KB stats error:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
