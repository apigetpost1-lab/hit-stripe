#!/usr/bin/env node
/**
 * Special deobfuscator for inject.js which has a unique structure:
 * - Array func at position 0
 * - Rotation IIFE embedded inside an if() statement
 * - Decoder defined much later in the file
 * - Wrappers spread throughout
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const code = fs.readFileSync(path.join(__dirname, 'script/inject.js'), 'utf-8');
const OUTPUT = path.join(__dirname, 'deobfuscated/inject.js');

console.log('Processing inject.js (' + (code.length/1024/1024).toFixed(1) + ' MB)');

// Step 1: Extract components
const arrayCode = code.substring(0, 441486);

// Find decoder
const decoderStart = 2953331;
let depth = 0, inStr = false, strCh = '', started = false, decEnd = decoderStart;
for (let i = decoderStart; i < Math.min(code.length, decoderStart + 10000); i++) {
  const ch = code[i];
  if (inStr) { if (ch === '\\') { i++; continue; } if (ch === strCh) inStr = false; continue; }
  if (ch === '"' || ch === "'") { inStr = true; strCh = ch; continue; }
  if (ch === '{') { depth++; started = true; }
  if (ch === '}') { depth--; if (started && depth === 0) { decEnd = i + 1; break; } }
}
const decoderCode = code.substring(decoderStart, decEnd);

// Extract rotation IIFE  
const afterArray = code.substring(441486);
const rotCallStart = afterArray.indexOf('function(x,_){function _0x357fd9');
const rotCallEnd = afterArray.indexOf('_0x23f9,212299)');
const rotCode = '(' + afterArray.substring(rotCallStart, rotCallEnd + '_0x23f9,212299)'.length) + ')';

// Step 2: Setup VM
const setup = decoderCode + ';\n' + arrayCode + ';\n' + rotCode + ';';
console.log('Setup code:', (setup.length/1024).toFixed(1), 'KB');

const sandbox = {
  globalThis:{},self:{},window:{},
  navigator:{userAgent:'Mozilla/5.0',platform:'Win32',language:'en-US'},
  location:{href:'https://example.com',hostname:'example.com',protocol:'https:',origin:'https://example.com'},
  document:{createElement:()=>({style:{},appendChild:()=>{}}),querySelector:()=>null,querySelectorAll:()=>[],getElementById:()=>null,cookie:'',body:{style:{}},head:{style:{}}},
  chrome:{runtime:{sendMessage:()=>{},onMessage:{addListener:()=>{}},getURL:()=>'',id:'x'},storage:{local:{get:()=>Promise.resolve({}),set:()=>Promise.resolve()}},tabs:{query:()=>Promise.resolve([])}},
  console:{log:()=>{},warn:()=>{},error:()=>{},info:()=>{},debug:()=>{}},
  parseInt,parseFloat,isNaN,isFinite,NaN,Infinity,
  String,Number,Boolean,Array,Object,RegExp,Date,Math,JSON,
  Error,TypeError,RangeError,SyntaxError,ReferenceError,URIError,
  encodeURIComponent,decodeURIComponent,encodeURI,decodeURI,
  escape,unescape,
  setTimeout:(fn)=>{if(typeof fn==='function')try{fn()}catch(e){}return 0;},
  setInterval:()=>0,clearTimeout:()=>{},clearInterval:()=>{},
  atob:(s)=>Buffer.from(s,'base64').toString('binary'),
  btoa:(s)=>Buffer.from(s,'binary').toString('base64'),
  Map,Set,WeakMap,WeakSet,Promise,Symbol:global.Symbol,Proxy:global.Proxy,Reflect:global.Reflect,
  Uint8Array,Uint16Array,Int32Array,ArrayBuffer,DataView,
  URL:global.URL,URLSearchParams:global.URLSearchParams,
  TextEncoder:global.TextEncoder,TextDecoder:global.TextDecoder,
  fetch:()=>Promise.resolve({json:()=>Promise.resolve({}),text:()=>Promise.resolve('')}),
  XMLHttpRequest:function(){this.open=()=>{};this.send=()=>{};this.setRequestHeader=()=>{};},
  performance:{now:()=>Date.now()},
  crypto:{getRandomValues:(a)=>{for(let i=0;i<a.length;i++)a[i]=Math.floor(Math.random()*256);return a;}},
  queueMicrotask:(fn)=>{try{fn()}catch(e){}},
  undefined:undefined,alert:()=>{},confirm:()=>true,
  Audio:function(){this.play=()=>Promise.resolve();},
  Image:function(){},FormData:function(){this.append=()=>{};},
  AbortController:function(){this.signal={};this.abort=()=>{};},
  MutationObserver:function(){this.observe=()=>{};this.disconnect=()=>{};},
};

const ctx = vm.createContext(sandbox);
vm.runInContext(setup, ctx, { timeout: 60000 });
console.log('Decoder verified:', vm.runInContext('typeof _0x5416', ctx, {timeout:100}));

// Step 3: Find and register ALL wrapper functions
const wrapperRegex = /function\s+(_0x[a-f0-9]+)\s*\(([^)]+)\)\s*\{\s*return\s+_0x5416\(([^)]+)\)\s*\}/g;
let wm;
const wrappers = new Set();
while ((wm = wrapperRegex.exec(code)) !== null) {
  wrappers.add(wm[1]);
  try { vm.runInContext(wm[0], ctx, {timeout:100}); } catch(e) {}
}

// Also find wrappers that call other wrappers (chains)
const chainRegex = /function\s+(_0x[a-f0-9]+)\s*\(([^)]+)\)\s*\{\s*return\s+(_0x[a-f0-9]+)\s*\(([^)]+)\)\s*\}/g;
while ((wm = chainRegex.exec(code)) !== null) {
  if (wrappers.has(wm[3]) || wm[3] === '_0x5416') {
    wrappers.add(wm[1]);
    try { vm.runInContext(wm[0], ctx, {timeout:100}); } catch(e) {}
  }
}

console.log('Registered', wrappers.size, 'wrapper functions');

// Step 4: Resolve all calls with literal arguments
const allFuncNames = ['_0x5416', ...wrappers];
const litArg = `(?:-?\\d+|"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')`;
const argsPattern = `${litArg}(?:\\s*,\\s*${litArg})*`;

let result = code;
let totalResolved = 0;
const BATCH_SIZE = 100;

for (let batch = 0; batch < allFuncNames.length; batch += BATCH_SIZE) {
  const batchNames = allFuncNames.slice(batch, batch + BATCH_SIZE);
  const namesPattern = batchNames.map(n => n.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&')).join('|');
  const callRegex = new RegExp(`(?:${namesPattern})\\(\\s*${argsPattern}\\s*\\)`, 'g');
  
  const replacements = [];
  let cm;
  while ((cm = callRegex.exec(result)) !== null) {
    const before = result.substring(Math.max(0, cm.index - 10), cm.index);
    if (before.includes('return')) continue;
    
    try {
      const val = vm.runInContext(cm[0], ctx, {timeout:50});
      if (typeof val === 'string') {
        replacements.push({from: cm[0], to: JSON.stringify(val), index: cm.index});
      }
    } catch(e) {}
  }
  
  replacements.sort((a, b) => b.index - a.index);
  for (const r of replacements) {
    result = result.substring(0, r.index) + r.to + result.substring(r.index + r.from.length);
    totalResolved++;
  }
  
  if (batch % 500 === 0 && batch > 0) {
    console.log(`  Progress: ${batch}/${allFuncNames.length} functions, ${totalResolved} resolved`);
  }
}

console.log(`Total resolved: ${totalResolved}`);

// Step 5: Beautify and save
let beautified = '';
let indent = 0;
inStr = false;
for (let i = 0; i < result.length; i++) {
  const ch = result[i];
  const next = result[i+1] || '';
  if (inStr) {
    beautified += ch;
    if (ch === '\\') { beautified += next; i++; continue; }
    if (ch === strCh) inStr = false;
    continue;
  }
  if (ch === '"' || ch === "'" || ch === '`') { inStr = true; strCh = ch; beautified += ch; continue; }
  if (ch === '{') { indent++; beautified += ' {\n' + '  '.repeat(indent); continue; }
  if (ch === '}') { indent = Math.max(0, indent-1); beautified += '\n' + '  '.repeat(indent) + '}'; if(next&&next!==','&&next!==';'&&next!==')'&&next!==']'&&next!=='}'){beautified+='\n'+'  '.repeat(indent);} continue; }
  if (ch === ';') { beautified += ';\n' + '  '.repeat(indent); continue; }
  beautified += ch;
}

fs.writeFileSync(OUTPUT, beautified, 'utf-8');
console.log(`Output: ${(beautified.length/1024).toFixed(1)} KB`);
console.log('Done!');
