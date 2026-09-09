const { Pool } = require('pg');
require('dotenv').config();

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgresql://postgres:postgres@localhost:5432/tracker_bot',
  // Render/Neon/Supabase butuh SSL — localhost tidak
  ...(process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('localhost')
    ? { ssl: { rejectUnauthorized: false } }
    : {}),
});

// ponytail: simple raw queries. add query builder/orm if migrations get complex.
module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
