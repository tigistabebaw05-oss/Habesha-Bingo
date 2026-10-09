require('dotenv').config({ path: require('path').resolve(__dirname, '../.env') });
const bcrypt = require('bcryptjs');
const { Pool } = require('pg');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : undefined,
});

(async () => {
  const phone = process.env.OWNER_PHONE || '0951666750';
  const name = process.env.OWNER_NAME || 'abirham';
  const password = process.env.OWNER_PASSWORD || 'A@12345';

  const client = await pool.connect();
  try {
    await client.query(`
      DO $$ 
      BEGIN
        ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
        ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('PLAYER', 'ADMIN', 'OWNER'));
      EXCEPTION WHEN OTHERS THEN NULL;
      END $$;
    `);

    const existing = await client.query('SELECT id, phone, role, is_active FROM users WHERE phone = $1', [phone]);
    const passwordHash = await bcrypt.hash(password, 12);

    if (existing.rows.length) {
      const row = existing.rows[0];
      await client.query(
        'UPDATE users SET name = $1, password_hash = $2, role = $3, is_active = TRUE WHERE id = $4',
        [name, passwordHash, 'OWNER', row.id]
      );
      console.log('Updated user to OWNER:', { id: row.id, phone, role: 'OWNER' });
    } else {
      const insert = await client.query(
        'INSERT INTO users(name, phone, password_hash, role, is_active) VALUES ($1, $2, $3, $4, TRUE) RETURNING id',
        [name, phone, passwordHash, 'OWNER']
      );
      await client.query('INSERT INTO wallets(user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [insert.rows[0].id]);
      console.log('Created new OWNER user:', { id: insert.rows[0].id, phone, role: 'OWNER' });
    }
    console.log(`Credentials: Phone: ${phone}, Password: ${password}`);
  } finally {
    client.release();
    await pool.end();
  }
})().catch((error) => {
  console.error('Owner creation failed:', error);
  process.exit(1);
});
