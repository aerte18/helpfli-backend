const router = require('express').Router();
const { authMiddleware: auth } = require('../middleware/authMiddleware');
const requireAdmin = require('../middleware/requireAdmin');
const Order = require('../models/Order');

// Zabezpieczone middleware requireAdmin
router.get('/kpi', auth, requireAdmin, async (req,res)=>{
  try {
    
    const [byStatus, revenue, topServices] = await Promise.all([
      Order.aggregate([{ $group: { _id: '$status', count: { $sum: 1 } } }]),
      Order.aggregate([
        { $match: { 'payment.status': 'paid' } },
        { $group: { _id: null, turnover: { $sum: '$priceTotal' }, count: { $sum: 1 } } }
      ]),
      Order.aggregate([
        { $group: { _id: '$service', cnt: { $sum: 1 } } },
        { $sort: { cnt: -1 } },
        { $limit: 10 },
        { $lookup: { from: 'services', localField: '_id', foreignField: '_id', as: 'svc' } },
        { $unwind: '$svc' },
        { $project: { _id: 0, serviceId: '$svc._id', name: '$svc.name', cnt: 1 } }
      ])
    ]);
    
    res.json({ byStatus, revenue: revenue[0]||{turnover:0,count:0}, topServices });
  } catch (error) {
    res.status(500).json({ message: 'Błąd podczas pobierania KPI' });
  }
});

router.get('/heat', auth, requireAdmin, async (req,res)=>{
  try {
    
    const pts = await Order.aggregate([
      { $match: { 'location.lat': { $exists: true }, 'location.lng': { $exists: true } } },
      { $project: { 
        lat: '$location.lat', 
        lng: '$location.lng', 
        w: { $cond: [{ $eq: ['$payment.status','paid'] }, 2, 1] } 
      }}
    ]);
    res.json(pts);
  } catch (error) {
    res.status(500).json({ message: 'Błąd podczas pobierania heatmapy' });
  }
});

module.exports = router;
