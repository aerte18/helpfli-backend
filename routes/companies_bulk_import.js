const express = require('express');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const Company = require('../models/Company');
const User = require('../models/User');
const UserSubscription = require('../models/UserSubscription');
const SubscriptionPlan = require('../models/SubscriptionPlan');
const { auth } = require('../middleware/auth');
const { requireCompanyAccess, checkCompanyLimits } = require('../middleware/companyMiddleware');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const NotificationService = require('../services/NotificationService');

const router = express.Router();

// Konfiguracja multer dla plików CSV
const storage = multer.memoryStorage();
const upload = multer({
  storage: storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Tylko pliki CSV są dozwolone'));
    }
  }
});

// POST /api/companies/:companyId/bulk-import - Import wykonawców z CSV
router.post('/:companyId/bulk-import', 
  auth, 
  requireCompanyAccess, 
  checkCompanyLimits,
  upload.single('file'),
  async (req, res) => {
    try {
      if (!req.companyAccess.canManage) {
        return res.status(403).json({ message: 'Brak uprawnień do importu wykonawców' });
      }

      if (!req.file) {
        return res.status(400).json({ message: 'Brak pliku CSV' });
      }

      const company = await Company.findById(req.companyId);
      if (!company) {
        return res.status(404).json({ message: 'Firma nie została znaleziona' });
      }

      // Sprawdź limit użytkowników
      const ownerSubscription = await UserSubscription.findOne({
        user: company.owner,
        status: 'active',
        isBusinessPlan: true
      }).lean();

      let maxUsers = company.settings?.maxProviders || 50;
      if (ownerSubscription && ownerSubscription.planKey) {
        const plan = await SubscriptionPlan.findOne({ key: ownerSubscription.planKey }).lean();
        if (plan && plan.maxUsers) {
          maxUsers = plan.maxUsers;
        }
      }

      const currentMembers = 1 + (company.managers?.length || 0) + (company.providers?.length || 0);

      // Parsuj CSV
      const results = [];
      const errors = [];
      const buffer = req.file.buffer;
      const stream = Readable.from(buffer.toString('utf-8'));

      await new Promise((resolve, reject) => {
        stream
          .pipe(csv())
          .on('data', (row) => {
            // Oczekiwane kolumny: email, name, role (opcjonalnie)
            const email = (row.email || row.Email || '').trim();
            const name = (row.name || row.Name || row['Imię i nazwisko'] || '').trim();
            const role = (row.role || row.Role || 'provider').trim().toLowerCase();

            if (!email || !name) {
              errors.push({
                row: results.length + errors.length + 1,
                email: email || 'BRAK',
                error: 'Brak email lub imienia i nazwiska'
              });
              return;
            }

            // Walidacja email
            const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
            if (!emailRegex.test(email)) {
              errors.push({
                row: results.length + errors.length + 1,
                email,
                error: 'Nieprawidłowy format email'
              });
              return;
            }

            // Walidacja roli
            if (role !== 'provider' && role !== 'manager') {
              errors.push({
                row: results.length + errors.length + 1,
                email,
                error: `Nieprawidłowa rola: ${role}. Dozwolone: provider, manager`
              });
              return;
            }

            results.push({ email, name, role });
          })
          .on('end', resolve)
          .on('error', reject);
      });

      if (results.length === 0) {
        return res.status(400).json({ 
          message: 'Brak poprawnych danych w pliku CSV',
          errors 
        });
      }

      // Sprawdź czy nie przekroczymy limitu
      if (currentMembers + results.length > maxUsers) {
        return res.status(403).json({
          message: `Import przekroczyłby limit członków zespołu. Obecnie: ${currentMembers}, próba dodania: ${results.length}, limit: ${maxUsers}`,
          current: currentMembers,
          attempting: results.length,
          limit: maxUsers
        });
      }

      // Przetwórz każdy wiersz
      const importResults = {
        success: [],
        skipped: [],
        failed: []
      };

      for (const row of results) {
        try {
          // Sprawdź czy użytkownik już istnieje
          let user = await User.findOne({ email: row.email });

          if (user) {
            // Istniejący użytkownik
            if (user.isInCompany()) {
              importResults.skipped.push({
                email: row.email,
                name: row.name,
                reason: 'Użytkownik już należy do firmy'
              });
              continue;
            }

            if (user.companyInvitation && user.companyInvitation.status === 'pending') {
              importResults.skipped.push({
                email: row.email,
                name: row.name,
                reason: 'Użytkownik ma już aktywne zaproszenie'
              });
              continue;
            }

            // Wyślij zaproszenie
            user.companyInvitation = {
              companyId: req.companyId,
              invitedBy: req.user._id,
              invitedAt: new Date(),
              status: 'pending',
              expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
            };
            await user.save();

            await NotificationService.sendNotification(
              'company_invitation',
              [user._id],
              {
                companyName: company.name,
                inviterName: req.user.name
              }
            );

            importResults.success.push({
              email: row.email,
              name: row.name,
              type: 'invitation'
            });
          } else {
            // Nowy użytkownik - utwórz konto
            const tempPassword = crypto.randomBytes(12).toString('base64').replace(/[^a-zA-Z0-9]/g, '').substring(0, 12);
            const hashedPassword = await bcrypt.hash(tempPassword, 10);

            const newUser = await User.create({
              name: row.name,
              email: row.email,
              password: hashedPassword,
              role: row.role === 'manager' ? 'company_manager' : 'provider',
              company: req.companyId,
              roleInCompany: row.role,
              emailVerified: true,
              requiresPasswordChange: true,
              onboardingCompleted: false
            });

            if (row.role === 'manager') {
              await company.addManager(newUser._id);
            } else {
              await company.addProvider(newUser._id);
            }

            await NotificationService.sendNotification(
              'company_account_created',
              [newUser._id],
              {
                companyName: company.name,
                providerName: row.name,
                email: row.email,
                tempPassword,
                inviterName: req.user.name
              }
            );

            importResults.success.push({
              email: row.email,
              name: row.name,
              type: 'account_created'
            });
          }
        } catch (error) {
          importResults.failed.push({
            email: row.email,
            name: row.name,
            error: error.message
          });
        }
      }

      // Aktualizuj krok onboardingu
      if (!company.onboardingSteps.teamAdded && importResults.success.length > 0) {
        company.onboardingSteps.teamAdded = true;
        await company.save();
      }

      res.json({
        success: true,
        message: `Import zakończony: ${importResults.success.length} sukcesów, ${importResults.skipped.length} pominiętych, ${importResults.failed.length} błędów`,
        results: importResults,
        errors: errors.length > 0 ? errors : undefined
      });
    } catch (error) {
      console.error('Bulk import error:', error);
      res.status(500).json({ message: 'Błąd importu', error: error.message });
    }
  }
);

module.exports = router;

