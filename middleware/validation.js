const Ajv = require('ajv');
const addFormats = require('ajv-formats');

const ajv = new Ajv({ allErrors: true });
addFormats(ajv);

// Schemas for critical endpoints
const schemas = {
  // Auth endpoints
  login: {
    type: 'object',
    properties: {
      email: { type: 'string', format: 'email' },
      password: { type: 'string', minLength: 6 }
    },
    required: ['email', 'password'],
    additionalProperties: false
  },

  register: {
    type: 'object',
    properties: {
      email: { type: 'string', format: 'email' },
      password: { type: 'string', minLength: 6 },
      name: { type: 'string', minLength: 2 },
      role: { type: 'string', enum: ['client', 'provider'] },
      phone: { type: 'string' },
      address: { type: 'string' },
      locationCoords: {
        type: 'object',
        properties: { lat: { type: 'number' }, lng: { type: 'number' } },
        additionalProperties: true
      },
      isB2B: { type: 'boolean' },
      notificationPreferences: {
        type: 'object',
        properties: {
          marketing: {
            type: 'object',
            properties: { sms: { type: 'boolean' }, email: { type: 'boolean' } },
            additionalProperties: true
          }
        },
        additionalProperties: true
      },
      company: { type: 'object' },
      billing: { type: 'object' }
    },
    required: ['email', 'password', 'name', 'role'],
    additionalProperties: true
  },

  // AI Concierge endpoints
  aiAnalyze: {
    type: 'object',
    properties: {
      description: { type: 'string', minLength: 10 },
      problem: { type: 'string', minLength: 10 },
      locationText: { type: 'string' },
      lat: { type: 'number' },
      lon: { type: 'number' },
      urgency: { type: 'string', enum: ['low', 'medium', 'high', 'flex'] },
      imageUrls: { 
        type: 'array', 
        items: { type: 'string', format: 'uri' },
        maxItems: 5
      }
    },
    required: ['description'],
    additionalProperties: false
  },

  // KB endpoints
  kbCreate: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 5, maxLength: 200 },
      content: { type: 'string', minLength: 20 },
      category: { type: 'string', enum: ['general', 'technical', 'billing', 'support'] },
      tags: { 
        type: 'array', 
        items: { type: 'string', minLength: 2 },
        maxItems: 10
      },
      isActive: { type: 'boolean' }
    },
    required: ['title', 'content', 'category'],
    additionalProperties: false
  },

  kbUpdate: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 5, maxLength: 200 },
      content: { type: 'string', minLength: 20 },
      category: { type: 'string', enum: ['general', 'technical', 'billing', 'support'] },
      tags: { 
        type: 'array', 
        items: { type: 'string', minLength: 2 },
        maxItems: 10
      },
      isActive: { type: 'boolean' }
    },
    additionalProperties: false
  },

  // Push notification endpoints
  pushSubscribe: {
    type: 'object',
    properties: {
      endpoint: { type: 'string', format: 'uri' },
      keys: {
        type: 'object',
        properties: {
          p256dh: { type: 'string' },
          auth: { type: 'string' }
        },
        required: ['p256dh', 'auth'],
        additionalProperties: false
      }
    },
    required: ['endpoint', 'keys'],
    additionalProperties: false
  },

  // Order endpoints
  orderCreate: {
    type: 'object',
    properties: {
      title: { type: 'string', minLength: 5, maxLength: 200 },
      description: { type: 'string', minLength: 20 },
      service: { type: 'string', minLength: 2 },
      location: {
        type: 'object',
        properties: {
          address: { type: 'string' },
          coordinates: {
            type: 'object',
            properties: {
              lat: { type: 'number' },
              lng: { type: 'number' }
            },
            required: ['lat', 'lng'],
            additionalProperties: false
          }
        },
        required: ['address'],
        additionalProperties: false
      },
      budget: { type: 'number', minimum: 0 },
      urgency: { type: 'string', enum: ['low', 'medium', 'high'] }
    },
    required: ['title', 'description', 'service', 'location'],
    additionalProperties: false
  }
};

// Validation middleware factory
const validate = (schemaName) => {
  const schema = schemas[schemaName];
  if (!schema) {
    throw new Error(`Schema '${schemaName}' not found`);
  }

  const validateSchema = ajv.compile(schema);

  return (req, res, next) => {
    const isValid = validateSchema(req.body);
    
    if (!isValid) {
      const errors = validateSchema.errors.map(err => ({
        field: err.instancePath || err.schemaPath,
        message: err.message,
        value: err.data
      }));
      
      return res.status(400).json({
        error: 'JSON Schema validation failed',
        details: errors
      });
    }
    
    next();
  };
};

// Export schemas and validation middleware
module.exports = {
  schemas,
  validate,
  ajv
};
