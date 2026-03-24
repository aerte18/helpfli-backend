const express = require('express');
const router = express.Router();
const BlogPost = require('../models/BlogPost');
const { authMiddleware: auth } = require('../middleware/authMiddleware');
const { requireRole } = require('../middleware/roles');

// GET /api/blog - lista wszystkich opublikowanych postów
router.get('/', async (req, res) => {
  try {
    const { category, tag, limit = 10, page = 1 } = req.query;
    const skip = (parseInt(page) - 1) * parseInt(limit);
    
    const query = { published: true };
    if (category) query.category = category;
    if (tag) query.tags = tag;
    
    const posts = await BlogPost.find(query)
      .select('-content') // Nie zwracaj pełnej treści w liście
      .sort({ publishedAt: -1 })
      .limit(parseInt(limit))
      .skip(skip)
      .lean();
    
    const total = await BlogPost.countDocuments(query);
    
    res.json({
      posts,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    });
  } catch (error) {
    console.error('Error fetching blog posts:', error);
    res.status(500).json({ message: 'Błąd pobierania postów' });
  }
});

// GET /api/blog/:slug - pojedynczy post
router.get('/:slug', async (req, res) => {
  try {
    const post = await BlogPost.findOne({ slug: req.params.slug, published: true }).lean();
    
    if (!post) {
      return res.status(404).json({ message: 'Post nie znaleziony' });
    }
    
    // Zwiększ licznik wyświetleń
    await BlogPost.findByIdAndUpdate(post._id, { $inc: { views: 1 } });
    post.views = (post.views || 0) + 1;
    
    res.json(post);
  } catch (error) {
    console.error('Error fetching blog post:', error);
    res.status(500).json({ message: 'Błąd pobierania posta' });
  }
});

// GET /api/blog/categories/list - lista kategorii
router.get('/categories/list', async (req, res) => {
  try {
    const categories = await BlogPost.distinct('category', { published: true });
    res.json({ categories });
  } catch (error) {
    console.error('Error fetching categories:', error);
    res.status(500).json({ message: 'Błąd pobierania kategorii' });
  }
});

// GET /api/blog/tags/list - lista tagów
router.get('/tags/list', async (req, res) => {
  try {
    const tags = await BlogPost.distinct('tags', { published: true });
    res.json({ tags });
  } catch (error) {
    console.error('Error fetching tags:', error);
    res.status(500).json({ message: 'Błąd pobierania tagów' });
  }
});

// Admin routes - wymagają autoryzacji i roli admin
// POST /api/blog - utwórz nowy post (admin only)
router.post('/', auth, requireRole('admin'), async (req, res) => {
  try {
    const { title, slug, excerpt, content, category, tags, featuredImage, metaTitle, metaDescription, keywords, published } = req.body;
    
    if (!title || !slug || !excerpt || !content) {
      return res.status(400).json({ message: 'Brakuje wymaganych pól' });
    }
    
    // Oblicz czas czytania (średnio 200 słów na minutę)
    const wordCount = content.split(/\s+/).length;
    const readingTime = Math.ceil(wordCount / 200);
    
    const post = await BlogPost.create({
      title,
      slug,
      excerpt,
      content,
      category: category || 'porady',
      tags: tags || [],
      featuredImage,
      metaTitle: metaTitle || title,
      metaDescription: metaDescription || excerpt,
      keywords: keywords || [],
      published: published || false,
      author: req.user._id,
      readingTime
    });
    
    res.status(201).json(post);
  } catch (error) {
    console.error('Error creating blog post:', error);
    if (error.code === 11000) {
      return res.status(400).json({ message: 'Post o tym slug już istnieje' });
    }
    res.status(500).json({ message: 'Błąd tworzenia posta' });
  }
});

// PUT /api/blog/:id - aktualizuj post (admin only)
router.put('/:id', auth, requireRole('admin'), async (req, res) => {
  try {
    const { title, slug, excerpt, content, category, tags, featuredImage, metaTitle, metaDescription, keywords, published } = req.body;
    
    const post = await BlogPost.findById(req.params.id);
    if (!post) {
      return res.status(404).json({ message: 'Post nie znaleziony' });
    }
    
    // Oblicz czas czytania jeśli content się zmienił
    if (content && content !== post.content) {
      const wordCount = content.split(/\s+/).length;
      post.readingTime = Math.ceil(wordCount / 200);
    }
    
    if (title) post.title = title;
    if (slug) post.slug = slug;
    if (excerpt) post.excerpt = excerpt;
    if (content) post.content = content;
    if (category) post.category = category;
    if (tags) post.tags = tags;
    if (featuredImage !== undefined) post.featuredImage = featuredImage;
    if (metaTitle) post.metaTitle = metaTitle;
    if (metaDescription) post.metaDescription = metaDescription;
    if (keywords) post.keywords = keywords;
    if (published !== undefined) {
      post.published = published;
      if (published && !post.publishedAt) {
        post.publishedAt = new Date();
      }
    }
    
    await post.save();
    res.json(post);
  } catch (error) {
    console.error('Error updating blog post:', error);
    res.status(500).json({ message: 'Błąd aktualizacji posta' });
  }
});

// DELETE /api/blog/:id - usuń post (admin only)
router.delete('/:id', auth, requireRole('admin'), async (req, res) => {
  try {
    const post = await BlogPost.findByIdAndDelete(req.params.id);
    if (!post) {
      return res.status(404).json({ message: 'Post nie znaleziony' });
    }
    res.json({ message: 'Post usunięty' });
  } catch (error) {
    console.error('Error deleting blog post:', error);
    res.status(500).json({ message: 'Błąd usuwania posta' });
  }
});

module.exports = router;










