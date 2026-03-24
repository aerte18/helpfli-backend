?const crypto = require('crypto');
const { sendMail } = require('../utils/email');
const User = require('../models/User');

class EmailVerificationService {
  // Generuje token weryfikacyjny
  static generateVerificationToken() {
    return crypto.randomBytes(32).toString('hex');
  }

  // Wysyła email weryfikacyjny
  static async sendVerificationEmail(user) {
    const token = this.generateVerificationToken();
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 godziny

    // Zapisuj token w bazie
    user.emailVerificationToken = token;
    user.emailVerificationExpires = expiresAt;
    await user.save();

    // Twórz link weryfikacyjny
    const verificationUrl = `${process.env.CLIENT_URL}/verify-email?token=${token}`;

    // HTML emaila
    const html = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
        <div style="text-align: center; margin-bottom: 30px;">
          <h1 style="color: #4F46E5; margin: 0;">Helpfli</h1>
          <p style="color: #6B7280; margin: 10px 0;">Potwierdź swój adres email</p>
        </div>
        
        <div style="background: #F9FAFB; padding: 30px; border-radius: 10px; margin-bottom: 20px;">
          <h2 style="color: #111827; margin: 0 0 20px 0;">Witaj ${user.name}!</h2>
          <p style="color: #374151; line-height: 1.6; margin: 0 0 20px 0;">
            Dziękujemy za rejestrację w Helpfli! Aby aktywować swoje konto, 
            kliknij w poniższy przycisk i potwierdź swój adres email.
          </p>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="${verificationUrl}" 
               style="background: #4F46E5; color: white; padding: 15px 30px; 
                      text-decoration: none; border-radius: 8px; font-weight: bold; 
                      display: inline-block;">
              Potwierdź Email
            </a>
          </div>
          
          <p style="color: #6B7280; font-size: 14px; margin: 0;">
            Jeśli przycisk nie działa, skopiuj i wklej ten link w przeglądarce:<br>
            <a href="${verificationUrl}" style="color: #4F46E5;">${verificationUrl}</a>
          </p>
        </div>
        
        <div style="text-align: center; color: #6B7280; font-size: 14px;">
          <p>Ten link wygasa za 24 godziny.</p>
          <p>Jeśli nie zakładałeś konta w Helpfli, możesz zignorować ten email.</p>
        </div>
      </div>
    `;

    // Wysyłaj email
    const result = await sendMail({
      to: user.email,
      subject: 'Potwierdź swój email - Helpfli',
      html
    });

    return result;
  }

  // Weryfikuje token
  static async verifyToken(token) {
    const user = await User.findOne({
      emailVerificationToken: token,
      emailVerificationExpires: { $gt: new Date() }
    });

    if (!user) {
      return { success: false, message: 'Nieprawidłowy lub wygasły token weryfikacyjny' };
    }

    // Oznacz email jako zweryfikowany
    user.emailVerified = true;
    user.emailVerificationToken = undefined;
    user.emailVerificationExpires = undefined;
    await user.save();

    return { success: true, user };
  }

  // Sprawdza czy użytkownik ma zweryfikowany email
  static async isEmailVerified(userId) {
    const user = await User.findById(userId);
    return user && user.emailVerified;
  }
}

module.exports = EmailVerificationService;



















