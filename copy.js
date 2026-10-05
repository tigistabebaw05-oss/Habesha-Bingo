const fs = require('fs');
const files = ['index.html', 'admin.html', 'owner.html', 'style.css', 'admin.css', 'app.js', 'admin.js'];
files.forEach(f => {
  if (fs.existsSync(`habesha-bingo-frontend/${f}`)) {
    fs.copyFileSync(`habesha-bingo-frontend/${f}`, `hulu-bingo-backend/Habesha-bingo-frontend/${f}`);
  }
});
if (fs.existsSync('habesha-bingo-frontend/owner/index.html')) {
  fs.mkdirSync('hulu-bingo-backend/Habesha-bingo-frontend/owner', { recursive: true });
  fs.copyFileSync('habesha-bingo-frontend/owner/index.html', 'hulu-bingo-backend/Habesha-bingo-frontend/owner/index.html');
}
console.log('Files copied successfully.');
