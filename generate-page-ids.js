// Generate short, memorable page IDs for all detection records
const fs = require('fs');

function generatePageId(index) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const prefixes = ['abc', 'def', 'ghi', 'jkl', 'mno', 'pqr', 'stu', 'vwx', 'yz1', 'z2a'];
  const suffixes = ['123', '456', '789', '012', '345', '678', '901', '234', '567', '890'];
  
  const prefixIndex = Math.floor(index / suffixes.length) % prefixes.length;
  const suffixIndex = index % suffixes.length;
  
  return prefixes[prefixIndex] + suffixes[suffixIndex];
}

// Generate SQL UPDATE statements for all 180 records
let sql = '';
for (let i = 0; i < 180; i++) {
  const pageId = generatePageId(i);
  sql += `UPDATE detections SET page_id = '${pageId}' WHERE rowid = ${i + 1};\n`;
}

fs.writeFileSync('update-page-ids.sql', sql);
console.log('Generated update-page-ids.sql with 180 short page IDs');
console.log('Examples: abc123, abc456, abc789, def012, def345, etc.'); 