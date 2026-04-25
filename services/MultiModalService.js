/**
 * MultiModalService
 * Zaawansowana analiza obrazów i multimediów
 */

const Anthropic = require('@anthropic-ai/sdk');

class MultiModalService {
  constructor() {
    this.client = null;
    this.init();
  }

  init() {
    try {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (apiKey && apiKey.startsWith('sk-ant-')) {
        this.client = new Anthropic({ apiKey });
      }
    } catch (error) {
      console.warn('MultiModalService: Claude client not available:', error.message);
    }
  }

  /**
   * Analizuj obraz za pomocą Claude Vision API
   */
  async analyzeImage(imageUrl, prompt = 'Opisz co widzisz na tym obrazie.') {
    try {
      if (!this.client) {
        throw new Error('Claude API client not available');
      }

      // Konwertuj URL na base64 jeśli potrzeba (lub użyj bezpośrednio URL)
      const imageContent = await this.prepareImageContent(imageUrl);

      const response = await this.client.messages.create({
        model: process.env.CLAUDE_DEFAULT || 'claude-sonnet-4-6', // Vision-capable model
        max_tokens: 450,
        messages: [{
          role: 'user',
          content: [
            {
              type: 'image',
              source: imageContent
            },
            {
              type: 'text',
              text: prompt
            }
          ]
        }]
      });

      const text = response.content[0];
      if (text.type === 'text') {
        return {
          success: true,
          description: text.text,
          analysis: this.extractStructuredInfo(text.text)
        };
      }

      throw new Error('Unexpected response type from Claude Vision');
    } catch (error) {
      console.error('Error analyzing image:', error);
      return {
        success: false,
        error: error.message,
        description: null,
        analysis: null
      };
    }
  }

  /**
   * Przygotuj zawartość obrazu dla Claude API
   */
  async prepareImageContent(imageUrl) {
    // Jeśli to URL, pobierz i konwertuj na base64
    // Jeśli to już base64, użyj bezpośrednio
    if (imageUrl.startsWith('data:image')) {
      // Base64 data URL
      const matches = imageUrl.match(/^data:image\/(\w+);base64,(.+)$/);
      if (matches) {
        return {
          type: 'base64',
          media_type: `image/${matches[1]}`,
          data: matches[2]
        };
      }
    }

    if (imageUrl.startsWith('/uploads/')) {
      const fs = require('fs');
      const path = require('path');
      const filePath = this.resolveLocalUploadPath(imageUrl);

      const buffer = await fs.promises.readFile(filePath);
      const ext = path.extname(filePath).toLowerCase().replace('.', '');
      const mediaType = ext === 'png'
        ? 'image/png'
        : ext === 'webp'
          ? 'image/webp'
          : ext === 'gif'
            ? 'image/gif'
            : 'image/jpeg';
      return {
        type: 'base64',
        media_type: mediaType,
        data: buffer.toString('base64')
      };
    }

    // Jeśli to URL, pobierz i konwertuj
    if (imageUrl.startsWith('http://') || imageUrl.startsWith('https://')) {
      try {
        const https = require('https');
        const http = require('http');
        const url = require('url');
        
        return new Promise((resolve, reject) => {
          const parsedUrl = url.parse(imageUrl);
          const client = parsedUrl.protocol === 'https:' ? https : http;
          
          client.get(imageUrl, (res) => {
            const chunks = [];
            res.on('data', chunk => chunks.push(chunk));
            res.on('end', () => {
              const buffer = Buffer.concat(chunks);
              const base64 = buffer.toString('base64');
              const contentType = res.headers['content-type'] || 'image/jpeg';
              
              resolve({
                type: 'base64',
                media_type: contentType,
                data: base64
              });
            });
          }).on('error', reject);
        });
      } catch (error) {
        throw new Error(`Failed to fetch image: ${error.message}`);
      }
    }

    throw new Error('Unsupported image format');
  }

