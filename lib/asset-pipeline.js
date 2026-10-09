#!/usr/bin/env node
'use strict';
// lib/asset-pipeline.js
//
// Asset Pipeline: Convert images/GIFs to MP4 with analysis and viral-optimized metadata.
//
// Usage:
//   node lib/asset-pipeline.js <input-dir> [--output <dir>] [--batch] [--analyze]
//   node lib/asset-pipeline.js --help
//
// Takes images/GIFs, converts to MP4 with Ken Burns motion,
// analyzes content, generates metadata, organizes into export-ready folders.

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');
const crypto = require('node:crypto');

const REPO = path.resolve(__dirname, '..');
const CONFIG = JSON.parse(fs.readFileSync(path.join(__dirname, 'asset-pipeline-config.json'), 'utf8'));

// ---------- CLI ----------
const ARGV = process.argv.slice(2);
const HELP = ARGV.includes('--help') || ARGV.includes('-h');
const BATCH = ARGV.includes('--batch') || ARGV.includes('-b');
const ANALYZE = ARGV.includes('--analyze') || ARGV.includes('-a');
const DRY_RUN = ARGV.includes('--dry-run');
const OUTPUT_DIR = ARGV.includes('--output') 
    ? ARGV[ARGV.indexOf('--output') + 1] 
    : path.join(REPO, CONFIG.output.dir);
const INPUT_DIR = ARGV.find(a => !a.startsWith('--') && !fs.existsSync(path.join(REPO, a))) 
    || '.';

function log(msg) { process.stdout.write(`[pipeline] ${msg}\n`); }
function warn(msg) { process.stderr.write(`[pipeline] ${msg}\n`); }
function error(msg) { process.stderr.write(`[pipeline] ERROR: ${msg}\n`); }

// ---------- Helpers ----------

function expandHome(p) {
    if (!p) return p;
    if (p === '~') return process.env.HOME || p;
    if (p.startsWith('~/')) return path.join(process.env.HOME || '', p.slice(2));
    return p;
}

function getFiles(dir, exts) {
    if (!fs.existsSync(dir)) return [];
    
    const stat = fs.statSync(dir);
    if (stat.isFile()) {
        // Single file - check if supported
        if (exts.includes(path.extname(dir).toLowerCase())) {
            return [path.resolve(dir)];
        }
        return [];
    }
    
    // Directory - scan for files
    return fs.readdirSync(dir)
        .filter(f => exts.includes(path.extname(f).toLowerCase()))
        .map(f => path.join(dir, f));
}

// Extract dominant colors from image
function extractColors(imagePath) {
    try {
        // Use sips or convert to get colors
        const result = execFileSync('convert', [
            imagePath,
            '-resize', '100x100',
            '-colors', String(CONFIG.analysis.colorCount),
            '-format', '%c',
            'histogram:info:'
        ], { encoding: 'utf8', timeout: 10000 });
        
        // Parse colors
        const colors = [];
        const lines = result.split('\n').slice(0, CONFIG.analysis.colorCount);
        for (const line of lines) {
            const match = line.match(/\(([\d,]+)\)/);
            if (match) {
                const [r, g, b] = match[1].split(',').map(Number);
                colors.push({ r, g, b, hex: rgbToHex(r, g, b) });
            }
        }
        return colors;
    } catch (e) {
        return [{ r: 128, g: 128, b: 128, hex: '#808080' }];
    }
}

function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(x => x.toString(16).padStart(2, '0')).join('');
}

function hexToColorName(hex) {
    const colors = {
        '#000000': 'dark', '#ffffff': 'light', '#ff0000': 'red',
        '#00ff00': 'green', '#0000ff': 'blue', '#ffff00': 'yellow',
        '#ff00ff': 'magenta', '#00ffff': 'cyan', '#ff8800': 'orange',
        '#8800ff': 'purple', '#ff0088': 'pink', '#008800': 'forest',
    };
    const hex6 = hex.toLowerCase().slice(0, 7);
    return colors[hex6] || 'mixed';
}

// Detect mood from colors
function detectMood(colors) {
    if (!colors || colors.length === 0) return 'neutral';
    
    const avgBrightness = colors.reduce((sum, c) => sum + (c.r + c.g + c.b) / 3, 0) / colors.length;
    const avgSaturation = colors.reduce((sum, c) => {
        const max = Math.max(c.r, c.g, c.b);
        const min = Math.min(c.r, c.g, c.b);
        return sum + (max === 0 ? 0 : (max - min) / max);
    }, 0) / colors.length;
    
    // Bright + saturated = energetic
    // Dark + low sat = moody
    // Light + low sat = calm
    
    if (avgBrightness > 150 && avgSaturation > 0.3) return 'energetic';
    if (avgBrightness < 80 && avgSaturation < 0.3) return 'moody';
    if (avgBrightness > 150 && avgSaturation < 0.3) return 'dreamy';
    if (avgBrightness < 80 && avgSaturation > 0.3) return 'intense';
    return 'neutral';
}

