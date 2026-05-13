#!/usr/bin/env node
/**
 * Manual deobfuscator for javascript-obfuscator output
 * Approach: Execute the string array + decoder functions, then replace all encoded calls
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SCRIPT_DIR = path.join(__dirname, 'script');
const OUTPUT_DIR = path.join(__dirname, 'deobfuscated');

if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

const files = fs.readdirSync(SCRIPT_DIR).filter(f => f.endsWith('.js') && f !== 'minify-all.js' && f !== 'READ_THIS.js' && f !== 'version.js');

console.log(`Found ${files.length} JS files to attempt deobfuscation\n`);

for (const file of files) {
  console.log(`\n=== Processing: ${file} ===`);
  const filePath = path.join(SCRIPT_DIR, file);
  const code = fs.readFileSync(filePath, 'utf-8');
  
  try {
    // Strategy 1: Try to extract and execute the string array + rotation + decoder
    // Then do string replacement
    
    // Find the main string array function (e.g., _0x2525, _0x350c, _0x50cf, etc.)
    const arrayFuncMatch = code.match(/function\s+(_0x[a-f0-9]+)\s*\(\s*\)\s*\{\s*(?:var|const)\s+x\s*=\s*\[/);
    
    if (!arrayFuncMatch) {
      // Try alternative pattern: already has the array inline
      const altMatch = code.match(/(_0x[a-f0-9]+)\s*=\s*function\s*\(\s*\)\s*\{\s*(?:var|const)\s+x\s*=\s*\[/);
      if (!altMatch) {
        console.log(`  Could not find string array function pattern. Trying beautify only...`);
        // Just beautify
        const beautified = beautifyCode(code);
        fs.writeFileSync(path.join(OUTPUT_DIR, file), beautified, 'utf-8');
        console.log(`  Saved beautified version (${(beautified.length/1024).toFixed(1)} KB)`);
        continue;
      }
    }
    
    // Try a different approach: extract all string literals from the array
    const stringArrayMatch = code.match(/\[\s*"[^"]*"(?:\s*,\s*"[^"]*")*\s*\]/);
    
    // For these heavily obfuscated files, let's try executing parts in a sandbox
    // Extract the first ~50KB which usually contains setup code
    const setupLength = Math.min(code.length, 100000);
    const setupCode = code.substring(0, setupLength);
    
    // Find the decoder function pattern
    const decoderMatch = code.match(/function\s+(_0x[a-f0-9]+)\s*\(\s*x\s*,\s*_\s*\)\s*\{\s*x\s*-=\s*(\d+)/);
    
    if (decoderMatch) {
      console.log(`  Found decoder: ${decoderMatch[1]}, offset: ${decoderMatch[2]}`);
    }
    
    // For now, let's do a structural deobfuscation:
    // 1. Beautify the code
    // 2. Try to identify and label key sections
    let result = beautifyCode(code);
    
    // Try to find and extract meaningful strings
    const strings = extractStrings(code);
    if (strings.length > 0) {
      console.log(`  Found ${strings.length} encoded strings in array`);
    }
    
    // Extract URLs/API endpoints that might be visible
    const urls = code.match(/https?:\/\/[^\s"'`,)]+/g) || [];
    if (urls.length > 0) {
      console.log(`  Found ${urls.length} URLs:`);
      urls.forEach(u => console.log(`    ${u}`));
    }
    
    // Save beautified result
    fs.writeFileSync(path.join(OUTPUT_DIR, file), result, 'utf-8');
    console.log(`  Saved beautified version (${(result.length/1024).toFixed(1)} KB)`);
    
  } catch (err) {
    console.log(`  Error: ${err.message}`);
    // Save raw as fallback
    fs.writeFileSync(path.join(OUTPUT_DIR, file), beautifyCode(code), 'utf-8');
  }
}

// Now try a more advanced approach - execute the decoder in a sandbox
console.log('\n\n=== Attempting advanced deobfuscation with VM sandbox ===\n');

for (const file of files) {
  console.log(`\n--- ${file} ---`);
  const filePath = path.join(SCRIPT_DIR, file);
  const code = fs.readFileSync(filePath, 'utf-8');
  
  try {
    const result = advancedDeobfuscate(code, file);
    if (result) {
      fs.writeFileSync(path.join(OUTPUT_DIR, file), result, 'utf-8');
      console.log(`  Advanced deobfuscation saved (${(result.length/1024).toFixed(1)} KB)`);
    }
  } catch(err) {
    console.log(`  Advanced deobfuscation failed: ${err.message}`);
  }
}

console.log('\n\nDone! Check the "deobfuscated" folder.');

// === Helper Functions ===

function beautifyCode(code) {
  // Simple beautifier - add newlines and indentation
  let result = '';
  let indent = 0;
  let inString = false;
  let stringChar = '';
  let i = 0;
  
  while (i < code.length) {
    const ch = code[i];
    const next = code[i + 1];
    
    if (inString) {
      result += ch;
      if (ch === '\\') {
        result += next || '';
        i += 2;
        continue;
      }
      if (ch === stringChar) {
        inString = false;
      }
      i++;
      continue;
    }
    
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = true;
      stringChar = ch;
      result += ch;
      i++;
      continue;
    }
    
    if (ch === '{') {
      indent++;
      result += ' {\n' + '  '.repeat(indent);
      i++;
      continue;
    }
    
    if (ch === '}') {
      indent = Math.max(0, indent - 1);
      result += '\n' + '  '.repeat(indent) + '}';
      if (next === ',' || next === ';' || next === ')') {
        // don't add newline yet
      } else if (next !== undefined) {
        result += '\n' + '  '.repeat(indent);
      }
      i++;
      continue;
    }
    
    if (ch === ';') {
      result += ';\n' + '  '.repeat(indent);
      i++;
      continue;
    }
    
    if (ch === ',' && !isInsideParens(code, i)) {
      result += ',\n' + '  '.repeat(indent);
      i++;
      continue;
    }
    
    result += ch;
    i++;
  }
  
  return result;
}

function isInsideParens(code, pos) {
  // Simplified check - count parens before position
  let depth = 0;
  for (let i = Math.max(0, pos - 500); i < pos; i++) {
    if (code[i] === '(') depth++;
    if (code[i] === ')') depth--;
  }
  return depth > 0;
}

function extractStrings(code) {
  // Extract base64-like strings from the string array
  const match = code.match(/\[("(?:[^"\\]|\\.)*"(?:\s*,\s*"(?:[^"\\]|\\.)*")*)\]/);
  if (!match) return [];
  try {
    return JSON.parse('[' + match[1] + ']');
  } catch(e) {
    return [];
  }
}

function advancedDeobfuscate(code, filename) {
  // Try to execute the string rotation + decoder setup
  // Then replace all decoder calls with their resolved values
  
  // Find the string array function
  const arrayFuncRegex = /function\s+(_0x[a-f0-9]+)\s*\(\s*\)\s*\{[\s\S]*?return\s*\(\s*\1\s*=\s*function/;
  const arrayMatch = code.match(arrayFuncRegex);
  
  // Find the IIFE that does rotation
  const rotationRegex = /!\s*function\s*\(\s*x\s*,\s*_\s*\)\s*\{[\s\S]*?(?:parseInt|_0x)[\s\S]*?\}\s*\(\s*(_0x[a-f0-9]+)\s*,\s*(\d+)\s*\)/;
  const rotMatch = code.match(rotationRegex);
  
  // Find the decoder function  
  const decoderRegex = /function\s+(_0x[a-f0-9]+)\s*\(\s*x\s*,\s*_\s*\)\s*\{\s*x\s*-=\s*(\d+)\s*;/;
  const decMatch = code.match(decoderRegex);
  
  if (!decMatch) {
    console.log(`  No decoder function found`);
    return null;
  }
  
  const decoderName = decMatch[1];
  const offset = parseInt(decMatch[2]);
  console.log(`  Decoder: ${decoderName}, offset: ${offset}`);
  
  // Try to extract just the string array
  // Pattern: const x = ["str1", "str2", ...]
  // These are typically base64+RC4 encoded
  const strArrayRegex = /(?:const|var)\s+x\s*=\s*(\[(?:"[^"]*"(?:\s*,\s*"[^"]*")*)\])/;
  const strArrMatch = code.match(strArrayRegex);
  
  if (strArrMatch) {
    try {
      const strings = JSON.parse(strArrMatch[1]);
      console.log(`  String array has ${strings.length} entries`);
      
      // These strings are RC4 encrypted, we'd need the key for each call
      // For now, just note the count
    } catch(e) {
      console.log(`  Could not parse string array: ${e.message}`);
    }
  }
  
  // Try to run the entire decoder setup in a VM
  try {
    // Extract everything up to and including the decoder function definition
    const decoderEndPos = code.indexOf(decoderName + '.', code.indexOf('function ' + decoderName));
    if (decoderEndPos === -1) {
      // Try finding end by looking for the closing pattern
      const setupEndRegex = new RegExp(decoderName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\.\\w+\\s*=');
      const endMatch = setupEndRegex.exec(code);
    }
    
    // Extract all the setup code (array + rotation + decoder)
    // This is complex - find where the "real" logic starts (after all anti-tamper wrappers)
    
    // For heavy obfuscation, let's at least identify key patterns:
    const keywords = [];
    
    // Look for chrome/browser extension API calls
    const chromeAPIs = code.match(/chrome\.\w+(?:\.\w+)*/g) || [];
    if (chromeAPIs.length > 0) {
      keywords.push(...[...new Set(chromeAPIs)]);
    }
    
    // Look for fetch/XMLHttpRequest patterns
    if (code.includes('fetch') || code.includes('XMLHttpRequest')) {
      keywords.push('fetch', 'XMLHttpRequest');
    }
    
    // Look for addEventListener
    const events = code.match(/addEventListener\s*\(\s*["'](\w+)["']/g) || [];
    keywords.push(...events);
    
    if (keywords.length > 0) {
      console.log(`  Key APIs found: ${keywords.slice(0, 20).join(', ')}`);
    }
    
  } catch(err) {
    console.log(`  VM execution failed: ${err.message}`);
  }
  
  return null; // Return null if advanced didn't produce better result
}
