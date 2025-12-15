const { Client } = require('pg');
require('dotenv').config();

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: false  // Для разработки
});

client.connect()
  .then(() => console.log('✅ Connected to Supabase'))
  .catch(err => console.error('❌ Connection error:', err));

// ДОБАВЬТЕ ЭТУ СТРОКУ:
module.exports = client;  // Экспортируем клиент для использования в других файлах
