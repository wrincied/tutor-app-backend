function isFirebaseNotFound(error) {
  return error && (error.code === 5 || error.code === 'not-found');
}

const errorHandler = (error, req, res, _next) => {
  if (res.headersSent) {
    return;
  }

  const status =
    error.status ||
    error.statusCode ||
    (isFirebaseNotFound(error) ? 404 : 500);

  const message =
    error.expose && error.message
      ? error.message
      : status >= 500
        ? 'Internal server error'
        : error.message || 'Request failed';

  if (status >= 500) {
    console.error('[ERROR]', {
      method: req.method,
      path: req.originalUrl,
      message: error.message,
      stack: error.stack,
    });
  }

  res.status(status).json({
    message,
    ...(process.env.NODE_ENV !== 'production' && { details: error.message }),
  });
};

module.exports = errorHandler;
