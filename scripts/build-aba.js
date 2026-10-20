// Builds src/data/aba.json (routing number -> bank name, city, state) from the Federal
// Reserve's FedACH directory file. Usage: node scripts/build-aba.js path/to/FedACHdir.txt
// (a copy is published at https://raw.githubusercontent.com/moov-io/fed/master/data/FedACHdir.txt)
const fs = require('fs');
const path = require('path');
const src = process.argv[2];
if (!src) { console.error('Usage: node scripts/build-aba.js FedACHdir.txt'); process.exit(1); }
const out = {};
let n = 0;
fs.readFileSync(src, 'latin1').split(/\r?\n/).forEach((line) => {
  if (line.length < 100 || !/^\d{9}/.test(line)) return;
  const rn = line.slice(0, 9);
  const nm = line.slice(35, 71).trim(), city = line.slice(107, 127).trim(), state = line.slice(127, 129).trim();
  if (!nm) return;
  out[rn] = [nm, city, state]; n += 1;
});
fs.writeFileSync(path.join(__dirname, '..', 'src', 'data', 'aba.json'), JSON.stringify(out));
console.log('Wrote ' + n + ' routing numbers.');
