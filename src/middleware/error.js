const errorHandler = (err, req, res, next) => {
  console.error(err.stack);

  // Mongoose validation error
  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors).map((e) => e.message);
    return res.status(400).json({ message: messages.join(', ') });
  }

  // Mongoose duplicate key
  if (err.code === 11000) {
    return res.status(409).json({ message: 'Такая запись уже существует' });
  }

  res.status(err.status || 500).json({ message: err.message || 'Внутренняя ошибка сервера' });
};

module.exports = errorHandler;
