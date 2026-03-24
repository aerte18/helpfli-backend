/**
 * Konfiguracja Swagger/OpenAPI dla dokumentacji API
 */

const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');

const options = {
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'Helpfli API',
      version: '2.0.0',
      description: `
        API dla platformy Helpfli - marketplace usług lokalnych.
        
        ## Autoryzacja
        Większość endpointów wymaga tokenu autoryzacji w nagłówku:
        \`\`\`
        Authorization: Bearer YOUR_TOKEN
        \`\`\`
        
        ## Rate Limiting
        - API: 100 requests/15min (production), 5000/15min (development)
        - Auth: 5 requests/15min (production), 500/15min (development)
        - Search: 30 requests/minute
        
        ## Status Codes
        - 200: Sukces
        - 201: Utworzono
        - 400: Błąd walidacji
        - 401: Brak autoryzacji
        - 403: Brak uprawnień
        - 404: Nie znaleziono
        - 429: Zbyt wiele requestów (rate limit)
        - 500: Błąd serwera
      `,
      contact: {
        name: 'Helpfli Support',
        email: 'support@helpfli.app'
      },
      license: {
        name: 'ISC'
      }
    },
    servers: [
      {
        url: process.env.SERVER_URL || 'http://localhost:5000/api',
        description: process.env.NODE_ENV === 'production' ? 'Production server' : 'Development server'
      }
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
          description: 'Token JWT uzyskany z endpointu /api/auth/login'
        }
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error: {
              type: 'string',
              description: 'Typ błędu'
            },
            message: {
              type: 'string',
              description: 'Komunikat błędu'
            },
            details: {
              type: 'array',
              items: {
                type: 'object'
              },
              description: 'Szczegóły błędów walidacji (opcjonalne)'
            }
          }
        },
        User: {
          type: 'object',
          properties: {
            _id: { type: 'string' },
            name: { type: 'string' },
            email: { type: 'string' },
            role: { 
              type: 'string',
              enum: ['client', 'provider', 'admin', 'company_owner', 'company_manager']
            },
            avatar: { type: 'string', nullable: true },
            phone: { type: 'string', nullable: true },
            isActive: { type: 'boolean' },
            emailVerified: { type: 'boolean' },
            company: { type: 'string', nullable: true },
            roleInCompany: { 
              type: 'string',
              enum: ['owner', 'manager', 'member'],
              nullable: true
            }
          }
        },
        Provider: {
          type: 'object',
          properties: {
            _id: { type: 'string' },
            name: { type: 'string' },
            email: { type: 'string' },
            avatar: { type: 'string', nullable: true },
            rating: { type: 'number', format: 'float' },
            ratingCount: { type: 'integer' },
            distanceKm: { type: 'number', format: 'float', nullable: true },
            isOnline: { type: 'boolean' },
            providerTier: { 
              type: 'string',
              enum: ['basic', 'standard', 'pro']
            },
            verified: { type: 'boolean' },
            services: {
              type: 'array',
              items: { type: 'string' }
            },
            locationLat: { type: 'number', format: 'float', nullable: true },
            locationLon: { type: 'number', format: 'float', nullable: true }
          }
        },
        Order: {
          type: 'object',
          properties: {
            _id: { type: 'string' },
            client: { type: 'string' },
            provider: { type: 'string', nullable: true },
            service: { type: 'string' },
            description: { type: 'string' },
            status: {
              type: 'string',
              enum: ['pending', 'accepted', 'in_progress', 'completed', 'cancelled']
            },
            amountTotal: { 
              type: 'integer',
              description: 'Kwota w groszach'
            },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' }
          }
        }
      }
    },
    tags: [
      { name: 'Authentication', description: 'Autoryzacja i uwierzytelnianie' },
      { name: 'Providers', description: 'Zarządzanie wykonawcami' },
      { name: 'Orders', description: 'Zlecenia' },
      { name: 'AI', description: 'Funkcje AI (Concierge, Matching, Pricing)' },
      { name: 'Subscriptions', description: 'Subskrypcje i plany' },
      { name: 'Payments', description: 'Płatności' },
      { name: 'Video', description: 'Wideo-wizyty' },
      { name: 'Social', description: 'Funkcje społecznościowe (recenzje, portfolio, referral)' },
      { name: 'Integrations', description: 'Integracje zewnętrzne' },
      { name: 'Analytics', description: 'Analytics i metryki (tylko admin)' },
      { name: 'System', description: 'Systemowe endpointy (health, etc.)' }
    ]
  },
  apis: [
    './routes/*.js',
    './server.js'
  ]
};

const swaggerSpec = swaggerJsdoc(options);

module.exports = {
  swaggerSpec,
  swaggerUi
};

