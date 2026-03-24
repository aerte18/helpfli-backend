const express = require('express');
const router = express.Router();
const { authMiddleware } = require('../middleware/authMiddleware');
const User = require('../models/User');

// GET /api/favorite-clients - pobierz ulubionych klientów
router.get('/', authMiddleware, async (req, res) => {
  try {
    const provider = await User.findById(req.user._id).populate('favoriteClients', 'name email avatar');
    
    if (!provider || provider.role !== 'provider') {
      return res.status(403).json({ message: 'Dostęp tylko dla providerów' });
    }
    
    res.json(provider.favoriteClients || []);
  } catch (error) {
    console.error('❌ Błąd pobierania ulubionych klientów:', error);
    res.status(500).json({ message: 'Błąd pobierania danych' });
  }
});

// POST /api/favorite-clients/:clientId - dodaj klienta do ulubionych
router.post('/:clientId', authMiddleware, async (req, res) => {
  try {
    const { clientId } = req.params;
    const provider = await User.findById(req.user._id);
    
    if (!provider || provider.role !== 'provider') {
      return res.status(403).json({ message: 'Dostęp tylko dla providerów' });
    }
    
    // Sprawdź czy klient istnieje
    const client = await User.findById(clientId);
    if (!client || client.role !== 'client') {
      return res.status(404).json({ message: 'Klient nie istnieje' });
    }
    
    // Sprawdź czy już jest w ulubionych
    if (provider.favoriteClients.includes(clientId)) {
      return res.status(400).json({ message: 'Klient już jest w ulubionych' });
    }
    
    // Dodaj do ulubionych
    provider.favoriteClients.push(clientId);
    await provider.save();
    
    res.json({ message: 'Klient dodany do ulubionych', client: { _id: client._id, name: client.name, email: client.email } });
  } catch (error) {
    console.error('❌ Błąd dodawania ulubionego klienta:', error);
    res.status(500).json({ message: 'Błąd dodawania klienta' });
  }
});

// DELETE /api/favorite-clients/:clientId - usuń klienta z ulubionych
router.delete('/:clientId', authMiddleware, async (req, res) => {
  try {
    const { clientId } = req.params;
    const provider = await User.findById(req.user._id);
    
    if (!provider || provider.role !== 'provider') {
      return res.status(403).json({ message: 'Dostęp tylko dla providerów' });
    }
    
    // Usuń z ulubionych
    provider.favoriteClients = provider.favoriteClients.filter(id => id.toString() !== clientId);
    await provider.save();
    
    res.json({ message: 'Klient usunięty z ulubionych' });
  } catch (error) {
    console.error('❌ Błąd usuwania ulubionego klienta:', error);
    res.status(500).json({ message: 'Błąd usuwania klienta' });
  }
});

module.exports = router;



