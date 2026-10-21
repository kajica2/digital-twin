#!/usr/bin/env node
'use strict';
// lib/thumbnail-prompt-generator.js
//
// Generates viral thumbnail prompts from asset pipeline metadata.
// Uses tags, mood, keywords to create optimized prompts for MJ or Draw Things.
//
// Usage:
//   node lib/thumbnail-prompt-generator.js <json-file> [--output <dir>] [--drawthings]
//   node lib/thumbnail-prompt-generator.js --from-pipeline <pipeline-dir>
//
// Reads .json metadata from asset pipeline and generates thumbnail prompts.

const fs = require('node:fs');
const path = require('node:path');

const REPO = path.resolve(__dirname, '..');

// ---------- Config ----------
const THEMATIC_TEMPLATES = {
    // Viral thumbnail styles
    'bold': {
        prefix: 'Bold typography thumbnail,',
        mood_modifiers: {
            energetic: 'high energy, dynamic composition, vibrant colors,',
            dreamy: 'soft gradients, ethereal glow, pastel palette,',
            moody: 'dark cinematic, dramatic shadows, intense mood,',
            intense: 'powerful composition, strong contrast, bold visual,',
            neutral: 'balanced composition, clean design, modern aesthetic,'
        },
        suffixes: ['viral thumbnail', 'social media', 'Instagram Reel', 'YouTube Shorts', 'eye-catching']
    },
    'minimal': {
        prefix: 'Minimalist thumbnail,',
        mood_modifiers: {
            energetic: 'clean lines, movement, bold accent,',
            dreamy: 'soft, airy, peaceful, light,',
            moody: 'moody, subtle, sophisticated,',
            intense: 'striking simplicity, strong shape,',
            neutral: 'balanced negative space, modern,'
        },
        suffixes: ['clean design', 'minimalist', 'contemporary', 'sleek']
    },
    'typography': {
        prefix: 'Typography-focused thumbnail,',
        mood_modifiers: {
            energetic: 'big bold letters, dynamic layout, expressive,',
            dreamy: 'flowing script, soft letters, elegant,',
            moody: 'dramatic type, dark background, intense,',
            intense: 'impact font, powerful words, bold,',
            neutral: 'clean typography, readable, modern font,'
        },
        suffixes: ['text-based', 'word art', 'lettering', 'typographic']
    },
    'photo': {
        prefix: 'Professional photography thumbnail,',
        mood_modifiers: {
            energetic: 'action shot, dynamic pose, vibrant,',
            dreamy: 'portrait, soft light, romantic,',
            moody: 'cinematic lighting, dramatic, film grain,',
            intense: 'powerful portrait, strong gaze, intense,',
            neutral: 'professional, clean, studio lighting,'
        },
        suffixes: ['portrait', 'professional photo', 'high quality', 'editorial']
    }
};

const VIRAL_TRAITS = [
    'high contrast',
    'bold colors',
    'rule of thirds',
    'centered composition',
    'emotional',
    'intense',
    'captivating',
    'thumb-stopping',
    'scroll-halting',
    'viral-worthy'
];

// ---------- CLI ----------
const ARGV = process.argv.slice(2);
const FROM_PIPELINE = ARGV.indexOf('--from-pipeline');
const OUTPUT_FLAG = ARGV.indexOf('--output');
const DRAWTHINGS_FLAG = ARGV.includes('--drawthings');
const INPUT_FILE = ARGV.find(a => !a.startsWith('--') && fs.existsSync(a));

const OUTPUT_DIR = OUTPUT_FLAG >= 0 && ARGV[OUTPUT_FLAG + 1]
    ? ARGV[OUTPUT_FLAG + 1]
    : path.join(REPO, 'thumbnails');

function log(msg) { console.log(`[thumbnail-gen] ${msg}`); }

// ---------- Helpers ----------

function loadMetadata(jsonPath) {
    const content = fs.readFileSync(jsonPath, 'utf8');
    return JSON.parse(content);
}

function findJsonFiles(dir) {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('.json'))
        .map(f => path.join(dir, f));
}

