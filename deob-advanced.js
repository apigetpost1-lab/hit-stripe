#!/usr/bin/env node
/**
 * Advanced deobfuscator - executes the decoder function in VM 
 * to resolve encrypted strings
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPT_DIR = path.join(__dirname, 'script');
const OUTPUT_DIR = path.join(__dirname, 'deobfuscated');

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

const files = fs.readdirSync(SCRIPT_DIR).filter(f => 
  f.endsWith('.js') && !['minify-all.js', 'READ_THIS.js', 'version.js'].includes(f)
);

for (const file of files) {
  console.log(`\n========== ${file} ==========`);
  const code = fs.readFileSync(path.join(SCRIPT_DIR, file), 'utf-8');
  
  try {
    const result = deobfuscate(code, file);
    fs.writeFileSync(path.join(OUTPUT_DIR, file), result, 'utf-8');
    console.log(`  Output: ${(result.length/1024).toFixed(1)} KB`);
  } catch(err) {
    console.log(`  FAILED: ${err.message}`);
    // fallback: save raw
    fs.writeFileSync(path.join(OUTPUT_DIR, file), code, 'utf-8');
  }
}

function deobfuscate(code, filename) {
  // Step 1: Find and extract the string array function, rotation IIFE, and decoder
  
  // Pattern for string array: function _0xXXXX() { const/var x = [...]; return (_0xXXXX = function(){return x})() }
  const arrayFuncNames = [];
  const arrayFuncRegex = /function\s+(_0x[a-f0-9]+)\s*\(\s*\)\s*\{(?:var|const)\s+x\s*=\s*\[/g;
  let m;
  while ((m = arrayFuncRegex.exec(code)) !== null) {
    arrayFuncNames.push({ name: m[1], pos: m.index });
  }
  
  // Pattern for decoder: function _0xXXXX(x, _) { x -= NNN; ... }
  const decoderRegex = /function\s+(_0x[a-f0-9]+)\s*\(\s*x\s*,\s*_\s*\)\s*\{\s*x\s*-=\s*(\d+)\s*;/g;
  const decoders = [];
  while ((m = decoderRegex.exec(code)) !== null) {
    decoders.push({ name: m[1], offset: parseInt(m[2]), pos: m.index });
  }
  
  if (decoders.length === 0) {
    console.log(`  No decoder found, beautifying only`);
    return simpleBeautify(code);
  }

  const decoder = decoders[0];
  console.log(`  Decoder: ${decoder.name}, offset: ${decoder.offset}`);
  
  // Step 2: Extract the setup code (array func + rotation + decoder definition)
  // We need to find the end of the decoder function
  let setupEnd = findFunctionEnd(code, decoder.pos);
  
  // Also need the RC4 setup that follows - look for the pattern after decoder
  // The decoder usually sets up .XxxXxx = RC4 function
  const afterDecoder = code.substring(setupEnd, Math.min(code.length, setupEnd + 5000));
  const rc4SetupEnd = afterDecoder.indexOf('return W}');
  if (rc4SetupEnd > 0) {
    setupEnd += rc4SetupEnd + 9;
  }
  
  // Find the rotation IIFE that comes before the decoder
  // Pattern: !function(x,_){...}(_0xArrayFunc, NUMBER)  
  // or (function(x,_){...})(_0xArrayFunc, NUMBER)
  let setupStart = 0;
  if (arrayFuncNames.length > 0) {
    setupStart = arrayFuncNames[0].pos;
  }
  
  let setupCode = code.substring(setupStart, setupEnd);
  
  // Step 3: Execute setup code in sandbox to get the decoder function working
  console.log(`  Setup code: ${(setupCode.length/1024).toFixed(1)} KB`);
  
  const sandbox = { 
    console: { log: () => {}, warn: () => {}, error: () => {} },
    parseInt, 
    String, 
    RegExp, 
    Boolean, 
    Math, 
    Array,
    Object,
    decodeURIComponent,
    encodeURIComponent,
    setTimeout: () => {},
    setInterval: () => {},
    clearTimeout: () => {},
    clearInterval: () => {},
  };
  
  const context = vm.createContext(sandbox);
  
  try {
    // Run the setup
    vm.runInContext(setupCode, context, { timeout: 10000 });
    console.log(`  Setup executed successfully`);
  } catch(e) {
    console.log(`  Setup execution error: ${e.message.substring(0, 100)}`);
    // Try alternative: just get the decoder by executing in smaller chunks
    return tryPartialDeobfuscation(code, decoder, context, filename);
  }
  
  // Step 4: Now try to resolve all decoder calls in the remaining code
  const decoderName = decoder.name;
  const escapedName = decoderName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  
  // Pattern: decoderName(number, "string") or wrapper functions that call it
  const callRegex = new RegExp(escapedName + '\\s*\\(\\s*(\\d+)\\s*,\\s*"([^"]*)"\\s*\\)', 'g');
  
  let resolved = 0;
  let failed = 0;
  let result = code;
  
  // Collect all matches first
  const matches = [];
  let match;
  while ((match = callRegex.exec(code)) !== null) {
    matches.push({ full: match[0], arg1: parseInt(match[1]), arg2: match[2], index: match.index });
  }
  
  console.log(`  Found ${matches.length} direct decoder calls`);
  
  // Resolve them
  for (const m of matches) {
    try {
      const val = vm.runInContext(`${decoderName}(${m.arg1}, "${m.arg2}")`, context, { timeout: 100 });
      if (typeof val === 'string') {
        result = result.replace(m.full, JSON.stringify(val));
        resolved++;
      } else {
        failed++;
      }
    } catch(e) {
      failed++;
    }
  }
  
  console.log(`  Resolved: ${resolved}, Failed: ${failed}`);
  
  // Step 5: Also try to resolve wrapper function calls
  // These are like: function _0xABC(a,b,c,d,e) { return decoder(c-123, a) }
  const wrapperRegex = /function\s+(_0x[a-f0-9]+)\s*\([^)]*\)\s*\{\s*return\s+/ + escapedName;
  
  // Beautify the final result
  return simpleBeautify(result);
}

function tryPartialDeobfuscation(code, decoder, context, filename) {
  console.log(`  Trying partial deobfuscation...`);
  
  // Try to at least extract all visible string constants and API patterns
  let result = code;
  
  // Find common patterns and replace with readable versions
  // chrome.runtime.sendMessage -> already visible as string in some contexts
  
  return simpleBeautify(result);
}

function findFunctionEnd(code, startPos) {
  let depth = 0;
  let inString = false;
  let strChar = '';
  let started = false;
  
  for (let i = startPos; i < code.length; i++) {
    const ch = code[i];
    
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === strChar) inString = false;
      continue;
    }
    
    if (ch === '"' || ch === "'") {
      inString = true;
      strChar = ch;
      continue;
    }
    
    if (ch === '{') { depth++; started = true; }
    if (ch === '}') { 
      depth--;
      if (started && depth === 0) return i + 1;
    }
  }
  
  return Math.min(startPos + 50000, code.length);
}

function simpleBeautify(code) {
  // Use a simple approach - just format with proper newlines
  let result = '';
  let indent = 0;
  let inStr = false;
  let strCh = '';
  let lineLen = 0;
  const MAX_LINE = 120;
  
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    const next = code[i+1] || '';
    
    if (inStr) {
      result += ch;
      lineLen++;
      if (ch === '\\') { result += next; i++; lineLen++; continue; }
      if (ch === strCh) inStr = false;
      continue;
    }
    
    if (ch === '"' || ch === "'" || ch === '`') {
      inStr = true;
      strCh = ch;
      result += ch;
      lineLen++;
      continue;
    }
    
    if (ch === '{') {
      indent++;
      result += ' {\n' + '  '.repeat(indent);
      lineLen = indent * 2;
      continue;
    }
    
    if (ch === '}') {
      indent = Math.max(0, indent - 1);
      result += '\n' + '  '.repeat(indent) + '}';
      lineLen = indent * 2 + 1;
      if (next && next !== ',' && next !== ';' && next !== ')' && next !== ']' && next !== '}' && next !== '.') {
        result += '\n' + '  '.repeat(indent);
        lineLen = indent * 2;
      }
      continue;
    }
    
    if (ch === ';' && next !== '}') {
      result += ';\n' + '  '.repeat(indent);
      lineLen = indent * 2;
      continue;
    }
    
    result += ch;
    lineLen++;
  }
  
  return result;
}
