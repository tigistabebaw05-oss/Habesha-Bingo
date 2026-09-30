const fs = require('fs');
const files = ['index.html', 'owner.html', 'style.css', 'admin.css', 'app.js', 'admin.js'];
files.forEach(f => {
  if (fs.existsSync(`habesha-bingo-frontend/${f}`)) {
    fs.copyFileSync(`habesha-bingo-frontend/${f}`, `hulu-bingo-backend/Habesha-bingo-frontend/${f}`);
  }
});
console.log('Files copied successfully.');
