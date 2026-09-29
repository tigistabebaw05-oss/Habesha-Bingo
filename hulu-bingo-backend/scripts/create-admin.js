require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
});

(async () => {
  const phone = process.env.ADMIN_PHONE || '0919307468';
  const name = process.env.ADMIN_NAME || 'adissu';
  const password = process.env.ADMIN_PASSWORD || 'Ad@1234';

  const client = await pool.connect();
  try {
    const existing = await client.query('SELECT id, phone, role, is_active FROM users WHERE phone = $1', [phone]);
    const passwordHash = await bcrypt.hash(password, 12);

    if (existing.rows.length) {
      const row = existing.rows[0];
      await client.query(
        'UPDATE users SET name = $1, password_hash = $2, role = $3, is_active = TRUE WHERE id = $4',
        [name, passwordHash, 'ADMIN', row.id]
      );
      console.log('Updated user to ADMIN:', { id: row.id, phone, name, role: 'ADMIN' });
    } else {
      const insert = await client.query(
        'INSERT INTO users(name, phone, password_hash, role, is_active) VALUES ($1, $2, $3, $4, TRUE) RETURNING id',
        [name, phone, passwordHash, 'ADMIN']
      );
      await client.query('INSERT INTO wallets(user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [insert.rows[0].id]);
      console.log('Created new ADMIN user:', { id: insert.rows[0].id, phone, name, role: 'ADMIN' });
    }
    console.log(`Credentials: Phone: ${phone}, Password: ${password}`);
  } finally {
    client.release();
    await pool.end();
  }
})().catch((error) => {
  console.error('Admin creation failed:', error);
  process.exit(1);
});
