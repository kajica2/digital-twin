#!/usr/bin/env node
/**
 * SWR-Check (Verifier Agent)
 * Read-only verification, validates claims, checks diffs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import readline from 'readline';
import { spawn } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AGENT_DIR = path.join(__dirname, '../..');
const REPO_DIR = process.env.SWR_REPO || path.join(__dirname, '../../..');
const LOG_FILE = path.join(AGENT_DIR, 'check', 'logs.txt');
const VERIFY_FILE = path.join(AGENT_DIR, 'check', 'verifications.md');

let running = false;

function log(msg) {
  const timestamp = new Date().toISOString();
  const line = `[${timestamp}] [CHECK] ${msg}`;
  console.log(`\n${line}`);
  fs.appendFileSync(LOG_FILE, line + '\n');
}

// Run command and get output
function runCmd(cmd, args = []) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { 
      cwd: REPO_DIR,
      shell: true,
      stdio: 'pipe'
    });
    
    let stdout = '';
    let stderr = '';
    
    proc.stdout.on('data', d => stdout += d);
    proc.stderr.on('data', d => stderr += d);
    
    proc.on('close', code => {
      resolve({ code, stdout, stderr });
    });
    
    proc.on('error', reject);
  });
}

// Verify a file exists
async function verifyFile(filePath) {
  const fullPath = path.join(REPO_DIR, filePath);
  const exists = fs.existsSync(fullPath);
  
  log(`File check: ${filePath} → ${exists ? 'EXISTS' : 'MISSING'}`);
  return {
    type: 'file_exists',
    target: filePath,
    passed: exists,
    evidence: exists ? fullPath : 'NOT FOUND'
  };
}

// Verify git diff
async function verifyDiff(patterns = []) {
  const result = await runCmd('git', ['diff', '--stat']);
  
  const findings = [];
  for (const pattern of patterns) {
    if (result.stdout.includes(pattern)) {
      findings.push({ pattern, found: true });
    }
  }
  
  log(`Diff check: ${findings.filter(f => f.found).length} patterns found`);
  return {
    type: 'git_diff',
    patterns,
    findings,
    evidence: result.stdout.slice(0, 500)
  };
}

// Run tests
async function verifyTests() {
  log('Running tests...');
  
  const result = await runCmd('npm', ['run', 'test', '--', '--silent']);
  
  const passed = result.code === 0;
  
  log(`Tests: ${passed ? 'PASS' : 'FAIL'}`);
  return {
    type: 'tests',
    passed,
    evidence: result.stdout.slice(-500)
  };
}

// Verify a claim
async function verifyClaim(claim) {
  // Simple keyword-based verification
  // In production, this would search docs/code
  
  log(`Verifying: "${claim}"`);
  
  const result = await runCmd('grep', ['-r', claim, REPO_DIR, '--include=*.md']);
  const found = result.stdout.length > 10;
  
  return {
    type: 'claim',
    claim,
    passed: found,
    evidence: found ? 'Found in docs' : 'Not found',
    recommendation: found ? 'APPROVE' : 'NEEDS EVIDENCE'
  };
}

// Read from ops
function readFromOps() {
  const inboxFile = path.join(AGENT_DIR, 'ops', 'inbox.txt');
  if (fs.existsSync(inboxFile)) {
    const content = fs.readFileSync(inboxFile, 'utf-8');
    fs.unlinkSync(inboxFile);
    return content.split('\n').filter(l => l.trim());
  }
  return [];
}

// Save verification
function saveVerification(verification) {
  let content = '';
  if (fs.existsSync(VERIFY_FILE)) {
    content = fs.readFileSync(VERIFY_FILE, 'utf-8');
  }
  
  content += `\n## ${new Date().toISOString()}\n\n`;
  content += `- Type: ${verification.type}\n`;
  content += `- Target: ${verification.target || verification.claim || 'N/A'}\n`;
  content += `- Passed: ${verification.passed}\n`;
  content += `- Evidence: ${verification.evidence}\n`;
  if (verification.recommendation) {
    content += `- Recommendation: ${verification.recommendation}\n`;
  }
  
  fs.writeFileSync(VERIFY_FILE, content);
}

// Main loop
async function main() {
  log('SWR-Check starting...');
  log(`Repo: ${REPO_DIR}`);
  
  const checkDir = path.join(AGENT_DIR, 'check');
  if (!fs.existsSync(checkDir)) fs.mkdirSync(checkDir, { recursive: true });
  
  running = true;
  
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true
  });
  
  log('SWR-Check ready. Commands: file, diff, test, claim, status, help');
  
  const prompt = () => {
    rl.question('\n[CHECK] > ', async (cmd) => {
      const parts = cmd.trim().split(' ');
      const action = parts[0];
      const args = parts.slice(1).join(' ');
      
      let verification;
      
      switch (action) {
        case 'file':
          verification = await verifyFile(args);
          console.log('\n=== Verification ===');
          console.log(`Type: ${verification.type}`);
          console.log(`Target: ${verification.target}`);
          console.log(`Passed: ${verification.passed ? '✓ YES' : '✗ NO'}`);
          console.log(`Evidence: ${verification.evidence}`);
          saveVerification(verification);
          break;
          
        case 'diff':
          const patterns = args.split(',').map(p => p.trim());
          verification = await verifyDiff(patterns);
          console.log('\n=== Diff Check ===');
          verification.findings.forEach(f => {
            console.log(`  ${f.found ? '✓' : '✗'} ${f.pattern}`);
          });
          saveVerification(verification);
          break;
          
        case 'test':
          verification = await verifyTests();
          console.log('\n=== Test Results ===');
          console.log(`Status: ${verification.passed ? '✓ PASSED' : '✗ FAILED'}`);
          console.log(verification.evidence.slice(-300));
          saveVerification(verification);
          break;
          
        case 'claim':
          verification = await verifyClaim(args);
          console.log('\n=== Claim Verification ===');
          console.log(`Claim: "${verification.claim}"`);
          console.log(`Passed: ${verification.passed ? '✓' : '✗'}`);
          console.log(`Evidence: ${verification.evidence}`);
          console.log(`Recommendation: ${verification.recommendation}`);
          saveVerification(verification);
          break;
          
        case 'status':
          if (fs.existsSync(VERIFY_FILE)) {
            const content = fs.readFileSync(VERIFY_FILE, 'utf-8');
            const lines = content.split('\n## ');
            console.log(`\n=== Verifications: ${lines.length - 1} ===`);
            console.log(content.slice(-1000));
          } else {
            console.log('No verifications yet');
          }
          break;
          
        case 'help':
          console.log(`
Commands:
  file <path>             - Verify file exists
  diff <pattern1,pattern2> - Check git diff for patterns
  test                    - Run npm test
  claim <statement>       - Verify a claim exists in docs
  status                  - Show verification history
  help                    - Show this help
`);
          break;
          
        default:
          if (action) log(`Unknown: ${action}`);
      }
      
      // Check inbox from ops
      const opsMsgs = readFromOps();
      for (const msg of opsMsgs) {
        if (msg.includes('verify:')) {
          const task = msg.replace('OPS→CHECK', '').replace('verify:', '').trim();
          log(`Verification requested: ${task}`);
          // Auto-verify
          await verifyClaim(task);
        }
      }
      
      prompt();
    });
  }
  
  prompt();
}

main().catch(e => {
  log(`Error: ${e.message}`);
  process.exit(1);
});
