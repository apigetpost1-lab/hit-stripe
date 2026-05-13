#!/usr/bin/env node
/**
 * Complete deobfuscator for javascript-obfuscator (RC4 + string rotation)
 * Handles all patterns found in this codebase:
 * - Array function before or after decoder
 * - Rotation IIFE with target number
 * - RC4 string decryption
 * - Wrapper functions with computed expressions
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPT_DIR = path.join(__dirname, 'script');
const OUTPUT_DIR = path.join(__dirname, 'deobfuscated');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const files = fs.readdirSync(SCRIPT_DIR).filter(f => 
  f.endsWith('.js') && !['minify-all.js','READ_THIS.js','version.js'].includes(f)
);

console.log(`Processing ${files.length} files...\n`);

for (const file of files) {
  console.log(`\n${'='.repeat(60)}\n  ${file}\n${'='.repeat(60)}`);
  try {
    const code = fs.readFileSync(path.join(SCRIPT_DIR, file), 'utf-8');
    const result = deobfuscate(code, file);
    fs.writeFileSync(path.join(OUTPUT_DIR, file), result, 'utf-8');
    console.log(`  Output: ${(result.length/1024).toFixed(1)} KB`);
  } catch(e) {
    console.log(`  FATAL ERROR: ${e.message}`);
    console.log(`  Stack: ${e.stack.split('\n').slice(0,3).join('\n')}`);
  }
}

console.log('\n\nDone! Results in deobfuscated/');

function deobfuscate(code, filename) {
  // Step 1: Identify components
  const arrayMatch = code.match(/function\s+(_0x[a-f0-9]+)\s*\(\s*\)\s*\{\s*(?:var|const)\s+x\s*=\s*\[/);
  const decMatch = code.match(/function\s+(_0x[a-f0-9]+)\s*\(\s*x\s*,\s*(?:_|c|n|W)\s*\)\s*\{\s*x\s*-=\s*(\d+)\s*;/);
  
  if (!arrayMatch || !decMatch) {
    console.log('  Could not identify array/decoder. Beautifying only.');
    return beautify(code);
  }
  
  const arrayName = arrayMatch[1];
  const decoderName = decMatch[1];
  const offset = parseInt(decMatch[2]);
  const arrayPos = code.indexOf(arrayMatch[0]);
  const decoderPos = code.indexOf(decMatch[0]);
  
  console.log(`  Array: ${arrayName}, Decoder: ${decoderName}, Offset: ${offset}`);
  
  // Step 2: Extract array function (find its complete body)
  const arrayEnd = findBraceEnd(code, arrayPos);
  const arrayCode = code.substring(arrayPos, arrayEnd);
  
  // Step 3: Find decoder function end
  const decoderEnd = findBraceEnd(code, decoderPos);
  const decoderCode = code.substring(decoderPos, decoderEnd);
  
  // Step 4: Find rotation IIFE
  const escapedArray = arrayName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  const rotRegex = new RegExp('(!\\s*function|\\(\\s*function)\\s*\\(\\s*x\\s*,\\s*_\\s*\\)\\s*\\{[\\s\\S]*?\\}\\s*\\(\\s*' + escapedArray + '\\s*,\\s*(\\d+)\\s*\\)');
  const rotMatch = rotRegex.exec(code);
  let rotationCode = '';
  if (rotMatch) {
    // Find the start of this IIFE
    const rotStart = rotMatch.index;
    const rotEnd = code.indexOf(rotMatch[0], rotStart) + rotMatch[0].length;
    rotationCode = code.substring(rotStart, rotEnd + 1); // include the ;
    console.log(`  Rotation IIFE found, target: ${rotMatch[2]}`);
  }
  
  // Step 5: Build setup code in correct order
  // Always: array first, then rotation, then decoder
  let setupCode = arrayCode + ';\n' + rotationCode + ';\n' + decoderCode + ';\n';
  
  // Step 6: Execute in VM
  const sandbox = createFullSandbox();
  const ctx = vm.createContext(sandbox);
  
  let setupSuccess = false;
  try {
    vm.runInContext(setupCode, ctx, { timeout: 30000 });
    // Verify decoder works
    const testType = vm.runInContext(`typeof ${decoderName}`, ctx, { timeout: 100 });
    if (testType === 'function') {
      setupSuccess = true;
      console.log(`  Decoder setup SUCCESS`);
    } else {
      console.log(`  Decoder is ${testType}, not function`);
    }
  } catch(e) {
    console.log(`  Setup error: ${e.message.substring(0, 100)}`);
    // Try with additional patching
    try {
      const ctx2 = vm.createContext(createFullSandbox());
      const patched = `var self=globalThis;var window=globalThis;var navigator={userAgent:'',platform:'',language:'en'};var location={href:'https://example.com',hostname:'example.com',protocol:'https:'};var document={createElement:function(){return{style:{}}},querySelector:function(){return null},querySelectorAll:function(){return[]},cookie:''};` + setupCode;
      vm.runInContext(patched, ctx2, { timeout: 30000 });
      const testType2 = vm.runInContext(`typeof ${decoderName}`, ctx2, { timeout: 100 });
      if (testType2 === 'function') {
        setupSuccess = true;
        Object.assign(ctx, ctx2);
        console.log(`  Decoder setup SUCCESS (with patched globals)`);
      }
    } catch(e2) {
      console.log(`  Patched setup also failed: ${e2.message.substring(0, 80)}`);
    }
  }
  
  if (!setupSuccess) {
    // Last resort: try extracting and running just the minimal parts
    try {
      const ctx3 = vm.createContext(createFullSandbox());
      // Extract just the string array data
      const arrData = code.match(/(?:var|const)\s+x\s*=\s*(\[(?:"[^"]*"(?:\s*,\s*"[^"]*")*)\])/);
      if (arrData) {
        // Manually build a working setup with rotation
        // The rotation IIFE shuffles the array until parseInt checks match target
        // We'll just run the full original rotation code with the array
        const minimalSetup = `
var self=globalThis;var window=globalThis;var navigator={userAgent:'',platform:'',language:'en'};
var location={href:'https://example.com',hostname:'example.com',protocol:'https:'};
var document={createElement:function(){return{style:{}}},querySelector:function(){return null},querySelectorAll:function(){return[]},cookie:''};
${arrayCode}
${rotationCode}
${decoderCode}
`;
        vm.runInContext(minimalSetup, ctx3, { timeout: 30000 });
        const t = vm.runInContext(`typeof ${decoderName}`, ctx3, { timeout: 100 });
        if (t === 'function') {
          setupSuccess = true;
          Object.assign(ctx, ctx3);
          console.log(`  Decoder setup SUCCESS (minimal rebuild with rotation)`);
        }
      }
    } catch(e3) {
      console.log(`  Minimal rebuild also failed: ${e3.message.substring(0, 80)}`);
    }
  }
  
  if (!setupSuccess) {
    console.log(`  Cannot setup decoder. Beautifying only.`);
    return beautify(code);
  }
  
  // Step 7: Find all wrapper functions and register them
  const escapedDecoder = decoderName.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
  const wrapperRegex = new RegExp(
    `function\\s+(_0x[a-f0-9]+)\\s*\\(([^)]+)\\)\\s*\\{\\s*return\\s+${escapedDecoder}\\(([^)]+)\\)\\s*\\}`,
    'g'
  );
  
  const wrappers = new Map();
  let wm;
  while ((wm = wrapperRegex.exec(code)) !== null) {
    wrappers.set(wm[1], { params: wm[2], body: wm[3], full: wm[0] });
    try {
      vm.runInContext(wm[0], ctx, { timeout: 100 });
    } catch(e) {}
  }
  console.log(`  Registered ${wrappers.size} wrapper functions`);
  
  // Step 8: Resolve ALL calls to wrapper functions (and decoder) with literal args
  // Args can be: numbers (positive/negative), quoted strings (single or double)
  let result = code;
  let totalResolved = 0;
  let totalFailed = 0;
  
  // Build a set of all function names to look for (wrappers + decoder)
  const funcNames = new Set([decoderName, ...wrappers.keys()]);
  
  // Also find nested wrappers (wrappers defined inside objects/closures)
  // Pattern: function _0xXXXX(params){return _0xDECODER(expr)} or return _0xWRAPPER(expr)
  const nestedWrapperRegex = new RegExp(
    `function\\s+(_0x[a-f0-9]+)\\s*\\([^)]+\\)\\s*\\{\\s*return\\s+(_0x[a-f0-9]+)\\s*\\([^)]+\\)\\s*\\}`,
    'g'
  );
  let nw;
  while ((nw = nestedWrapperRegex.exec(code)) !== null) {
    if (!funcNames.has(nw[1])) {
      funcNames.add(nw[1]);
      try {
        vm.runInContext(nw[0], ctx, { timeout: 100 });
      } catch(e) {}
    }
  }
  
  console.log(`  Total function names to resolve: ${funcNames.size}`);
  
  // Build one big regex to find all calls to any of these functions with literal args
  // Literal arg: -?\d+ or "..." or '...'
  const litArg = `(?:-?\\d+|"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`;
  const argsPattern = `${litArg}(?:\\s*,\\s*${litArg})*`;
  
  // Process in batches to avoid regex explosion
  const allFuncNames = [...funcNames];
  const BATCH_SIZE = 50;
  const MAX_RESOLVE = 100000; // safety limit
  
  for (let batch = 0; batch < allFuncNames.length && totalResolved < MAX_RESOLVE; batch += BATCH_SIZE) {
    const batchNames = allFuncNames.slice(batch, batch + BATCH_SIZE);
    const namesPattern = batchNames.map(n => n.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|');
    const callRegex = new RegExp(`(?:${namesPattern})\\(\\s*${argsPattern}\\s*\\)`, 'g');
    
    const replacements = [];
    let cm;
    while ((cm = callRegex.exec(result)) !== null) {
      const callStr = cm[0];
      // Skip if it's inside a function definition (the return statement)
      const before = result.substring(Math.max(0, cm.index - 10), cm.index);
      if (before.includes('return')) continue;
      
      try {
        const val = vm.runInContext(callStr, ctx, { timeout: 50 });
        if (typeof val === 'string') {
          replacements.push({ from: callStr, to: JSON.stringify(val), index: cm.index });
        } else {
          totalFailed++;
        }
      } catch(e) {
        totalFailed++;
      }
    }
    
    // Apply replacements in reverse order to preserve indices
    replacements.sort((a, b) => b.index - a.index);
    for (const r of replacements) {
      result = result.substring(0, r.index) + r.to + result.substring(r.index + r.from.length);
      totalResolved++;
    }
  }
  
  console.log(`  String replacements: ${totalResolved} resolved, ${totalFailed} failed`);
  
  // Step 9: Try to resolve object property access patterns
  // e.g., x[_0xWrapper(1234,"key")] -> x["actualPropName"]
  // Already handled above since wrapper calls return strings
  
  // Step 10: Concatenate adjacent string literals ("abc" + "def" -> "abcdef")
  result = concatenateStrings(result);
  
  // Step 11: Clean up anti-debug/anti-tamper code patterns
  result = cleanAntiDebug(result);
  
  // Step 11: Beautify
  return beautify(result);
}

function findBraceEnd(code, startPos) {
  let depth = 0, inStr = false, strCh = '', started = false;
  for (let i = startPos; i < code.length; i++) {
    const ch = code[i];
    if (inStr) {
      if (ch === '\\') { i++; continue; }
      if (ch === strCh) inStr = false;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = true; strCh = ch; continue; }
    if (ch === '{') { depth++; started = true; }
    if (ch === '}') {
      depth--;
      if (started && depth === 0) return i + 1;
    }
  }
  return Math.min(startPos + 200000, code.length);
}

function createFullSandbox() {
  const fakeElement = { style: {}, appendChild: ()=>{}, removeChild: ()=>{}, setAttribute: ()=>{}, getAttribute: ()=>'', innerHTML: '', textContent: '', classList: { add:()=>{}, remove:()=>{}, contains:()=>false } };
  return {
    globalThis: {},
    self: {},
    window: {},
    chrome: { 
      runtime: { sendMessage:()=>{}, onMessage:{addListener:()=>{}}, getURL:()=>'', id:'fake' },
      storage: { local:{get:()=>Promise.resolve({}),set:()=>Promise.resolve()}, sync:{get:()=>Promise.resolve({}),set:()=>Promise.resolve()} },
      tabs: { query:()=>Promise.resolve([]), sendMessage:()=>{} },
      action: { setBadgeText:()=>{}, setBadgeBackgroundColor:()=>{} },
      declarativeNetRequest: { updateDynamicRules:()=>Promise.resolve() }
    },
    navigator: { userAgent: 'Mozilla/5.0', platform: 'Win32', language: 'en-US' },
    location: { href: 'https://example.com', hostname: 'example.com', protocol: 'https:', origin: 'https://example.com' },
    document: { 
      createElement: ()=>({...fakeElement}), 
      querySelector: ()=>null, 
      querySelectorAll: ()=>[],
      getElementById: ()=>null,
      cookie: '',
      body: fakeElement,
      head: fakeElement,
      documentElement: fakeElement
    },
    console: { log:()=>{}, warn:()=>{}, error:()=>{}, info:()=>{}, debug:()=>{}, table:()=>{} },
    parseInt, parseFloat, isNaN, isFinite, NaN, Infinity,
    String, Number, Boolean, Array, Object, RegExp, Date, Math, JSON,
    Error, TypeError, RangeError, SyntaxError, ReferenceError, URIError,
    encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
    escape, unescape,
    setTimeout: (fn)=>{ if(typeof fn==='function') try{fn()}catch(e){} return 0; },
    setInterval: ()=>0, clearTimeout:()=>{}, clearInterval:()=>{},
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    fetch: ()=>Promise.resolve({ json:()=>Promise.resolve({}), text:()=>Promise.resolve('') }),
    XMLHttpRequest: function(){ this.open=()=>{}; this.send=()=>{}; this.setRequestHeader=()=>{}; },
    Request: function(){}, Response: function(){}, Headers: function(){},
    URL: global.URL, URLSearchParams: global.URLSearchParams,
    Proxy: global.Proxy, Reflect: global.Reflect,
    Symbol: global.Symbol, 
    Map, Set, WeakMap, WeakSet, Promise,
    Uint8Array, Uint16Array, Uint32Array, Int8Array, Int16Array, Int32Array,
    Float32Array, Float64Array, ArrayBuffer, DataView, SharedArrayBuffer: ArrayBuffer,
    TextEncoder: global.TextEncoder, TextDecoder: global.TextDecoder,
    crypto: { getRandomValues: (arr)=>{ for(let i=0;i<arr.length;i++) arr[i]=Math.floor(Math.random()*256); return arr; }, subtle: {} },
    performance: { now: ()=>Date.now() },
    queueMicrotask: (fn)=>{ try{fn()}catch(e){} },
    structuredClone: global.structuredClone,
    undefined: undefined,
    alert: ()=>{}, confirm: ()=>true, prompt: ()=>'',
    Audio: function(){ this.play=()=>Promise.resolve(); this.pause=()=>{}; this.volume=1; },
    Image: function(){ this.src=''; this.onload=null; },
    Worker: function(){},
    Blob: function(){},
    FormData: function(){ this.append=()=>{}; },
    AbortController: function(){ this.signal={}; this.abort=()=>{}; },
    Event: function(){}, CustomEvent: function(){},
    MutationObserver: function(){ this.observe=()=>{}; this.disconnect=()=>{}; },
    ResizeObserver: function(){ this.observe=()=>{}; this.disconnect=()=>{}; },
    IntersectionObserver: function(){ this.observe=()=>{}; this.disconnect=()=>{}; },
  };
}

function cleanAntiDebug(code) {
  return code;
}

function concatenateStrings(code) {
  // Replace "abc"+"def"+"ghi" with "abcdefghi" - single pass
  let result = code;
  let prev = '';
  // Keep replacing until no more changes (max 20 passes for safety)
  for (let pass = 0; pass < 20; pass++) {
    const next = result.replace(/"([^"\\]*(?:\\.[^"\\]*)*)"\s*\+\s*"([^"\\]*(?:\\.[^"\\]*)*)"/g, '"$1$2"');
    if (next === result) break;
    result = next;
  }
  return result;
}

function replaceAll(str, search, replacement) {
  // Escape special regex chars in search string for safe replacement
  return str.split(search).join(replacement);
}

function beautify(code) {
  let result = '';
  let indent = 0;
  let inStr = false;
  let strCh = '';
  
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    const next = code[i+1] || '';
    
    if (inStr) {
      result += ch;
      if (ch === '\\') { result += next; i++; continue; }
      if (ch === strCh) inStr = false;
      continue;
    }
    
    if (ch === '"' || ch === "'" || ch === '`') { inStr = true; strCh = ch; result += ch; continue; }
    
    if (ch === '{') { indent++; result += ' {\n' + '  '.repeat(indent); continue; }
    if (ch === '}') {
      indent = Math.max(0, indent - 1);
      result += '\n' + '  '.repeat(indent) + '}';
      if (next && next !== ',' && next !== ';' && next !== ')' && next !== ']' && next !== '}' && next !== '.') {
        result += '\n' + '  '.repeat(indent);
      }
      continue;
    }
    if (ch === ';') { result += ';\n' + '  '.repeat(indent); continue; }
    result += ch;
  }
  return result;
}
