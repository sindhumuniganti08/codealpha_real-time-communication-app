const fs = require('fs').promises;
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'data', 'db.json');

const defaultData = {
  users: [],
  files: []
};

async function initDB() {
  try {
    await fs.mkdir(path.dirname(DB_PATH), { recursive: true });
    try {
      await fs.access(DB_PATH);
    } catch {
      await fs.writeFile(DB_PATH, JSON.stringify(defaultData, null, 2), 'utf-8');
    }
  } catch (err) {
    console.error('Failed to initialize database folder:', err);
  }
}

async function readDB() {
  await initDB();
  try {
    const data = await fs.readFile(DB_PATH, 'utf-8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading database file, returning default:', err);
    return defaultData;
  }
}

async function writeDB(data) {
  try {
    await fs.writeFile(DB_PATH, JSON.stringify(data, null, 2), 'utf-8');
  } catch (err) {
    console.error('Error writing to database file:', err);
  }
}

const db = {
  async getCollection(collectionName) {
    const data = await readDB();
    return data[collectionName] || [];
  },

  async insert(collectionName, record) {
    const data = await readDB();
    if (!data[collectionName]) {
      data[collectionName] = [];
    }
    const collection = data[collectionName];
    
    const maxId = collection.reduce((max, item) => (item.id > max ? item.id : max), 0);
    const newRecord = {
      id: maxId + 1,
      ...record,
      created_at: new Date().toISOString()
    };
    
    collection.push(newRecord);
    await writeDB(data);
    return newRecord;
  },

  async findOne(collectionName, queryFn) {
    const collection = await this.getCollection(collectionName);
    return collection.find(queryFn);
  }
};

module.exports = db;
