#!/usr/bin/env node
/**
 * SWR-Check (Verifier Agent) - Non-interactive version
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_ROOT = path.join(__dirname, '../..');
const REPO_DIR = process.env.SWR_REPO || path.join(process.env.HOME, 'Documents', 'sainted-word-records');
const LOG_FILE = path.join(AGENT_ROOT, 'check', 'logs.txt');
const VERIFY_FILE = path.join(AGENT_ROOT, 'check', 'verifications.md');

function log(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [CHECK] ${msg}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

function runCmd(cmd, args = []) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd: REPO_DIR, shell: true, stdio: 'pipe' });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    proc.on('close', code => resolve({ code, stdout, stderr }));
    proc.on('error', reject);
  });
}

async function verifyFile(filePath) {
  const fullPath = path.join(REPO_DIR, filePath);
  const exists = fs.existsSync(fullPath);
  log(`File check: ${filePath} → ${exists ? 'EXISTS' : 'MISSING'}`);
  return { type: 'file', target: filePath, passed: exists, evidence: fullPath };
}

async function verifyTests() {
  log('Running tests...');
  const result = await runCmd('npm', ['run', 'check', '--silent']);
  return { type: 'tests', passed: result.code === 0, evidence: result.stdout.slice(-300) };
}

async function verifyClaim(claim) {
  log(`Verifying: "${claim}"`);
  const result = await runCmd('grep', ['-r', '-l', claim, REPO_DIR, '--include=*.md']);
  const found = result.stdout.length > 0;
  return { type: 'claim', claim, passed: found, evidence: found ? 'Found in docs' : 'Not found' };
}

function saveVerification(v) {
  let content = fs.existsSync(VERIFY_FILE) ? fs.readFileSync(VERIFY_FILE, 'utf-8') : '';
  content += `\n## ${new Date().toISOString()}\n- Type: ${v.type}\n- Target: ${v.target || v.claim}\n- Passed: ${v.passed}\n`;
  fs.writeFileSync(VERIFY_FILE, content);
}

function readCommand() {
  const cmdFile = path.join(AGENT_ROOT, 'check', 'command.txt');
  if (fs.existsSync(cmdFile)) {
    const cmd = fs.readFileSync(cmdFile, 'utf-8').trim();
    fs.unlinkSync(cmdFile);
    return cmd;
  }
  return null;
}

async function processCommand(cmd) {
  const parts = cmd.trim().split(' ');
  const action = parts[0];
  const args = parts.slice(1).join(' ');
  
  let verification;
  
  switch (action) {
    case 'file':
      verification = await verifyFile(args);
      console.log(`\n=== File Check ===`);
      console.log(`Path: ${verification.target}`);
      console.log(`Exists: ${verification.passed ? '✓ YES' : '✗ NO'}`);
      saveVerification(verification);
      break;
      
    case 'test':
      verification = await verifyTests();
      console.log(`\n=== Tests ===`);
      console.log(`Status: ${verification.passed ? '✓ PASSED' : '✗ FAILED'}`);
      saveVerification(verification);
      break;
      
    case 'claim':
      verification = await verifyClaim(args);
      console.log(`\n=== Claim Check ===`);
      console.log(`Claim: "${verification.claim}"`);
      console.log(`Found: ${verification.passed ? '✓' : '✗'}`);
      saveVerification(verification);
      break;
      
    case 'status':
      if (fs.existsSync(VERIFY_FILE)) {
        const content = fs.readFileSync(VERIFY_FILE, 'utf-8');
        const count = (content.match(/^##/gm) || []).length;
        console.log(`\n=== Verifications: ${count} ===`);
        console.log(content.slice(-500));
      } else {
        console.log('No verifications yet');
      }
      break;
      
    default:
      console.log(`Unknown: ${action}`);
  }
}

async function main() {
  // Ensure directories exist FIRST
  const checkDir = path.join(AGENT_ROOT, 'check');
  const opsDir = path.join(AGENT_ROOT, 'ops');
  const twinDir = path.join(AGENT_ROOT, 'twin');
  
  for (const d of [checkDir, opsDir, twinDir]) {
    if (!fs.existsSync(d)) {
      fs.mkdirSync(d, { recursive: true });
    }
  }
  
  log('SWR-Check starting...');
  log(`Repo: ${REPO_DIR}`);
  
  console.log('[CHECK] Ready. Use command.txt.');
  
  setInterval(async () => {
    const cmd = readCommand();
    if (cmd) {
      await processCommand(cmd);
    }
  }, 1000);
}

main().catch(e => {
  log(`Error: ${e.message}`);
  process.exit(1);
});
