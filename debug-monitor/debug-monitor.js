/**
 * MiniMax Browser Debug Monitor
 * Comprehensive Playwright script for catching console errors, network failures,
 * UI inconsistencies, and performance issues.
 *
 * Usage: node debug-monitor.js <url> [options]
 *   <url>           Target URL to monitor
 *   --headless     Run in headless mode (default: false, shows browser)
 *   --duration     How long to run monitoring in seconds (default: 60)
 *   --output       Output file path for the report (default: debug-report.json)
 *
 * Example:
 *   node debug-monitor.js https://example.com --headless --duration 30
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

// ─── ANSI Colors ────────────────────────────────────────────────────────────
const colors = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  green: '\x1b[32m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  dim: '\x1b[2m',
};

const log = {
  error: (...args) => console.log(`${colors.red}[ERROR]${colors.reset}`, ...args),
  warn:  (...args) => console.log(`${colors.yellow}[WARN]${colors.reset}`,  ...args),
  info:  (...args) => console.log(`${colors.blue}[INFO]${colors.reset}`,  ...args),
  ok:    (...args) => console.log(`${colors.green}[OK]${colors.reset}`,    ...args),
  debug: (...args) => console.log(`${colors.dim}[DEBUG]${colors.reset}`, ...args),
  perf:  (...args) => console.log(`${colors.magenta}[PERF]${colors.reset}`, ...args),
  ui:    (...args) => console.log(`${colors.cyan}[UI]${colors.reset}`,    ...args),
  net:   (...args) => console.log(`${colors.cyan}[NET]${colors.reset}`,   ...args),
};

// ─── Report Store ─────────────────────────────────────────────────────────────
const report = {
  startedAt: new Date().toISOString(),
  url: '',
  duration: 0,
  consoleErrors: [],
  consoleWarnings: [],
  consoleLogs: [],
  networkFailures: [],
  uiIssues: [],
  performanceIssues: [],
  metrics: {},
  pageErrors: [],
};

// ─── Parse CLI Args ───────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const targetUrl = args[0] || 'https://example.com';
const flags = {
  headless: args.includes('--headless'),
  duration: (() => {
    const idx = args.indexOf('--duration');
    return idx !== -1 && args[idx + 1] ? parseInt(args[idx + 1], 10) : 60;
  })(),
  output: (() => {
    const idx = args.indexOf('--output');
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : 'debug-report.json';
  })(),
};

log.info(`${colors.bright}Browser Debug Monitor${colors.reset}`);
log.info(`  Target:  ${targetUrl}`);
log.info(`  Headless: ${flags.headless}`);
log.info(`  Duration: ${flags.duration}s`);
log.info(`  Output:   ${flags.output}`);
log.info('');

// ─── Main ──────────────────────────────────────────────────────────────────────
(async () => {
  let browser;
  try {
    browser = await chromium.launch({ headless: flags.headless });
    const context = await browser.newContext();
    const page = await context.newPage();

    report.url = targetUrl;

    // Setup intercepts
    setupConsoleMonitor(page);
    setupNetworkMonitor(page);
    setupPageErrorMonitor(page);
    setupUIMonitor(page);
    setupPerformanceMonitor(page);

    log.info(`${colors.bright}Starting monitoring...${colors.reset}\n`);

    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Let the page run for the specified duration
    const startTime = Date.now();
    const endTime = startTime + flags.duration * 1000;

    let tick = 0;
    while (Date.now() < endTime) {
      await page.waitForTimeout(1000);
      tick++;

      // Periodic heartbeat
      if (tick % 10 === 0) {
        log.debug(`Still monitoring... (${tick}s / ${flags.duration}s)`);
      }
    }

    report.duration = (Date.now() - startTime) / 1000;

    // Capture final performance metrics
    await capturePerformanceMetrics(page);

    // Finalize and export report
    report.finishedAt = new Date().toISOString();
    await exportReport();

    // Print summary
    printSummary();
  } catch (error) {
    log.error(`Monitoring failed: ${error.message}`);
    process.exitCode = 1;
  } finally {
    clearInterval(perfInterval);
    if (browser) await browser.close();
  }
})();

// ─── Console Monitor ──────────────────────────────────────────────────────────
function setupConsoleMonitor(page) {
  page.on('console', msg => {
    const type = msg.type();
    const text = msg.text();
    const location = msg.location();

    const entry = {
      timestamp: new Date().toISOString(),
      type,
      message: text,
      url: location.url,
      line: location.lineNumber,
    };

    if (type === 'error') {
      log.error(`${colors.dim}${location.url}:${location.lineNumber}${colors.reset} ${text}`);
      report.consoleErrors.push(entry);
    } else if (type === 'warning') {
      log.warn(`${colors.dim}${location.url}:${location.lineNumber}${colors.reset} ${text}`);
      report.consoleWarnings.push(entry);
    } else if (type === 'log') {
      log.debug(`[console.log] ${text}`);
      report.consoleLogs.push(entry);
    }
  });
}

// ─── Network Monitor ──────────────────────────────────────────────────────────
function setupNetworkMonitor(page) {
  page.on('requestfailed', request => {
    const failure = {
      timestamp: new Date().toISOString(),
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      failure: request.failure()?.errorText || 'unknown',
    };
    log.net(`FAILED  ${request.method()} ${request.url()} — ${failure.failure}`);
    report.networkFailures.push(failure);
  });

  page.on('response', response => {
    if (response.status() >= 400) {
      const failure = {
        timestamp: new Date().toISOString(),
        url: response.url(),
        status: response.status(),
        statusText: response.statusText(),
        resourceType: response.request().resourceType(),
      };
      log.net(`ERROR   ${response.status()} ${response.url()}`);
      report.networkFailures.push(failure);
    }
  });
}

// ─── Page Error Monitor ───────────────────────────────────────────────────────
function setupPageErrorMonitor(page) {
  page.on('pageerror', err => {
    const entry = {
      timestamp: new Date().toISOString(),
      message: err.message,
      stack: err.stack || '',
    };
    log.error(`Uncaught exception: ${err.message}`);
    if (err.stack) log.debug(err.stack);
    report.pageErrors.push(entry);
  });

  process.on('unhandledRejection', (reason, promise) => {
    const entry = {
      timestamp: new Date().toISOString(),
      reason: String(reason),
      stack: reason?.stack || '',
    };
    log.error(`Unhandled promise rejection: ${reason}`);
    report.pageErrors.push({ type: 'unhandledRejection', ...entry });
  });
}

// ─── UI Inconsistency Monitor ─────────────────────────────────────────────────
function setupUIMonitor(page) {
  let previousHtml = '';

  // Detect missing elements, layout shifts, and DOM anomalies
  const checkUI = async () => {
    try {
      const html = await page.evaluate(() => document.body ? document.body.innerHTML.substring(0, 500) : '');

      // Check for broken images
      const brokenImages = await page.evaluate(() => {
        const imgs = Array.from(document.querySelectorAll('img'));
        return imgs.filter(img => !img.complete || img.naturalWidth === 0).map(img => ({
          src: img.src,
          alt: img.alt,
          visible: img.offsetWidth > 0 && img.offsetHeight > 0,
        }));
      });

      if (brokenImages.length > 0) {
        const issue = {
          timestamp: new Date().toISOString(),
          type: 'broken_images',
          count: brokenImages.length,
          details: brokenImages,
        };
        log.ui(`Broken/missing images detected: ${brokenImages.length}`);
        report.uiIssues.push(issue);
      }

      // Check for empty src attributes
      const emptySrcs = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('[src=""], [src="null"], [src="undefined"]'))
          .map(el => ({ tag: el.tagName, id: el.id, class: el.className }));
      });

      if (emptySrcs.length > 0) {
        const issue = {
          timestamp: new Date().toISOString(),
          type: 'empty_src_attributes',
          count: emptySrcs.length,
          details: emptySrcs,
        };
        log.ui(`Empty src attributes found: ${emptySrcs.length}`);
        report.uiIssues.push(issue);
      }

      // Check for visible hidden elements
      const hiddenButVisible = await page.evaluate(() => {
        return Array.from(document.querySelectorAll('[hidden], [style*="display: none"], [style*="visibility: hidden"]'))
          .filter(el => {
            const style = window.getComputedStyle(el);
            return el.offsetWidth > 0 || el.offsetHeight > 0;
          })
          .map(el => ({ tag: el.tagName, id: el.id, class: el.className }));
      });

      if (hiddenButVisible.length > 0) {
        const issue = {
          timestamp: new Date().toISOString(),
          type: 'hidden_but_visible',
          count: hiddenButVisible.length,
          details: hiddenButVisible,
        };
        log.ui(`Hidden elements still visible: ${hiddenButVisible.length}`);
        report.uiIssues.push(issue);
      }

      // Check for very deep DOM nesting
      const maxDepth = await page.evaluate(() => {
        let max = 0;
        const walk = (el, d) => {
          if (d > max) max = d;
          for (const child of el.children) walk(child, d + 1);
        };
        if (document.body) walk(document.body, 0);
        return max;
      });

      if (maxDepth > 50) {
        const issue = {
          timestamp: new Date().toISOString(),
          type: 'deep_dom_nesting',
          depth: maxDepth,
        };
        log.ui(`Excessive DOM depth: ${maxDepth} levels`);
        report.uiIssues.push(issue);
      }

      previousHtml = html;
    } catch (e) {
      // Ignore errors from cross-origin frames etc.
    }
  };

  // Run UI checks every 5 seconds
  page.on('domcontentloaded', () => {
    checkUI();
    const interval = setInterval(checkUI, 5000);
    page.on('close', () => clearInterval(interval));
  });
}

// ─── Performance Monitor ──────────────────────────────────────────────────────
let perfInterval;
let lastPerfMetrics = {};

function setupPerformanceMonitor(page) {
  page.on('load', async () => {
    await capturePerformanceMetrics(page);
  });

  perfInterval = setInterval(async () => {
    try {
      const metrics = await page.evaluate(() => ({
        longTasks: performance.getEntriesByType('longtask')
          .map(entry => ({ startTime: entry.startTime, duration: entry.duration })),
        layoutShifts: performance.getEntriesByType('layout-shift')
          .map(entry => ({ startTime: entry.startTime, value: entry.value })),
      }));

      for (const task of metrics.longTasks.slice(lastPerfMetrics.longTaskCount || 0)) {
        if (task.duration > 50) {
          log.perf(`Long task detected: ${task.duration.toFixed(1)}ms`);
          report.performanceIssues.push({
            timestamp: new Date().toISOString(),
            type: 'long_task',
            duration: task.duration / 1000,
            description: `Task took ${task.duration.toFixed(1)}ms`,
          });
        }
      }

      const layoutShifts = metrics.layoutShifts.reduce((sum, entry) => sum + entry.value, 0);
      if (layoutShifts > 0.1 && layoutShifts > (lastPerfMetrics.layoutShifts || 0)) {
        log.perf(`Layout shift detected: ${layoutShifts.toFixed(3)}`);
        report.performanceIssues.push({
          timestamp: new Date().toISOString(),
          type: 'layout_shift',
          value: layoutShifts,
          description: `Cumulative layout shift: ${layoutShifts.toFixed(3)}`,
        });
      }

      lastPerfMetrics = {
        longTaskCount: metrics.longTasks.length,
        layoutShifts,
      };
    } catch (e) {
      // Ignore
    }
  }, 2000);
}

async function capturePerformanceMetrics(page) {
  try {
    const metrics = await page.evaluate(() => {
      const timing = performance.timing;
      const navigation = performance.getEntriesByType('navigation')[0] || {};
      const paint = performance.getEntriesByType('paint');

      return {
        // Timing
        dns: timing.domainLookupEnd - timing.domainLookupStart,
        tcp: timing.connectEnd - timing.connectStart,
        ttfb: timing.responseStart - timing.requestStart,
        domLoad: timing.domContentLoadedEventEnd - timing.navigationStart,
        pageLoad: timing.loadEventEnd - timing.navigationStart,
        // Paint
        fcp: paint.find(e => e.name === 'first-contentful-paint')?.startTime || 0,
        fp: paint.find(e => e.name === 'first-paint')?.startTime || 0,
        // Memory (if available)
        jsHeapSize: performance.memory ? performance.memory.usedJSHeapSize : 0,
        jsHeapTotal: performance.memory ? performance.memory.totalJSHeapSize : 0,
        // Resource counts
        resources: performance.getEntriesByType('resource').length,
      };
    });

    report.metrics = metrics;

    log.perf(`${colors.bright}Performance snapshot:${colors.reset}`);
    log.perf(`  DNS lookup:   ${metrics.dns}ms`);
    log.perf(`  TCP handshake: ${metrics.tcp}ms`);
    log.perf(`  TTFB:          ${metrics.ttfb}ms`);
    log.perf(`  DOM ready:     ${metrics.domLoad}ms`);
    log.perf(`  Page loaded:   ${metrics.pageLoad}ms`);
    if (metrics.fcp) log.perf(`  FCP:           ${metrics.fcp.toFixed(0)}ms`);
    if (metrics.jsHeapSize) {
      log.perf(`  JS Heap used:  ${(metrics.jsHeapSize / 1024 / 1024).toFixed(1)}MB`);
    }
    log.perf(`  Resources:     ${metrics.resources}`);
  } catch (e) {
    log.warn('Could not capture performance metrics');
  }
}

// ─── Export Report ────────────────────────────────────────────────────────────
async function exportReport() {
  try {
    const htmlReport = generateHTMLReport();

    fs.writeFileSync(flags.output, JSON.stringify(report, null, 2));
    log.ok(`JSON report saved: ${flags.output}`);

    const htmlOutput = flags.output.replace('.json', '.html');
    fs.writeFileSync(htmlOutput, htmlReport);
    log.ok(`HTML report saved: ${htmlOutput}`);
  } catch (e) {
    log.error(`Failed to write report: ${e.message}`);
  }
}

function generateHTMLReport() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Debug Monitor Report — ${targetUrl}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: #0f0f0f; color: #e0e0e0; padding: 2rem; }
    h1 { color: #fff; margin-bottom: 0.5rem; }
    .meta { color: #888; margin-bottom: 2rem; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 1.5rem; }
    .card { background: #1a1a1a; border-radius: 8px; padding: 1.5rem; border: 1px solid #333; }
    .card h2 { font-size: 0.85rem; text-transform: uppercase; letter-spacing: 0.1em; color: #888; margin-bottom: 1rem; border-bottom: 1px solid #333; padding-bottom: 0.5rem; }
    .card.error h2 { color: #ff6b6b; border-color: #ff6b6b44; }
    .card.warn h2 { color: #ffd93d; border-color: #ffd93d44; }
    .card.net h2 { color: #74b9ff; border-color: #74b9ff44; }
    .card.ui h2 { color: #55efc4; border-color: #55efc444; }
    .card.perf h2 { color: #a29bfe; border-color: #a29bfe44; }
    .count { font-size: 2.5rem; font-weight: 700; color: #fff; }
    .count.zero { color: #555; }
    ul { list-style: none; }
    li { padding: 0.5rem 0; border-bottom: 1px solid #2a2a2a; font-size: 0.875rem; word-break: break-all; }
    li:last-child { border-bottom: none; }
    .timestamp { color: #555; font-size: 0.75rem; display: block; margin-top: 2px; }
    .tag { display: inline-block; background: #333; border-radius: 4px; padding: 1px 6px; font-size: 0.7rem; margin-right: 4px; }
    table { width: 100%; border-collapse: collapse; font-size: 0.8rem; }
    th { text-align: left; color: #888; border-bottom: 1px solid #333; padding: 0.5rem; }
    td { padding: 0.5rem; border-bottom: 1px solid #2a2a2a; }
    tr:hover { background: #222; }
    .metric-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; }
    .metric { background: #222; border-radius: 6px; padding: 1rem; text-align: center; }
    .metric .val { font-size: 1.5rem; font-weight: 700; color: #fff; }
    .metric .label { font-size: 0.75rem; color: #888; margin-top: 0.25rem; }
  </style>
</head>
<body>
  <h1>🐛 Debug Monitor Report</h1>
  <p class="meta">${report.url} &nbsp;|&nbsp; ${report.startedAt} &nbsp;|&nbsp; Duration: ${report.duration.toFixed(1)}s</p>

  <div class="grid">
    <div class="card error">
      <h2>Console Errors</h2>
      <div class="count ${report.consoleErrors.length === 0 ? 'zero' : ''}">${report.consoleErrors.length}</div>
      ${report.consoleErrors.length > 0 ? `<ul>${report.consoleErrors.slice(0, 20).map(e => `<li>${escapeHtml(e.message)}<span class="timestamp">${e.timestamp} — ${e.url}:${e.line}</span></li>`).join('')}</ul>` : '<p style="color:#555">No errors</p>'}
    </div>

    <div class="card warn">
      <h2>Console Warnings</h2>
      <div class="count ${report.consoleWarnings.length === 0 ? 'zero' : ''}">${report.consoleWarnings.length}</div>
      ${report.consoleWarnings.length > 0 ? `<ul>${report.consoleWarnings.slice(0, 10).map(e => `<li>${escapeHtml(e.message)}<span class="timestamp">${e.timestamp}</span></li>`).join('')}</ul>` : '<p style="color:#555">No warnings</p>'}
    </div>

    <div class="card net">
      <h2>Network Failures</h2>
      <div class="count ${report.networkFailures.length === 0 ? 'zero' : ''}">${report.networkFailures.length}</div>
      ${report.networkFailures.length > 0 ? `<ul>${report.networkFailures.slice(0, 20).map(e => `<li><span class="tag">${e.status || 'FAILED'}</span> ${escapeHtml(e.url)}<span class="timestamp">${e.timestamp}</span></li>`).join('')}</ul>` : '<p style="color:#555">No failures</p>'}
    </div>

    <div class="card ui">
      <h2>UI Issues</h2>
      <div class="count ${report.uiIssues.length === 0 ? 'zero' : ''}">${report.uiIssues.length}</div>
      ${report.uiIssues.length > 0 ? `<ul>${report.uiIssues.slice(0, 20).map(e => `<li><span class="tag">${e.type}</span>${e.description || ''}<span class="timestamp">${e.timestamp}</span></li>`).join('')}</ul>` : '<p style="color:#555">No issues</p>'}
    </div>

    <div class="card perf">
      <h2>Performance Issues</h2>
      <div class="count ${report.performanceIssues.length === 0 ? 'zero' : ''}">${report.performanceIssues.length}</div>
      ${report.performanceIssues.length > 0 ? `<ul>${report.performanceIssues.slice(0, 20).map(e => `<li><span class="tag">${e.type}</span>${e.description || ''}<span class="timestamp">${e.timestamp}</span></li>`).join('')}</ul>` : '<p style="color:#555">No issues</p>'}
    </div>

    <div class="card error">
      <h2>Page Errors</h2>
      <div class="count ${report.pageErrors.length === 0 ? 'zero' : ''}">${report.pageErrors.length}</div>
      ${report.pageErrors.length > 0 ? `<ul>${report.pageErrors.slice(0, 10).map(e => `<li>${escapeHtml(e.message || e.reason)}<span class="timestamp">${e.timestamp}</span></li>`).join('')}</ul>` : '<p style="color:#555">No errors</p>'}
    </div>
  </div>

  ${report.metrics && Object.keys(report.metrics).length > 0 ? `
  <div class="card" style="margin-top:1.5rem;">
    <h2>Performance Metrics</h2>
    <div class="metric-grid">
      <div class="metric"><div class="val">${report.metrics.dns}ms</div><div class="label">DNS Lookup</div></div>
      <div class="metric"><div class="val">${report.metrics.tcp}ms</div><div class="label">TCP Handshake</div></div>
      <div class="metric"><div class="val">${report.metrics.ttfb}ms</div><div class="label">TTFB</div></div>
      <div class="metric"><div class="val">${report.metrics.domLoad}ms</div><div class="label">DOM Ready</div></div>
      <div class="metric"><div class="val">${report.metrics.pageLoad}ms</div><div class="label">Page Load</div></div>
      <div class="metric"><div class="val">${report.metrics.fcp?.toFixed(0) || '—'}ms</div><div class="label">First Contentful Paint</div></div>
      <div class="metric"><div class="val">${report.metrics.resources || 0}</div><div class="label">Resources</div></div>
      <div class="metric"><div class="val">${report.metrics.jsHeapSize ? (report.metrics.jsHeapSize / 1024 / 1024).toFixed(1) + 'MB' : '—'}</div><div class="label">JS Heap Used</div></div>
    </div>
  </div>
  ` : ''}
</body>
</html>`;
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Summary ──────────────────────────────────────────────────────────────────
function printSummary() {
  console.log('\n' + '='.repeat(60));
  log.info(`${colors.bright}Monitoring Complete — Summary${colors.reset}\n`);

  const totalIssues =
    report.consoleErrors.length +
    report.networkFailures.length +
    report.uiIssues.length +
    report.performanceIssues.length +
    report.pageErrors.length;

  const rows = [
    ['Console Errors',    report.consoleErrors.length,   'error'],
    ['Console Warnings',  report.consoleWarnings.length,  'warn'],
    ['Network Failures',  report.networkFailures.length,   'net'],
    ['UI Issues',         report.uiIssues.length,          'ui'],
    ['Performance Issues',report.performanceIssues.length, 'perf'],
    ['Page Errors',       report.pageErrors.length,        'error'],
  ];

  const maxLabelLen = Math.max(...rows.map(r => r[0].length));
  for (const [label, count, type] of rows) {
    const labelPadded = label.padEnd(maxLabelLen + 2);
    const countStr = count === 0
      ? `${colors.dim}${count}  ${colors.reset}`
      : `${count}  `;
    const color = count > 0 ? colors.red : colors.green;
    console.log(`  ${color}${labelPadded}${countStr}${colors.reset}`);
  }

  console.log('  ' + '─'.repeat(maxLabelLen + 6));
  console.log(`  ${colors.bright}Total Issues:   ${totalIssues}${colors.reset}`);
  console.log(`  Duration:     ${report.duration.toFixed(1)}s`);
  console.log('\n' + '='.repeat(60));
  log.ok(`Reports saved to ${flags.output} and ${flags.output.replace('.json', '.html')}`);
}
