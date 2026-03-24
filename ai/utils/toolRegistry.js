/**
 * Tool Registry
 * Rejestr narzędzi dostępnych dla AI agentów
 * Pozwala agentom wykonywać akcje bezpośrednio
 */

class ToolRegistry {
  constructor() {
    this.tools = new Map();
    this.registerDefaultTools();
  }

  /**
   * Rejestruj narzędzie
   */
  register(name, tool) {
    this.tools.set(name, {
      name,
      description: tool.description,
      parameters: tool.parameters || {},
      handler: tool.handler,
      requiresAuth: tool.requiresAuth !== false, // Domyślnie wymaga auth
      allowedAgents: tool.allowedAgents || ['concierge', 'provider_orchestrator']
    });
  }

  /**
   * Rejestruj domyślne narzędzia
   */
  registerDefaultTools() {
    // createOrder - tworzenie zlecenia
    this.register('createOrder', {
      description: 'Tworzy nowe zlecenie na podstawie danych z konwersacji. Wymaga: service, description, location.',
      parameters: {
        type: 'object',
        properties: {
          service: {
            type: 'string',
            description: 'Kod usługi (np. hydraulik, elektryk)'
          },
          description: {
            type: 'string',
            description: 'Opis problemu'
          },
          location: {
            type: 'string',
            description: 'Lokalizacja (miasto)'
          },
          urgency: {
            type: 'string',
            enum: ['low', 'standard', 'urgent'],
            description: 'Pilność zlecenia'
          },
          budget: {
            type: 'object',
            properties: {
              min: { type: 'number' },
              max: { type: 'number' }
            }
          }
        },
        required: ['service', 'description', 'location']
      },
      handler: require('../tools/createOrderTool'),
      allowedAgents: ['concierge', 'order_draft']
    });

    // searchProviders - wyszukiwanie wykonawców
    this.register('searchProviders', {
      description: 'Wyszukuje wykonawców dla określonej usługi i lokalizacji. Zwraca listę TOP 3-5 wykonawców.',
      parameters: {
        type: 'object',
        properties: {
          service: {
            type: 'string',
            description: 'Kod usługi'
          },
          location: {
            type: 'string',
            description: 'Lokalizacja (miasto)'
          },
          lat: {
            type: 'number',
            description: 'Szerokość geograficzna (opcjonalnie)'
          },
          lng: {
            type: 'number',
            description: 'Długość geograficzna (opcjonalnie)'
          },
          limit: {
            type: 'number',
            description: 'Maksymalna liczba wyników (domyślnie 5)'
          }
        },
        required: ['service']
      },
      handler: require('../tools/searchProvidersTool'),
      allowedAgents: ['concierge', 'matching', 'provider_orchestrator']
    });

    // checkAvailability - sprawdzanie dostępności
    this.register('checkAvailability', {
      description: 'Sprawdza dostępność wykonawcy dla określonego terminu.',
      parameters: {
        type: 'object',
        properties: {
          providerId: {
            type: 'string',
            description: 'ID wykonawcy'
          },
          date: {
            type: 'string',
            description: 'Data w formacie ISO (YYYY-MM-DD)'
          },
          timeSlot: {
            type: 'string',
            description: 'Przedział czasowy (np. "morning", "afternoon", "evening")'
          }
        },
        required: ['providerId', 'date']
      },
      handler: require('../tools/checkAvailabilityTool'),
      allowedAgents: ['concierge', 'matching']
    });

    // getPriceHints - pobieranie widełek cenowych
    this.register('getPriceHints', {
      description: 'Pobiera widełki cenowe dla usługi w określonej lokalizacji.',
      parameters: {
        type: 'object',
        properties: {
          service: {
            type: 'string',
            description: 'Kod usługi'
          },
          location: {
            type: 'string',
            description: 'Lokalizacja (miasto)'
          },
          urgency: {
            type: 'string',
            enum: ['low', 'standard', 'urgent']
          }
        },
        required: ['service']
      },
      handler: require('../tools/getPriceHintsTool'),
      allowedAgents: ['concierge', 'pricing', 'provider_orchestrator', 'offer']
    });

    // webSearch - wyszukiwanie w internecie
    this.register('webSearch', {
      description: 'Wyszukuje informacje w internecie dla rzadkich lub niszowych problemów.',
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Zapytanie wyszukiwawcze'
          },
          maxResults: {
            type: 'number',
            description: 'Maksymalna liczba wyników (domyślnie 5)'
          }
        },
        required: ['query']
      },
      handler: require('../tools/webSearchTool'),
      allowedAgents: ['concierge', 'diagnostic', 'diy']
    });

    // listMyOrders - lista zleceń klienta (zarządzanie w czacie)
    this.register('listMyOrders', {
      description: 'Pobiera listę zleceń zalogowanego klienta. Użyj gdy użytkownik prosi o "moje zlecenia", "pokaż zlecenia", "lista zleceń".',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'number', description: 'Maks. liczba zleceń (domyślnie 20)' }
        },
        required: []
      },
      handler: require('../tools/listMyOrdersTool'),
      allowedAgents: ['concierge']
    });

    // extendOrder - przedłużenie zlecenia
    this.register('extendOrder', {
      description: 'Przedłuża czas zlecenia (tylko zlecenia otwarte lub zbierające oferty). Użyj gdy klient mówi "przedłuż zlecenie", "wydłuż termin".',
      parameters: {
        type: 'object',
        properties: {
          orderId: { type: 'string', description: 'ID zlecenia' },
          hours: { type: 'number', description: 'O ile godzin przedłużyć (domyślnie 24)' },
          reason: { type: 'string', description: 'Opcjonalny powód' }
        },
        required: ['orderId']
      },
      handler: require('../tools/extendOrderTool'),
      allowedAgents: ['concierge']
    });

    // cancelOrder - anulowanie zlecenia
    this.register('cancelOrder', {
      description: 'Anuluje zlecenie (tylko zlecenia ze statusem open, bez zaakceptowanej oferty). Użyj gdy klient mówi "anuluj zlecenie".',
      parameters: {
        type: 'object',
        properties: {
          orderId: { type: 'string', description: 'ID zlecenia' }
        },
        required: ['orderId']
      },
      handler: require('../tools/cancelOrderTool'),
      allowedAgents: ['concierge']
    });

    // searchOrdersForProvider - wyszukiwanie najlepszych zleceń dla wykonawcy
    this.register('searchOrdersForProvider', {
      description: 'Wyszukuje zlecenia otwarte najlepiej dopasowane do wykonawcy (usługi, lokalizacja) lub posortowane według potencjału zarobku. Użyj gdy provider pyta o "najlepsze zlecenia", "gdzie zarobić", "dopasowane do mnie", "szukam zleceń".',
      parameters: {
        type: 'object',
        properties: {
          sortBy: {
            type: 'string',
            enum: ['best_match', 'earning_potential'],
            description: 'best_match = dopasowanie do usług i lokalizacji; earning_potential = najwyższy budżet pierwszy'
          },
          limit: { type: 'number', description: 'Maks. liczba zleceń (domyślnie 15)' }
        },
        required: []
      },
      handler: require('../tools/searchOrdersForProviderTool'),
      allowedAgents: ['provider_orchestrator']
    });
  }

  /**
   * Pobierz narzędzie
   */
  get(name) {
    return this.tools.get(name);
  }

  /**
   * Sprawdź czy narzędzie jest dostępne dla agenta
   */
  isAvailableForAgent(toolName, agentType) {
    const tool = this.tools.get(toolName);
    if (!tool) return false;
    return tool.allowedAgents.includes(agentType);
  }

  /**
   * Pobierz wszystkie dostępne narzędzia dla agenta
   */
  getAvailableTools(agentType) {
    return Array.from(this.tools.values())
      .filter(tool => tool.allowedAgents.includes(agentType))
      .map(tool => ({
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }));
  }

  /**
   * Wykonaj narzędzie
   */
  async execute(name, params, context) {
    const tool = this.tools.get(name);
    
    if (!tool) {
      throw new Error(`Tool ${name} not found`);
    }

    // Sprawdź czy agent ma dostęp
    if (!this.isAvailableForAgent(name, context.agentType)) {
      throw new Error(`Tool ${name} is not available for agent ${context.agentType}`);
    }

    // Sprawdź autentykację jeśli wymagane
    if (tool.requiresAuth && !context.userId) {
      throw new Error(`Tool ${name} requires authentication`);
    }

    // Walidacja parametrów (uproszczona)
    if (tool.parameters.required) {
      for (const required of tool.parameters.required) {
        if (!params[required]) {
          throw new Error(`Missing required parameter: ${required}`);
        }
      }
    }

    // Wykonaj narzędzie
    try {
      const result = await tool.handler(params, context);
      return {
        success: true,
        result
      };
    } catch (error) {
      console.error(`Tool ${name} execution error:`, error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Pobierz schema narzędzi dla Claude API
   */
  getToolsSchema(agentType) {
    return this.getAvailableTools(agentType).map(tool => ({
      name: tool.name,
      description: tool.description,
      input_schema: tool.parameters
    }));
  }
}

// Singleton instance
const toolRegistry = new ToolRegistry();

module.exports = toolRegistry;

