/** Случайный неяркий пастельный цвет для карточки ученика (HSL). */
function generatePastelColor() {
  const hue = Math.floor(Math.random() * 360);
  return `hsl(${hue}, 45%, 88%)`;
}

module.exports = { generatePastelColor };