  resolveLocalUploadPath(publicPath) {
    const fs = require('fs');
    const path = require('path');
    const UPLOAD_DIR = process.env.UPLOAD_DIR || 'uploads';
    const configuredRoot = path.isAbsolute(UPLOAD_DIR)
      ? UPLOAD_DIR
      : path.join(__dirname, '..', UPLOAD_DIR);
    const relative = String(publicPath).replace(/^\/uploads\/?/, '');
    const candidates = [
      path.join(configuredRoot, relative),
      path.join(__dirname, '..', 'uploads', relative),
      path.join(process.cwd(), 'uploads', relative),
      path.join(process.cwd(), 'var', 'data', 'uploads', relative)
    ].map((candidate) => path.normalize(candidate));

    const normalizedRoots = [
      configuredRoot,
      path.join(__dirname, '..', 'uploads'),
      path.join(process.cwd(), 'uploads'),
      path.join(process.cwd(), 'var', 'data', 'uploads')
    ].map((root) => path.normalize(root));

    for (const candidate of candidates) {
      const isInsideUploadRoot = normalizedRoots.some((root) => candidate.startsWith(root));
      if (isInsideUploadRoot && fs.existsSync(candidate)) {
        return candidate;
      }
    }

    throw new Error(`Local uploaded image not found: ${publicPath}`);
  }

  /**
   * Wyekstraktuj strukturyzowane informacje z opisu obrazu
   */
  extractStructuredInfo(description) {
    const info = {
      objects: [],
      problems: [],
      urgency: 'standard',
      serviceHints: []
    };

    const text = description.toLowerCase();

    // Wykryj problemy
    const problemKeywords = {
      'wyciek': 'water_leak',
      'przerwa': 'power_outage',
      'zapach': 'gas_smell',
      'dym': 'smoke',
      'pęknięcie': 'crack',
      'uszkodzenie': 'damage',
      'awaria': 'failure'
    };

    for (const [keyword, problem] of Object.entries(problemKeywords)) {
      if (text.includes(keyword)) {
        info.problems.push(problem);
      }
    }

    // Wykryj pilność
    if (text.includes('piln') || text.includes('awaria') || text.includes('wyciek')) {
      info.urgency = 'urgent';
    } else if (text.includes('może poczekać') || text.includes('nie piln')) {
      info.urgency = 'low';
    }

    // Wykryj wskazówki dotyczące usługi
    const serviceKeywords = {
      'hydraulik': 'hydraulik',
      'elektryk': 'elektryk',
      'rury': 'hydraulik',
      'prąd': 'elektryk',
      'gaz': 'hydraulik',
      'woda': 'hydraulik'
    };

    for (const [keyword, service] of Object.entries(serviceKeywords)) {
      if (text.includes(keyword)) {
        info.serviceHints.push(service);
      }
    }

    return info;
  }

  /**
   * Analizuj wiele obrazów jednocześnie
   */
  async analyzeMultipleImages(imageUrls, prompt = 'Opisz co widzisz na obrazach.') {
    try {
      if (!this.client) {
        throw new Error('Claude API client not available');
      }

      const imageContents = await Promise.all(
        imageUrls.map(url => this.prepareImageContent(url))
      );

      const content = [
        ...imageContents.map(img => ({ type: 'image', source: img })),
        { type: 'text', text: prompt }
      ];

      const response = await this.client.messages.create({
        model: process.env.CLAUDE_DEFAULT || 'claude-sonnet-4-6',
        max_tokens: 650,
        messages: [{
          role: 'user',
          content
        }]
      });

      const text = response.content[0];
      if (text.type === 'text') {
        return {
          success: true,
          description: text.text,
          analysis: this.extractStructuredInfo(text.text),
          imageCount: imageUrls.length
        };
      }

      throw new Error('Unexpected response type');
    } catch (error) {
      console.error('Error analyzing multiple images:', error);
      return {
        success: false,
        error: error.message,
        description: null,
        analysis: null
      };
    }
  }
}

// Singleton instance
const multiModalService = new MultiModalService();

module.exports = multiModalService;