// Extract keywords from filename
function extractKeywords(filepath) {
    const basename = path.basename(filepath, path.extname(filepath));
    const words = basename.toLowerCase()
        .replace(/[-_]/g, ' ')
        .replace(/\d+/g, '')
        .split(' ')
        .filter(w => w.length > 2);
    
    // Known keywords mapping
    const known = {
        'neon': 'neon', 'pulse': 'neon', 'glow': 'neon',
        'smoke': 'smoke', 'fog': 'smoke', 'mist': 'smoke',
        'dream': 'dreamy', 'night': 'dark', 'dark': 'dark',
        'light': 'light', 'sun': 'warm', 'warm': 'warm',
        'cold': 'cold', 'blue': 'cold', 'red': 'warm',
        'green': 'nature', 'nature': 'nature', 'abstract': 'abstract',
        'geometric': 'geometric', 'type': 'typography', 'text': 'typography',
    };
    
    const keywords = new Set();
    for (const word of words) {
        if (known[word]) keywords.add(known[word]);
        else keywords.add(word);
    }
    
    return Array.from(keywords).slice(0, 5);
}

// Generate hashtags
function generateHashtags(keywords, mood, colors) {
    const base = ['#AIArt', '#DigitalArt', '#Generative'];
    const moodTags = {
        energetic: ['#Energetic', '#Vibes', '#Motion'],
        dreamy: ['#Dreamy', '#Ethereal', '#Soft'],
        moody: ['#Dark', '#Moody', '#Atmospheric'],
        intense: ['#Intense', '#Bold', '#Strong'],
        neutral: ['#Abstract', '#Digital'],
    };
    
    const colorTags = colors.slice(0, 2).map(c => '#' + hexToColorName(c.hex).replace(/^./, c => c.toUpperCase()));
    
    const keywordTags = keywords.slice(0, 3).map(k => '#' + k);
    
    const all = [...base, ...(moodTags[mood] || moodTags.neutral), ...colorTags, ...keywordTags];
    return [...new Set(all)].slice(0, CONFIG.metadata.hashtagCount);
}

// Generate description
function generateDescription(keywords, mood, filename) {
    const template = CONFIG.metadata.descriptionTemplate;
    const genre = keywords.find(k => ['neon', 'smoke', 'dreamy', 'geometric', 'abstract', 'typography'].includes(k)) || 'art';
    return template
        .replace('{mood}', mood)
        .replace('{genre}', genre)
        .replace('{filename}', path.basename(filename, path.extname(filename)));
}

// Generate output filename
function generateFilename(family, index, mood, colors, originalName) {
    const colorSlug = colors.slice(0, 2).map(c => hexToColorName(c.hex)).join('-');
    const pattern = CONFIG.naming.pattern;
    return pattern
        .replace('{family}', family)
        .replace('{index:02d}', String(index).padStart(2, '0'))
        .replace('{mood}', mood)
        .replace('{colorslug}', colorSlug)
        .replace('{original}', path.basename(originalName, path.extname(originalName)));
}

