const requireAdmin = (req, res, next) => {
  const user = req.user; // z JWT middleware
  
  // Sprawdź czy użytkownik ma rolę admin
  if (!user || user.role !== 'admin') {
    return res.status(403).json({ message: 'Dostęp zabroniony - wymagane uprawnienia administratora' });
  }

  // Opcjonalnie: sprawdź czy to konkretny email admina
  // if (user.email !== process.env.ADMIN_EMAIL) {
  //   return res.status(403).json({ message: 'Dostęp zabroniony' });
  // }

  next();
};

module.exports = requireAdmin;