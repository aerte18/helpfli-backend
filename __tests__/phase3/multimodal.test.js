/**
 * Testy dla MultiModalService
 */

const multiModalService = require('../../services/MultiModalService');
const Anthropic = require('@anthropic-ai/sdk');

// Mock dla Anthropic SDK
jest.mock('@anthropic-ai/sdk');

describe('Phase 3: MultiModalService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('analyzeImage', () => {
    test('should return error if Claude client not available', async () => {
      // Temporarily remove client
      const originalClient = multiModalService.client;
      multiModalService.client = null;

      const result = await multiModalService.analyzeImage('https://example.com/image.jpg');

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();

      // Restore
      multiModalService.client = originalClient;
    });

    test('should analyze image successfully', async () => {
      const mockClient = {
        messages: {
          create: jest.fn().mockResolvedValue({
            content: [{
              type: 'text',
              text: 'Na obrazie widać wyciek wody z rury. Problem wymaga interwencji hydraulika.'
            }]
          })
        }
      };

      multiModalService.client = mockClient;

      const result = await multiModalService.analyzeImage('https://example.com/image.jpg');

      expect(result.success).toBe(true);
      expect(result.description).toBeDefined();
      expect(result.analysis).toBeDefined();
      expect(mockClient.messages.create).toHaveBeenCalled();
    });

    test('should extract structured info from description', async () => {
      const mockClient = {
        messages: {
          create: jest.fn().mockResolvedValue({
            content: [{
              type: 'text',
              text: 'Na obrazie widać wyciek wody z rury. To pilny problem wymagający natychmiastowej interwencji hydraulika.'
            }]
          })
        }
      };

      multiModalService.client = mockClient;

      const result = await multiModalService.analyzeImage('https://example.com/image.jpg');

      expect(result.success).toBe(true);
      expect(result.analysis.problems).toContain('water_leak');
      expect(result.analysis.urgency).toBe('urgent');
      expect(result.analysis.serviceHints).toContain('hydraulik');
    });
  });

  describe('analyzeMultipleImages', () => {
    test('should analyze multiple images', async () => {
      const mockClient = {
        messages: {
          create: jest.fn().mockResolvedValue({
            content: [{
              type: 'text',
              text: 'Na obrazach widać dwa problemy: wyciek wody i problem z instalacją elektryczną.'
            }]
          })
        }
      };

      multiModalService.client = mockClient;

      const imageUrls = [
        'https://example.com/image1.jpg',
        'https://example.com/image2.jpg'
      ];

      const result = await multiModalService.analyzeMultipleImages(imageUrls);

      expect(result.success).toBe(true);
      expect(result.imageCount).toBe(2);
      expect(mockClient.messages.create).toHaveBeenCalled();
    });
  });

  describe('prepareImageContent', () => {
    test('should handle base64 data URL', async () => {
      const base64Image = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
      
      const result = await multiModalService.prepareImageContent(base64Image);

      expect(result.type).toBe('base64');
      expect(result.media_type).toBe('image/jpeg');
      expect(result.data).toBeDefined();
    });

    test('should throw error for unsupported format', async () => {
      await expect(
        multiModalService.prepareImageContent('invalid://url')
      ).rejects.toThrow();
    });
  });

  describe('extractStructuredInfo', () => {
    test('should detect water leak problem', () => {
      const description = 'Na obrazie widać wyciek wody z rury.';
      const result = multiModalService.extractStructuredInfo(description);

      expect(result.problems).toContain('water_leak');
    });

    test('should detect urgent problems', () => {
      const description = 'To jest pilna awaria wymagająca natychmiastowej interwencji.';
      const result = multiModalService.extractStructuredInfo(description);

      expect(result.urgency).toBe('urgent');
    });

    test('should detect service hints', () => {
      const description = 'Problem z instalacją elektryczną wymaga interwencji elektryka.';
      const result = multiModalService.extractStructuredInfo(description);

      expect(result.serviceHints).toContain('elektryk');
    });

    test('should default to standard urgency', () => {
      const description = 'To jest normalny problem, może poczekać.';
      const result = multiModalService.extractStructuredInfo(description);

      expect(result.urgency).toBe('low');
    });
  });
});

