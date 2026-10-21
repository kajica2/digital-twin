#!/usr/bin/env node
/**
 * DrawThings Loop Generator - Automated Pipeline
 * Generates 2-second loop prompts for all studio portraits
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STUDIO_DIR = path.join(__dirname, '../data/flux/stills');
const OUTPUT_DIR = path.join(__dirname, '../data/flux/drawthings');
const PROMPTS_FILE = path.join(OUTPUT_DIR, 'all-prompts.md');

// Ensure output dir
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Get all studio portraits
const files = fs.readdirSync(STUDIO_DIR).filter(f => 
  (f.startsWith('studio-') || f.includes('portrait')) && (f.endsWith('.png') || f.endsWith('.jpg'))
);

// Motion templates for different poses
const MOTION_TEMPLATES = {
  standing: {
    prompt: `SUBJECT, standing pose, SUBJECT_BACKGROUND, SUBJECT_LIGHTING, subtle breathing motion, slight hair movement, 2 second seamless loop, SUBJECT_STYLE`,
    motion: "subtle breathing, gentle hair sway"
  },
  seated: {
    prompt: `SUBJECT, seated on SUBJECT_PROP, relaxed posture, SUBJECT_BACKGROUND, SUBJECT_LIGHTING, subtle chest rise and fall, gentle eye blink, 2 second seamless loop, SUBJECT_STYLE`,
    motion: "breathing, occasional blink"
  },
  full_length: {
    prompt: `SUBJECT, full length standing, SUBJECT_POSE2, SUBJECT_BACKGROUND, SUBJECT_LIGHTING, subtle weight shift, slight shoulder movement, 2 second seamless loop, SUBJECT_STYLE`,
    motion: "weight shift, shoulder movement"
  },
  closeup: {
    prompt: `SUBJECT, close-up portrait, shoulders visible, SUBJECT_EXPRESSION, SUBJECT_BACKGROUND, SUBJECT_LIGHTING, subtle lip movement, gentle eye flutter, 2 second seamless loop, SUBJECT_STYLE`,
    motion: "subtle expression, eye flutter"
  },
  leaning: {
    prompt: `SUBJECT, leaning against SUBJECT_PROP, SUBJECT_POSE2, SUBJECT_BACKGROUND, SUBJECT_LIGHTING, arm rise and fall, slight head turn, 2 second seamless loop, SUBJECT_STYLE`,
    motion: "arm movement, subtle head turn"
  },
  reference: {
    prompt: `SUBJECT, SUBJECT_POSE, SUBJECT_BACKGROUND, SUBJECT_LIGHTING, subtle SUBJECT_MOTION, 2 second seamless loop, SUBJECT_STYLE`,
    motion: "subtle motion, gentle movement"
  }
};

// Style configurations
const STYLES = {
  studio_portrait_01: {
    subject: "professional male model in studio, sharp cheekbones, short dark hair",
    background: "white cyc background",
    lighting: "soft boxes lighting",
    style: "cinematic, Hasselblad medium format",
    template: "standing"
  },
  studio_portrait_02: {
    subject: "professional male model, relaxed posture",
    background: "dark gray seamless backdrop",
    lighting: "overhead strip light",
    style: "film grain",
    template: "seated",
    prop: "wooden stool"
  },
  studio_portrait_03: {
    subject: "professional male model, athletic stance",
    background: "concrete floor cyclorama",
    lighting: "large soft key light from left",
    style: "fashion photography",
    template: "full_length"
  },
  studio_portrait_04: {
    subject: "professional male model, contemplative expression",
    background: "charcoal gradient backdrop",
    lighting: "Rembrandt lighting",
    style: "8k, retouched",
    template: "closeup"
  },
  studio_portrait_05: {
    subject: "professional male model, casual confident pose",
    background: "textured gray wall backdrop",
    lighting: "window light simulation",
    style: "retouched, professional",
    template: "leaning",
    prop: "wall"
  },
  portrait_reference: {
    subject: "professional male model, short dark hair, sharp features",
    background: "studio backdrop",
    lighting: "professional studio lighting",
    style: "high-end fashion photography, 8k",
    template: "reference",
    pose: "confident stance",
    motion: "breathing, gentle movement"
  }
};

function generatePrompt(config, template) {
  let prompt = MOTION_TEMPLATES[template].prompt;
  
  prompt = prompt.replace('SUBJECT', config.subject);
  prompt = prompt.replace('SUBJECT_BACKGROUND', config.background);
  prompt = prompt.replace('SUBJECT_LIGHTING', config.lighting);
  prompt = prompt.replace('SUBJECT_STYLE', config.style);
  prompt = prompt.replace('SUBJECT_PROP', config.prop || 'surface');
  prompt = prompt.replace('SUBJECT_POSE', config.pose || 'pose');
  prompt = prompt.replace('SUBJECT_POSE2', config.pose2 || 'athletic stance');
  prompt = prompt.replace('SUBJECT_EXPRESSION', config.expression || 'contemplative expression');
  prompt = prompt.replace('SUBJECT_MOTION', config.motion || 'breathing');
  
  return prompt;
}

// Generate prompts for all images
console.log('═══ DrawThings Pipeline ═══\n');
console.log(`Found ${files.length} studio portraits\n`);

let allPrompts = '# DrawThings 2-Second Loop Prompts\n';
allPrompts += `Generated: ${new Date().toISOString()}\n\n`;

let generated = 0;

for (const file of files) {
  // Match file to config
  let configKey = 'portrait_reference';
  
  if (file.includes('studio-portrait-01')) configKey = 'studio_portrait_01';
  else if (file.includes('studio-portrait-02')) configKey = 'studio_portrait_02';
  else if (file.includes('studio-portrait-03')) configKey = 'studio_portrait_03';
  else if (file.includes('studio-portrait-04')) configKey = 'studio_portrait_04';
  else if (file.includes('studio-portrait-05')) configKey = 'studio_portrait_05';
  else if (file.includes('portrait-reference')) configKey = 'portrait_reference';
  
  const config = STYLES[configKey];
  const template = config.template;
  const motion = MOTION_TEMPLATES[template].motion;
  
  const prompt = generatePrompt(config, template);
  
  // Save individual prompt file
  const baseName = file.replace(/\.(png|jpg)$/, '');
  const promptFile = path.join(OUTPUT_DIR, `${baseName}-drawthings.txt`);
  
  const content = `# DrawThings 2-Second Loop
# Input: ${file}
# Config: ${configKey}

## Main Prompt
${prompt}

## Motion
${motion}

## Settings
- Duration: 2 seconds
- Loop: Seamless/Infinite
- Seed: Auto

## How to Use
1. Open DrawThings → Animate mode
2. Load ${file} as reference
3. Paste prompt above
4. Set: 2 seconds, seamless loop
5. Generate & export
`;
  
  fs.writeFileSync(promptFile, content);
  
  // Add to all-prompts
  allPrompts += `## ${file}\n`;
  allPrompts += `**Motion:** ${motion}\n`;
  allPrompts += `**Prompt:** ${prompt}\n\n`;
  
  console.log(`✓ ${file}`);
  console.log(`  Motion: ${motion}`);
  console.log(`  File: ${promptFile}\n`);
  
  generated++;
}

// Save consolidated prompts
fs.writeFileSync(PROMPTS_FILE, allPrompts);

console.log(`\n═══ Complete ═══`);
console.log(`Generated: ${generated} prompt files`);
console.log(`Output: ${OUTPUT_DIR}`);
console.log(`Main: ${PROMPTS_FILE}`);
