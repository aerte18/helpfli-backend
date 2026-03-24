const mongoose = require('mongoose');

const emailTemplateSchema = new mongoose.Schema({
  key: { type: String, required: true, unique: true, index: true }, // Unikalny klucz szablonu (np. 'subscription_expiry_7days')
  name: { type: String, required: true }, // Nazwa szablonu (np. 'Subskrypcja wygasa za 7 dni')
  subject: { type: String, required: true }, // Temat emaila (może zawierać zmienne {{variableName}})
  htmlBody: { type: String, required: true }, // Treść HTML (może zawierać zmienne {{variableName}})
  textBody: { type: String }, // Treść tekstowa (opcjonalnie)
  variables: [{ type: String }], // Lista dostępnych zmiennych (np. ['userName', 'expiryDate', 'planName'])
  category: { 
    type: String, 
    enum: ['subscription', 'promo', 'order', 'payment', 'system', 'other'],
    default: 'other'
  },
  isActive: { type: Boolean, default: true },
  isSystem: { type: Boolean, default: false }, // Systemowe szablony nie mogą być usunięte
  description: { type: String }, // Opis szablonu
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // Kto utworzył (admin)
  updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // Kto ostatnio zaktualizował
  version: { type: Number, default: 1 }, // Wersja szablonu
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
}, {
  timestamps: true
});

// Metoda do renderowania szablonu z danymi
emailTemplateSchema.methods.render = function(data = {}) {
  let subject = this.subject;
  let htmlBody = this.htmlBody;
  let textBody = this.textBody || '';

  // Zamień zmienne {{variableName}} na wartości z data
  Object.keys(data).forEach(key => {
    const regex = new RegExp(`{{\\s*${key}\\s*}}`, 'g');
    subject = subject.replace(regex, data[key] || '');
    htmlBody = htmlBody.replace(regex, data[key] || '');
    textBody = textBody.replace(regex, data[key] || '');
  });

  return { subject, htmlBody, textBody };
};

module.exports = mongoose.model('EmailTemplate', emailTemplateSchema);

