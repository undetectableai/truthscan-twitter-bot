// Generate proper 4-character random page IDs with collision detection
const fs = require('fs');

function generateRandomPageId() {
  const chars = '0123456789abcdefghijklmnopqrstuvwxyz';
  let result = '';
  for (let i = 0; i < 4; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

function generateUniquePageIds(count) {
  const used = new Set();
  const ids = [];
  
  while (ids.length < count) {
    const id = generateRandomPageId();
    if (!used.has(id)) {
      used.add(id);
      ids.push(id);
    }
  }
  
  return ids;
}

// Generate 180 unique page IDs
console.log('Generating 180 unique 4-character page IDs...');
const pageIds = generateUniquePageIds(180);

// Create SQL to update all records with unique page IDs
let sql = '';
for (let i = 0; i < 180; i++) {
  const pageId = pageIds[i];
  sql += `UPDATE detections SET page_id = '${pageId}', updated_at = COALESCE(updated_at, created_at) WHERE rowid = ${i + 1};\n`;
}

fs.writeFileSync('fix-page-ids.sql', sql);
console.log('Generated fix-page-ids.sql with 180 unique page IDs');
console.log('Examples:', pageIds.slice(0, 10).join(', '));
console.log('All page IDs are guaranteed unique with 4 random chars from 0-9a-z'); 