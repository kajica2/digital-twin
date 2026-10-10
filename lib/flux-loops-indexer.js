#!/usr/bin/env node
// lib/flux-loops-indexer.js — Indexes FLUX-generated video loops for Twin OS.
//
// Scans data/flux/loops-final/ and data/flux/stills/ to build a catalog
// of available loops that Twin OS can display.
//
// Usage:
//   node lib/flux-loops-indexer.js           # Scan and output JSON
//   node lib/flux-loops-indexer.js --apply  # Write to data/songs/catalog.json

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');
const LOOPS_DIR = path.join(REPO, 'data', 'flux', 'loops-final');
const STILLS_DIR = path.join(REPO, 'data', 'flux', 'stills');
const OUTPUT_FILE = path.join(REPO, 'data', 'flux', 'loops-catalog.json');

function getDuration(filePath) {
    return new Promise((resolve) => {
        const { spawn } = require('node:child_process');
        const ffprobe = spawn('ffprobe', [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            filePath
        ]);
        
        let output = '';
        ffprobe.stdout.on('data', (data) => { output += data; });
        ffprobe.on('close', (code) => {
            if (code === 0 && output.trim()) {
                resolve(parseFloat(output.trim()));
            } else {
                resolve(null);
            }
        });
        ffprobe.on('error', () => resolve(null));
    });
}

async function scanLoops() {
    const loops = [];
    
    // Check if directories exist
    if (!fs.existsSync(LOOPS_DIR)) {
        console.log('[loops-indexer] No loops directory yet:', LOOPS_DIR);
        return loops;
    }
    
    // Get all MP4 files in loops-final
    const files = fs.readdirSync(LOOPS_DIR).filter(f => f.endsWith('.mp4'));
    
    console.log(`[loops-indexer] Found ${files.length} loops`);
    
    for (const file of files) {
        const loopPath = path.join(LOOPS_DIR, file);
        const stat = fs.statSync(loopPath);
        
        // Find matching still (poster)
        const baseName = path.basename(file, '.mp4');
        const stillPath = path.join(STILLS_DIR, baseName + '.png');
        const stillPathAlt = path.join(STILLS_DIR, baseName + '.jpg');
        
        let poster = null;
        if (fs.existsSync(stillPath)) {
            poster = path.join('data', 'flux', 'stills', path.basename(stillPath));
        } else if (fs.existsSync(stillPathAlt)) {
            poster = path.join('data', 'flux', 'stills', path.basename(stillPathAlt));
        }
        
        // Get duration
        const duration = await getDuration(loopPath);
        
        loops.push({
            id: `flux/${baseName}`,
            title: baseName.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()),
            src: path.join('data', 'flux', 'loops-final', file),
            poster: poster,
            duration: duration || 4,
            type: 'loop',
            tags: ['flux', 'generated', 'ambient'],
            size: stat.size,
            mtime: stat.mtime.toISOString(),
        });
    }
    
    return loops;
}

async function main() {
    const args = process.argv.slice(2);
    const apply = args.includes('--apply');
    
    console.log('[loops-indexer] Scanning FLUX loops...');
    
    const loops = await scanLoops();
    
    const catalog = {
        generatedAt: new Date().toISOString(),
        count: loops.length,
        items: loops,
    };
    
    console.log('[loops-indexer]', JSON.stringify(catalog, null, 2));
    
    if (apply) {
        fs.writeFileSync(OUTPUT_FILE, JSON.stringify(catalog, null, 2));
        console.log('[loops-indexer] Written to:', OUTPUT_FILE);
    }
    
    return loops.length > 0 ? 0 : 1;
}

main().then(process.exit);
