/**
 * Testy dla Tool Calling (Faza 2)
 */

// Mock concierge.js przed require toolRegistry
jest.mock('../../utils/concierge', () => ({
  recommendProviders: jest.fn(() => Promise.resolve([])),
  computePriceHints: jest.fn(() => Promise.resolve({})),
  getCityPricingMultiplier: jest.fn(() => ({ multiplier: 1.0 }))
}));

const toolRegistry = require('../../ai/utils/toolRegistry');

describe('Phase 2: Tool Calling', () => {
  describe('ToolRegistry', () => {
    test('should have tools registered', () => {
      const tools = toolRegistry.getAvailableTools('concierge');
      expect(tools.length).toBeGreaterThan(0);
    });

    test('should return available tools for concierge agent', () => {
      const tools = toolRegistry.getAvailableTools('concierge');
      const toolNames = tools.map(t => t.name);
      
      expect(toolNames).toContain('createOrder');
      expect(toolNames).toContain('searchProviders');
      expect(toolNames).toContain('getPriceHints');
    });

    test('should check if tool is available for agent', () => {
      expect(toolRegistry.isAvailableForAgent('createOrder', 'concierge')).toBe(true);
      expect(toolRegistry.isAvailableForAgent('createOrder', 'provider_orchestrator')).toBe(false);
    });

    test('should get tool by name', () => {
      const tool = toolRegistry.get('createOrder');
      expect(tool).toBeDefined();
      expect(tool.name).toBe('createOrder');
      expect(tool.description).toBeDefined();
    });

    test('should get tools schema for Claude API', () => {
      const schema = toolRegistry.getToolsSchema('concierge');
      expect(Array.isArray(schema)).toBe(true);
      expect(schema.length).toBeGreaterThan(0);
      
      // Sprawdź strukturę
      const firstTool = schema[0];
      expect(firstTool).toHaveProperty('name');
      expect(firstTool).toHaveProperty('description');
      expect(firstTool).toHaveProperty('input_schema');
    });
  });

  describe('Tool Execution', () => {
    test('should validate parameters before execution', async () => {
      const context = {
        agentType: 'concierge',
        userId: null // Brak userId
      };

      // createOrder wymaga userId
      await expect(
        toolRegistry.execute('createOrder', { service: 'hydraulik' }, context)
      ).rejects.toThrow();
    });

    test('should reject tool not available for agent', async () => {
      const context = {
        agentType: 'diagnostic', // Diagnostic agent nie ma dostępu do createOrder
        userId: 'test123'
      };

      await expect(
        toolRegistry.execute('createOrder', {}, context)
      ).rejects.toThrow('not available for agent');
    });
  });
});
