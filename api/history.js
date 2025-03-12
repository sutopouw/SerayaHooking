const pool = require('../config/database');

// Create table if not exists
async function initializeDatabase() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS history (
        id INT AUTO_INCREMENT PRIMARY KEY,
        webhook_url TEXT NOT NULL,
        content TEXT,
        image_url TEXT,
        audio_url TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    console.log('Database initialized successfully');
  } catch (error) {
    console.error('Error initializing database:', error);
  }
}

// Save history to database
async function saveHistory(webhookUrl, content, imageUrl = null, audioUrl = null) {
  try {
    const [result] = await pool.query(
      'INSERT INTO history (webhook_url, content, image_url, audio_url) VALUES (?, ?, ?, ?)',
      [webhookUrl, content, imageUrl, audioUrl]
    );
    return result.insertId;
  } catch (error) {
    console.error('Error saving history:', error);
    throw error;
  }
}

// Get history from database
async function getHistory() {
  try {
    const [rows] = await pool.query('SELECT * FROM history ORDER BY created_at DESC');
    return rows;
  } catch (error) {
    console.error('Error getting history:', error);
    throw error;
  }
}

// Clear history from database
async function clearHistory() {
  try {
    await pool.query('TRUNCATE TABLE history');
    return true;
  } catch (error) {
    console.error('Error clearing history:', error);
    throw error;
  }
}

module.exports = {
  initializeDatabase,
  saveHistory,
  getHistory,
  clearHistory
}; 