function generatePrompt(metadata, style = 'bold') {
    const template = THEMATIC_TEMPLATES[style];
    if (!template) {
        log(`Unknown style: ${style}, using bold`);
        return generatePrompt(metadata, 'bold');
    }
    
    const mood = metadata.mood || 'neutral';
    const moodModifier = template.mood_modifiers[mood] || '';
    const keywords = metadata.keywords || [];
    
    // Build prompt
    let prompt = template.prefix + ' ';
    
    // Add mood modifier
    prompt += moodModifier + ' ';
    
    // Add keywords as visual descriptors
    if (keywords.length > 0) {
        prompt += keywords.slice(0, 3).join(', ') + ', ';
    }
    
    // Add a viral trait
    const trait = VIRAL_TRAITS[Math.floor(Math.random() * VIRAL_TRAITS.length)];
    prompt += trait + ', ';
    
    // Add suffixes
    prompt += template.suffixes[Math.floor(Math.random() * template.suffixes.length)];
    
    // Add technical specs
    prompt += ', high quality, 4k, detailed, thumbnail size';
    
    return prompt;
}

function generateDrawThingsScript(metadata, style = 'bold') {
    const prompt = generatePrompt(metadata, style);
    
    return `// Generated thumbnail prompt for Draw Things
// Source: ${metadata.source}
// Mood: ${metadata.mood}
// Keywords: ${metadata.keywords?.join(', ')}

const prompt = "${prompt.replace(/"/g, '\\"')}";
const aspectRatio = "${metadata.resolution === '1080x1920' ? '9:16' : '1:1'}";
const strength = 0.7;

// Use in Draw Things script:
// pipeline.prompts = [{ text: prompt, weight: 1.0 }];
console.log("Prompt: " + prompt);
`;
}

function generateMjPrompt(metadata, style = 'bold') {
    const prompt = generatePrompt(metadata, style);
    // Add MJ-specific optimizations
    return prompt + ' --ar 9:16 --style raw --s 250';
}

// ---------- Main ----------

async function main() {
    let metadataFiles = [];
    
    if (FROM_PIPELINE >= 0) {
        const pipelineDir = ARGV[FROM_PIPELINE + 1];
        metadataFiles = findJsonFiles(pipelineDir);
        if (metadataFiles.length === 0) {
            log(`No JSON files found in ${pipelineDir}`);
            process.exit(1);
        }
        log(`Found ${metadataFiles.length} metadata files in ${pipelineDir}`);
    } else if (INPUT_FILE) {
        metadataFiles = [path.resolve(INPUT_FILE)];
    } else {
        console.error('Usage:');
        console.error('  node thumbnail-prompt-generator.js <json-file> [--output <dir>] [--drawthings]');
        console.error('  node thumbnail-prompt-generator.js --from-pipeline <dir> [--output <dir>] [--drawthings]');
        process.exit(1);
    }
    
    // Create output directory
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }
    
    const results = [];
    
    for (const jsonPath of metadataFiles) {
        const metadata = loadMetadata(jsonPath);
        const baseName = path.basename(jsonPath, '.json');
        
        // Generate prompts for each style
        const styles = Object.keys(THEMATIC_TEMPLATES);
        
        for (const style of styles) {
            const mjPrompt = generateMjPrompt(metadata, style);
            const dtScript = generateDrawThingsScript(metadata, style);
            
            const variant = {
                source: metadata.source,
                mood: metadata.mood,
                style,
                mj_prompt: mjPrompt,
                drawthings_script: dtScript,
                hashtags: metadata.hashtags || [],
                created: new Date().toISOString()
            };
            
            // Save individual prompt
            const promptFile = path.join(OUTPUT_DIR, `${baseName}-${style}.txt`);
            fs.writeFileSync(promptFile, mjPrompt);
            
            results.push(variant);
        }
    }
    
    // Save combined results
    const combinedFile = path.join(OUTPUT_DIR, 'all-prompts.json');
    fs.writeFileSync(combinedFile, JSON.stringify(results, null, 2));
    
    // Generate batch script for MJ
    const batchFile = path.join(OUTPUT_DIR, 'batch-prompts.md');
    let batchContent = '# Batch Thumbnail Prompts\n\n';
    batchContent += 'Generated from asset pipeline\n\n';
    
    for (const r of results) {
        batchContent += `## ${r.source} (${r.style})\n\n`;
        batchContent += '```\n' + r.mj_prompt + '\n```\n\n';
    }
    
    fs.writeFileSync(batchFile, batchContent);
    
    log(`Generated ${results.length} thumbnail prompts in ${OUTPUT_DIR}`);
    log(`- ${results.length} prompt files (.txt)`);
    log(`- Combined results (.json)`);
    log(`- Batch prompts (.md)`);
}

main().catch(e => {
    console.error(`Error: ${e.message}`);
    process.exit(1);
});
