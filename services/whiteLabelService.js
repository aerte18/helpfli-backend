?// Serwis do zarządzania white-label
const WhiteLabel = require('../models/WhiteLabel');
const crypto = require('crypto');
const dns = require('dns').promises;

class WhiteLabelService {
  /**
   * Tworzy nowy white-label
   */
  async createWhiteLabel(ownerId, companyId, data) {
    try {
      const { name, slug, branding, domains, ui } = data;
      
      // Sprawdź czy slug jest dostępny
      const existing = await WhiteLabel.findOne({ slug });
      if (existing) {
        throw new Error('Slug już istnieje');
      }
      
      const whiteLabel = await WhiteLabel.create({
        owner: ownerId,
        company: companyId || null,
        name,
        slug,
        branding: branding || {},
        domains: domains || [],
        ui: ui || {},
        status: 'pending',
        isActive: false
      });
      
      return whiteLabel;
    } catch (error) {
      console.error('CREATE_WHITELABEL_ERROR:', error);
      throw error;
    }
  }
  
  /**
   * Weryfikuje domenę (sprawdza DNS)
   */
  async verifyDomain(whiteLabelId, domain) {
    try {
      const whiteLabel = await WhiteLabel.findById(whiteLabelId);
      if (!whiteLabel) {
        throw new Error('White-label nie znaleziony');
      }
      
      const domainObj = whiteLabel.domains.find(d => d.domain === domain);
      if (!domainObj) {
        throw new Error('Domena nie znaleziona');
      }
      
      // Sprawdź DNS (uproszczone - w produkcji można sprawdzić TXT record)
      try {
        await dns.resolve4(domain);
        // Jeśli domena istnieje, oznacz jako zweryfikowaną
        domainObj.verified = true;
        domainObj.verifiedAt = new Date();
        await whiteLabel.save();
        
        return { verified: true, message: 'Domena zweryfikowana' };
      } catch (dnsError) {
        return { verified: false, message: 'Nie można zweryfikować domeny' };
      }
    } catch (error) {
      console.error('VERIFY_DOMAIN_ERROR:', error);
      throw error;
    }
  }
  
  /**
   * Generuje token weryfikacyjny dla domeny
   */
  generateDomainVerificationToken(domain) {
    const token = crypto.randomBytes(32).toString('hex');
    return {
      token,
      record: `helpfli-verify=${token}` // TXT record do dodania w DNS
    };
  }
  
  /**
   * Pobiera white-label po domenie
   */
  async getByDomain(domain) {
    try {
      const whiteLabel = await WhiteLabel.findOne({
        'domains.domain': domain,
        'domains.verified': true,
        isActive: true,
        status: 'active'
      });
      
      return whiteLabel;
    } catch (error) {
      console.error('GET_WHITELABEL_BY_DOMAIN_ERROR:', error);
      return null;
    }
  }
  
  /**
   * Pobiera white-label po slug
   */
  async getBySlug(slug) {
    try {
      const whiteLabel = await WhiteLabel.findOne({
        slug,
        isActive: true,
        status: 'active'
      });
      
      return whiteLabel;
    } catch (error) {
      console.error('GET_WHITELABEL_BY_SLUG_ERROR:', error);
      return null;
    }
  }
  
  /**
   * Generuje custom CSS z brandingiem
   */
  generateCustomCSS(branding) {
    const { primaryColor, secondaryColor, accentColor, backgroundColor, textColor, fontFamily } = branding;
    
    return `
      :root {
        --primary-color: ${primaryColor || '#3B82F6'};
        --secondary-color: ${secondaryColor || '#10B981'};
        --accent-color: ${accentColor || '#F59E0B'};
        --background-color: ${backgroundColor || '#FFFFFF'};
        --text-color: ${textColor || '#1F2937'};
        --font-family: ${fontFamily || 'Inter'}, sans-serif;
      }
      
      body {
        font-family: var(--font-family);
        color: var(--text-color);
        background-color: var(--background-color);
      }
      
      .btn-primary {
        background-color: var(--primary-color);
        border-color: var(--primary-color);
      }
      
      .btn-primary:hover {
        background-color: ${this.darkenColor(primaryColor || '#3B82F6')};
      }
      
      .text-primary {
        color: var(--primary-color);
      }
      
      .bg-primary {
        background-color: var(--primary-color);
      }
    `;
  }
  
  /**
   * Przyciemnia kolor (helper)
   */
  darkenColor(color) {
    // Uproszczone - w produkcji użyj biblioteki do manipulacji kolorami
    return color;
  }
  
  /**
   * Aktualizuje statystyki wizyt
   */
  async incrementVisit(whiteLabelId, isUnique = false) {
    try {
      const whiteLabel = await WhiteLabel.findById(whiteLabelId);
      if (whiteLabel) {
        whiteLabel.stats.totalVisits += 1;
        if (isUnique) {
          whiteLabel.stats.uniqueVisitors += 1;
        }
        whiteLabel.stats.lastVisitAt = new Date();
        await whiteLabel.save();
      }
    } catch (error) {
      console.error('INCREMENT_VISIT_ERROR:', error);
    }
  }
}

module.exports = new WhiteLabelService();













