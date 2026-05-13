const fs = require('fs');
const files = ['autofill.js','background.js','binlibrary.js','content.js','country.js','dashboard.js','hcaptcha.js','inject.js','offscreen.js','proxyhandler.js','storage.js'];

for (const f of files) {
  const code = fs.readFileSync('/projects/sandbox/hit-stripe/script/' + f, 'utf-8');
  const arrayMatch = code.match(/function\s+(_0x[a-f0-9]+)\s*\(\s*\)\s*\{\s*(?:var|const)\s+x\s*=\s*\[/);
  const arrayName = arrayMatch ? arrayMatch[1] : '?';
  const decMatch = code.match(/function\s+(_0x[a-f0-9]+)\s*\(\s*x\s*,\s*(?:_|c|n|W)\s*\)\s*\{\s*x\s*-=\s*(\d+)/);
  const decName = decMatch ? decMatch[1] : '?';
  const offset = decMatch ? decMatch[2] : '?';
  const arrayPos = arrayMatch ? code.indexOf(arrayMatch[0]) : -1;
  const decPos = decMatch ? code.indexOf(decMatch[0]) : -1;
  
  // Find rotation by searching for }(arrayName, NUMBER)
  let rotTarget = '?';
  if (arrayName !== '?') {
    const escaped = arrayName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
    const rm = code.match(new RegExp('\\}\\s*\\(\\s*' + escaped + '\\s*,\\s*(\\d+)\\s*\\)'));
    if (rm) rotTarget = rm[1];
  }
  
  console.log(f.padEnd(18), 'array:', arrayName.padEnd(10), 'dec:', decName.padEnd(10), 'off:', String(offset).padEnd(5), 'rot:', String(rotTarget).padEnd(8), arrayPos < decPos ? 'arr->dec' : 'dec->arr');
}
