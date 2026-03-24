const express = require('express');
const Company = require('../models/Company');
const User = require('../models/User');
const { auth } = require('../middleware/auth');
const { requireCompanyAccess } = require('../middleware/companyMiddleware');
const { logAction } = require('../utils/companyPermissions');

const router = express.Router();

// GET /api/companies/:companyId/provider-assignments - Pobierz przypisania wykonawców do usług
router.get('/:companyId/provider-assignments', auth, requireCompanyAccess, async (req, res) => {
  try {
    if (!req.companyAccess.canView) {
      return res.status(403).json({ message: 'Brak uprawnień do przeglądania przypisań' });
    }

    const company = await Company.findById(req.companyId)
      .populate('providerServiceAssignments.providerId', 'name email')
      .lean();

    if (!company) {
      return res.status(404).json({ message: 'Firma nie została znaleziona' });
    }

    res.json({
      success: true,
      assignments: company.providerServiceAssignments || []
    });
  } catch (error) {
    console.error('Error getting provider assignments:', error);
    res.status(500).json({ message: 'Błąd pobierania przypisań', error: error.message });
  }
});

// POST /api/companies/:companyId/provider-assignments - Przypisz wykonawcę do usług/kategorii
router.post('/:companyId/provider-assignments', auth, requireCompanyAccess, async (req, res) => {
  try {
    if (!req.companyAccess.canManage) {
      return res.status(403).json({ message: 'Brak uprawnień do zarządzania przypisaniami' });
    }

    const { providerId, serviceCodes, categoryIds, priority, autoAssign } = req.body;

    if (!providerId) {
      return res.status(400).json({ message: 'ID wykonawcy jest wymagane' });
    }

    const company = await Company.findById(req.companyId);
    if (!company) {
      return res.status(404).json({ message: 'Firma nie została znaleziona' });
    }

    // Sprawdź czy wykonawca należy do firmy
    const isProvider = company.providers.some(p => p.toString() === providerId);
    const isManager = company.managers.some(m => m.toString() === providerId);
    
    if (!isProvider && !isManager) {
      return res.status(400).json({ message: 'Wykonawca nie należy do tej firmy' });
    }

    // Usuń istniejące przypisanie dla tego wykonawcy
    company.providerServiceAssignments = (company.providerServiceAssignments || []).filter(
      a => a.providerId.toString() !== providerId
    );

    // Dodaj nowe przypisanie
    company.providerServiceAssignments.push({
      providerId,
      serviceCodes: serviceCodes || [],
      categoryIds: categoryIds || [],
      priority: priority || 0,
      autoAssign: autoAssign !== false
    });

    await company.save();

    // Loguj akcję
    const provider = await User.findById(providerId);
    await logAction(req.companyId, req.user._id, 'team.service_assignment', {
      targetUserId: providerId,
      targetUserName: provider?.name,
      serviceCodes: serviceCodes || [],
      categoryIds: categoryIds || [],
      priority: priority || 0
    }, {
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      description: `Przypisano wykonawcę ${provider?.name} do usług/kategorii`
    });

    res.json({
      success: true,
      message: 'Przypisanie zostało zapisane',
      assignment: company.providerServiceAssignments[company.providerServiceAssignments.length - 1]
    });
  } catch (error) {
    console.error('Error assigning provider:', error);
    res.status(500).json({ message: 'Błąd przypisywania wykonawcy', error: error.message });
  }
});

// DELETE /api/companies/:companyId/provider-assignments/:providerId - Usuń przypisanie wykonawcy
router.delete('/:companyId/provider-assignments/:providerId', auth, requireCompanyAccess, async (req, res) => {
  try {
    if (!req.companyAccess.canManage) {
      return res.status(403).json({ message: 'Brak uprawnień do zarządzania przypisaniami' });
    }

    const company = await Company.findById(req.companyId);
    if (!company) {
      return res.status(404).json({ message: 'Firma nie została znaleziona' });
    }

    const beforeCount = company.providerServiceAssignments?.length || 0;
    company.providerServiceAssignments = (company.providerServiceAssignments || []).filter(
      a => a.providerId.toString() !== req.params.providerId
    );

    if (company.providerServiceAssignments.length === beforeCount) {
      return res.status(404).json({ message: 'Przypisanie nie zostało znalezione' });
    }

    await company.save();

    // Loguj akcję
    const provider = await User.findById(req.params.providerId);
    await logAction(req.companyId, req.user._id, 'team.service_assignment_remove', {
      targetUserId: req.params.providerId,
      targetUserName: provider?.name
    }, {
      ipAddress: req.ip,
      userAgent: req.get('user-agent'),
      description: `Usunięto przypisanie wykonawcy ${provider?.name} do usług/kategorii`
    });

    res.json({
      success: true,
      message: 'Przypisanie zostało usunięte'
    });
  } catch (error) {
    console.error('Error removing assignment:', error);
    res.status(500).json({ message: 'Błąd usuwania przypisania', error: error.message });
  }
});

module.exports = router;