// Convert image to MP4 - scale to vertical 9:16
function convertToMp4(inputPath, outputPath, duration = CONFIG.input.defaultDuration) {
    const ext = path.extname(inputPath).toLowerCase();
    const [width, height] = CONFIG.input.defaultResolution.split('x');
    
    // Common args
    const args = [
        '-loop', '1',
        '-i', inputPath,
        '-vf', `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
        '-c:v', 'libx264',
        '-t', String(duration),
        '-r', String(CONFIG.input.defaultFps),
        '-movflags', '+faststart',
        '-preset', 'fast',
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-y', outputPath
    ];
    
    if (ext === '.gif') {
        args[0] = '-i'; // no -loop for gif
        args.splice(2, 1); // remove -loop
    }
    
    execFileSync('ffmpeg', args, { stdio: 'inherit' });
}

// Process single file
async function processFile(inputPath, outputDir, family, index) {
    const basename = path.basename(inputPath);
    log(`Processing: ${basename}`);
    
    // Analysis
    const colors = ANALYZE ? extractColors(inputPath) : [{ hex: '#808080' }];
    const mood = ANALYZE ? detectMood(colors) : 'neutral';
    const keywords = ANALYZE ? extractKeywords(inputPath) : ['art'];
    const hashtags = ANALYZE ? generateHashtags(keywords, mood, colors) : [];
    const description = ANALYZE ? generateDescription(keywords, mood, basename) : '';
    
    // Generate output name
    const outputName = generateFilename(family, index, mood, colors, basename);
    const outputMp4 = path.join(outputDir, outputName + '.mp4');
    const outputMeta = path.join(outputDir, outputName + '.json');
    
    if (DRY_RUN) {
        log(`  [dry-run] Would create: ${outputName}.mp4`);
        log(`  [dry-run] Mood: ${mood}, Keywords: ${keywords.join(', ')}`);
        log(`  [dry-run] Hashtags: ${hashtags.slice(0, 3).join(' ')}...`);
        return { dryRun: true, outputName, mood, keywords, hashtags };
    }
    
    // Convert
    try {
        convertToMp4(inputPath, outputMp4);
        log(`  → ${path.basename(outputMp4)}`);
    } catch (e) {
        error(`Conversion failed: ${e.message}`);
        return { ok: false, error: e.message };
    }
    
    // Write metadata
    const metadata = {
        source: basename,
        output: path.basename(outputMp4),
        family,
        mood,
        keywords,
        colors: colors.map(c => c.hex),
        hashtags,
        description,
        createdAt: new Date().toISOString(),
        duration: CONFIG.input.defaultDuration,
        resolution: CONFIG.input.defaultResolution,
    };
    
    fs.writeFileSync(outputMeta, JSON.stringify(metadata, null, 2));
    log(`  → ${path.basename(outputMeta)}`);
    
    return { ok: true, ...metadata };
}

// Main
async function main() {
    if (HELP) {
        console.log(`
Asset Pipeline - Convert images to viral-ready MP4s

Usage:
  node lib/asset-pipeline.js <input-dir> [options]
  node lib/asset-pipeline.js --help

Options:
  --output, -o <dir>    Output directory (default: export-ready/)
  --batch, -b          Batch mode - process all files
  --analyze, -a        Analyze colors/mood/keywords
  --dry-run            Don't create files, just show what would happen
  
Examples:
  node lib/asset-pipeline.js ./assets/marketplace/covers --batch --analyze
  node lib/asset-pipeline.js ./my-images -o ./export-ready --analyze
`);
        return;
    }
    
    const inputPath = path.resolve(INPUT_DIR);
    if (!fs.existsSync(inputPath)) {
        error(`Input path not found: ${inputPath}`);
        process.exit(1);
    }
    
    // Determine family name from folder
    const family = path.basename(inputPath) || 'untitled';
    
    // Get all supported files
    const files = getFiles(inputPath, CONFIG.input.supportedFormats);
    
    if (files.length === 0) {
        error(`No supported files found in ${inputPath}`);
        error(`Supported: ${CONFIG.input.supportedFormats.join(', ')}`);
        process.exit(1);
    }
    
    log(`Found ${files.length} files in ${inputPath}`);
    log(`Output directory: ${OUTPUT_DIR}`);
    log(`Family: ${family}`);
    log(`Analyze: ${ANALYZE}`);
    log(`---`);
    
    // Create output directory
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }
    
    // Process files
    const results = [];
    for (let i = 0; i < files.length; i++) {
        const result = await processFile(files[i], OUTPUT_DIR, family, i + 1);
        results.push(result);
    }
    
    // Summary
    const success = results.filter(r => r.ok).length;
    log(`---`);
    log(`Processed: ${success}/${files.length} files`);
    
    if (ANALYZE && success > 0) {
        // Aggregate stats
        const moods = {};
        const allKeywords = {};
        for (const r of results) {
            if (r.ok && r.mood) moods[r.mood] = (moods[r.mood] || 0) + 1;
            if (r.ok && r.keywords) {
                for (const k of r.keywords) allKeywords[k] = (allKeywords[k] || 0) + 1;
            }
        }
        
        log(`Moods: ${JSON.stringify(moods)}`);
        log(`Top keywords: ${Object.entries(allKeywords).sort((a, b) => b[1] - a[1]).slice(0, 5).map(x => x[0]).join(', ')}`);
    }
    
    // Create README in output
    const readme = `# ${family} - Export Ready

Generated by Asset Pipeline on ${new Date().toISOString()}

## Files
${results.filter(r => r.ok).map(r => `- ${r.output}`).join('\n')}

## Usage
- Upload each MP4 to Instagram Reels / YouTube Shorts / TikTok
- Copy hashtags from each .json file
- Use the description template from .json files

## Hashtag Tips
- Use all 10 hashtags per post
- Mix popular (#AIArt) with specific (#${family})
- Include mood tags for discoverability
`;
    
    fs.writeFileSync(path.join(OUTPUT_DIR, 'README.md'), readme);
    log(`→ README.md`);
}

main().catch(e => {
    error(e.message);
    process.exit(1);
});
