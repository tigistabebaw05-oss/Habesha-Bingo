const fs = require('fs');
const { Pool } = require('pg');

const pool = new Pool({
    connectionString: 'postgresql://postgres@localhost:5432/hulu_bingo'
});

async function run() {
    const sql = fs.readFileSync('database.sql', 'utf8');
    try {
        await pool.query(sql);
        console.log('Database updated successfully');
    } catch (err) {
        console.error('Error updating database:', err);
    } finally {
        await pool.end();
    }
}

run();
