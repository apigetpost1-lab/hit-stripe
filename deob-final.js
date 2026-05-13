#!/usr/bin/env node
/**
 * Final deobfuscator - resolves wrapper function calls by executing in VM
 * Strategy: Load array+rotation+decoder in VM, then find all wrapper functions,
 * register them, and resolve all calls site by site.
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPT_DIR = path.join(__dirname, 'script');
const OUTPUT_DIR = path.join(__dirname, 'deobfuscated');
if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

// Process one file at a time for better error handling
const targetFile = process.argv[2];
const files = targetFile 
  ? [targetFile]
  : fs.readdirSync(SCRIPT_DIR).filter(f => f.endsWith('.js') && !['minify-all.js','READ_THIS.js','version.js'].includes(f));

for (const file of files) {
  console.log(`\n========== ${file} ==========`);
  try {
    processFile(file);
  } catch(e) {
    console.log(`  FATAL: ${e.message}`);
  }
}

function processFile(file) {
  const code = fs.readFileSync(path.join(SCRIPT_DIR, file), 'utf-8');
  
  // Step 1: Find the main decoder function name
  const decoderMatch = code.match(/function\s+(_0x[a-f0-9]+)\s*\(\s*x\s*,\s*_\s*\)\s*\{\s*x\s*-=\s*(\d+)\s*;/);
  if (!decoderMatch) {
    // Try alternate pattern for hcaptcha/offscreen/autofill style
    const altDecoder = code.match(/function\s+(_0x[a-f0-9]+)\s*\(\s*x\s*,\s*n\s*\)\s*\{\s*x\s*-=\s*(\d+)\s*;/);
    if (!altDecoder) {
      console.log('  No decoder found, skipping');
      return;
    }
    return processFileWithDecoder(code, file, altDecoder[1], parseInt(altDecoder[2]));
  }
  
  processFileWithDecoder(code, file, decoderMatch[1], parseInt(decoderMatch[2]));
}

function processFileWithDecoder(code, file, decoderName, offset) {
  console.log(`  Decoder: ${decoderName}, offset: ${offset}`);
  
  // Step 2: Extract the complete setup code needed for the decoder to work
  // This includes: string array function + rotation IIFE + decoder function
  
  // Find the string array function (appears before decoder)
  const arrayFuncPattern = /function\s+(_0x[a-f0-9]+)\s*\(\s*\)\s*\{\s*(?:var|const)\s+x\s*=\s*\[/;
  const arrayMatch = arrayFuncPattern.exec(code);
  
  if (!arrayMatch) {
    console.log('  No string array function found');
    return;
  }
  
  const arrayFuncName = arrayMatch[1];
  console.log(`  Array function: ${arrayFuncName}`);
  
  // Find the end of the decoder function  
  const decoderStart = code.indexOf(`function ${decoderName}`);
  const decoderEnd = findBraceEnd(code, decoderStart);
  
  // The setup = everything from array function start to decoder function end
  const setupStart = arrayMatch.index;
  let setupCode = code.substring(setupStart, decoderEnd);
  
  // Also need the rotation IIFE between array and decoder
  // It's usually like: !function(x,_){...}(arrayFuncName, NUMBER);
  // or (function(x,_){...})(arrayFuncName, NUMBER);
  
  // Step 3: Execute setup in VM
  const sandbox = createSandbox();
  const ctx = vm.createContext(sandbox);
  
  try {
    vm.runInContext(setupCode, ctx, { timeout: 15000 });
  } catch(e) {
    console.log(`  Setup exec failed: ${e.message.substring(0, 80)}`);
    // Try wrapping with missing globals
    try {
      const patchedSetup = `var self=globalThis;var window=globalThis;var chrome={runtime:{sendMessage:function(){}}};` + setupCode;
      vm.runInContext(patchedSetup, ctx, { timeout: 15000 });
      console.log(`  Setup exec succeeded with patched globals`);
    } catch(e2) {
      console.log(`  Patched setup also failed: ${e2.message.substring(0, 80)}`);
      fs.writeFileSync(path.join(OUTPUT_DIR, file), simpleBeautify(code), 'utf-8');
      return;
    }
  }
  
  // Verify decoder works
  try {
    const testResult = vm.runInContext(`typeof ${decoderName}`, ctx, { timeout: 100 });
    if (testResult !== 'function') {
      console.log(`  Decoder is not a function in context (type: ${testResult})`);
      fs.writeFileSync(path.join(OUTPUT_DIR, file), simpleBeautify(code), 'utf-8');
      return;
    }
    console.log(`  Decoder function verified`);
  } catch(e) {
    console.log(`  Decoder verification failed: ${e.message}`);
    fs.writeFileSync(path.join(OUTPUT_DIR, file), simpleBeautify(code), 'utf-8');
    return;
  }
  
  // Step 4: Find all wrapper functions that call the decoder
  // Pattern: function _0xWRAPPER(a,b,c,d,e) { return DECODER(EXPR, VAR) }
  const escapedDecoder = decoderName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wrapperRegex = new RegExp(
    `function\\s+(_0x[a-f0-9]+)\\s*\\(([^)]+)\\)\\s*\\{\\s*return\\s+${escapedDecoder}\\(([^,]+),\\s*([^)]+)\\)\\s*\\}`,
    'g'
  );
  
  const wrappers = new Map();
  let wm;
  while ((wm = wrapperRegex.exec(code)) !== null) {
    const wrapperName = wm[1];
    const params = wm[2].split(',').map(s => s.trim());
    const expr1 = wm[3].trim(); // e.g., "c- -990" or "_-527"
    const expr2 = wm[4].trim(); // e.g., "n" or "f"
    wrappers.set(wrapperName, { params, expr1, expr2, fullMatch: wm[0] });
  }
  
  console.log(`  Found ${wrappers.size} wrapper functions`);
  
  // Register all wrapper functions in the VM context
  for (const [name, info] of wrappers) {
    try {
      vm.runInContext(`function ${name}(${info.params.join(',')}){return ${decoderName}(${info.expr1},${info.expr2})}`, ctx, { timeout: 100 });
    } catch(e) {
      // ignore
    }
  }
  
  // Step 5: Now find all calls to wrapper functions and resolve them
  let result = code;
  let totalResolved = 0;
  let totalFailed = 0;
  
  for (const [wrapperName, info] of wrappers) {
    const escapedWrapper = wrapperName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Match calls like: wrapperName(arg1, arg2, arg3, arg4, arg5)
    // Args can be numbers, strings, or expressions
    const numParams = info.params.length;
    
    // Build a regex for the call - arguments can be numbers, quoted strings, or simple exprs
    const argPattern = `(?:[^,()]+)`;
    const argsPattern = Array(numParams).fill(argPattern).join('\\s*,\\s*');
    const callRegex = new RegExp(escapedWrapper + '\\s*\\(\\s*(' + argsPattern + ')\\s*\\)', 'g');
    
    const replacements = [];
    let cm;
    while ((cm = callRegex.exec(code)) !== null) {
      const fullCall = cm[0];
      // Try to evaluate
      try {
        const val = vm.runInContext(fullCall, ctx, { timeout: 50 });
        if (typeof val === 'string') {
          replacements.push({ from: fullCall, to: JSON.stringify(val) });
          totalResolved++;
        } else {
          totalFailed++;
        }
      } catch(e) {
        totalFailed++;
      }
    }
    
    // Apply replacements (reverse order to not mess up indices)
    for (const r of replacements) {
      result = result.split(r.from).join(r.to);
    }
  }
  
  console.log(`  Total resolved: ${totalResolved}, failed: ${totalFailed}`);
  
  // Also try direct decoder calls with literal args
  const directCallRegex = new RegExp(escapedDecoder + '\\s*\\(\\s*(\\d+)\\s*,\\s*"([^"]*)"\\s*\\)', 'g');
  let dm;
  while ((dm = directCallRegex.exec(result)) !== null) {
    try {
      const val = vm.runInContext(dm[0], ctx, { timeout: 50 });
      if (typeof val === 'string') {
        result = result.split(dm[0]).join(JSON.stringify(val));
        totalResolved++;
      }
    } catch(e) {}
  }
  
  // Step 6: Save result
  const beautified = simpleBeautify(result);
  fs.writeFileSync(path.join(OUTPUT_DIR, file), beautified, 'utf-8');
  console.log(`  Final output: ${(beautified.length/1024).toFixed(1)} KB, resolved ${totalResolved} strings`);
}

function findBraceEnd(code, startPos) {
  let depth = 0;
  let inStr = false;
  let strCh = '';
  let started = false;
  
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
  return Math.min(startPos + 100000, code.length);
}

function createSandbox() {
  return {
    globalThis: {},
    self: {},
    window: {},
    chrome: { runtime: { sendMessage: ()=>{}, onMessage: { addListener: ()=>{} } }, storage: { local: { get: ()=>{}, set: ()=>{} } } },
    navigator: { userAgent: '' },
    document: { createElement: ()=>({ style: {} }), querySelector: ()=>null },
    console: { log: ()=>{}, warn: ()=>{}, error: ()=>{} },
    parseInt, parseFloat, isNaN, isFinite,
    String, Number, Boolean, Array, Object, RegExp, Date, Math, JSON,
    Error, TypeError, RangeError, SyntaxError,
    encodeURIComponent, decodeURIComponent, encodeURI, decodeURI,
    escape, unescape,
    setTimeout: ()=>0, setInterval: ()=>0, clearTimeout: ()=>{}, clearInterval: ()=>{},
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    btoa: (s) => Buffer.from(s, 'binary').toString('base64'),
    fetch: ()=>Promise.resolve(),
    XMLHttpRequest: function(){},
    Proxy: global.Proxy,
    Symbol: global.Symbol,
    Map, Set, WeakMap, WeakSet, Promise,
    Uint8Array, Int32Array, ArrayBuffer, DataView,
    undefined: undefined,
  };
}

function simpleBeautify(code) {
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
      if (next && next !== ',' && next !== ';' && next !== ')' && next !== ']' && next !== '}') {
        result += '\n' + '  '.repeat(indent);
      }
      continue;
    }
    if (ch === ';') { result += ';\n' + '  '.repeat(indent); continue; }
    result += ch;
  }
  return result;
}
