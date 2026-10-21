#!/usr/bin/env node
/**
 * SR Monogram Color Animator
 * Generates frame-by-frame SVG color transitions for video exports
 * 
 * Usage:
 *   node sr-color-animator.js                    # Generate all color frames
 *   node sr-color-animator.js --preview          # Show color progression
 *   node sr-color-animator.js --ffmpeg           # Generate video directly
 *   node sr-color-animator.js --sequence 10     # 10 second sequence
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const COLORS = [
    { name: 'light-purple', hex: '#f5e9ff', rgb: [245, 233, 255] },
    { name: 'muted-purple', hex: '#8a7aa0', rgb: [138, 122, 160] },
    { name: 'dark-purple', hex: '#2a1d3e', rgb: [42, 29, 62] },
    { name: 'pink', hex: '#FFB3BA', rgb: [255, 179, 186] },
    { name: 'mint-green', hex: '#B3FFD9', rgb: [179, 255, 217] },
    { name: 'lavender', hex: '#D4B3FF', rgb: [212, 179, 255] },
    { name: 'light-blue', hex: '#BAE1FF', rgb: [186, 225, 255] },
];

const STROKE_WIDTH = 10; // 1px at 0.1 scale
const OUTPUT_DIR = path.join(__dirname, 'youtube-inbox/uploaded/sr-color-frames');

// SVG path data (extracted from watermark-monogram.svg)
const PATH_DATA = `M2350 8758 c-198 -8 -256 -18 -377 -63 -181 -68 -287 -136 -419 -271
-200 -202 -305 -405 -370 -714 l-29 -135 0 -2325 0 -2325 28 -140 c32 -165 55
-238 110 -360 89 -197 215 -347 417 -497 89 -66 152 -99 265 -138 128 -46 214
-60 425 -71 299 -15 4829 -6 4940 10 201 29 391 117 565 262 104 85 171 160
238 262 143 218 214 416 236 657 15 155 15 4566 1 4711 -6 57 -17 124 -25 149
-7 25 -19 68 -25 95 -6 28 -19 68 -30 90 -10 22 -27 60 -39 85 -53 115 -177
296 -256 374 -195 191 -437 309 -695 337 -88 9 -662 12 -2460 13 -1290 1
-2415 -2 -2500 -6z m4827 -1933 c12 -9 27 -32 33 -53 13 -47 13 -536 0 -1104
-11 -467 -13 -488 -67 -509 -19 -8 -142 -10 -391 -7 -333 4 -366 3 -385 -13
l-21 -17 28 -40 c15 -22 35 -54 44 -71 10 -17 82 -124 162 -237 111 -158 153
-210 177 -220 24 -10 85 -14 226 -14 175 0 196 -2 210 -18 14 -16 18 -53 22
-246 l5 -227 -25 -25 -25 -25 -323 3 c-252 2 -326 6 -343 17 -24 16 -49 50
-271 381 -42 63 -98 142 -123 175 -26 33 -108 152 -182 265 -75 113 -164 241
-198 285 -134 174 -173 229 -207 293 -21 37 -55 91 -77 121 -76 100 -86 115
-86 133 0 9 9 22 19 28 13 6 203 10 549 10 571 0 582 1 662 54 27 18 48 45 72
93 30 61 33 76 33 153 -1 108 -25 180 -80 235 -33 34 -55 45 -124 64 l-84 23
-1629 -2 c-1068 0 -1648 -4 -1686 -11 -88 -16 -132 -42 -180 -109 -65 -89 -78
-137 -64 -232 6 -42 20 -94 31 -115 27 -53 87 -108 146 -135 l50 -23 525 -1
c362 -1 533 -4 552 -12 15 -6 43 -33 63 -59 70 -94 131 -179 198 -278 37 -55
79 -112 93 -126 13 -14 47 -61 74 -104 47 -75 78 -111 154 -184 21 -19 41 -51
48 -75 7 -27 11 -162 12 -396 1 -338 0 -357 -19 -389 -11 -19 -38 -43 -60 -55
-40 -21 -44 -21 -1180 -24 -840 -2 -1147 0 -1167 9 -18 7 -31 22 -37 43 -13
49 -1 452 15 474 12 16 71 17 911 22 861 5 899 6 926 24 91 61 70 172 -62 336
-33 41 -61 78 -61 82 0 13 -139 108 -193 134 l-56 25 -684 2 c-764 2 -717 -2
-756 75 -39 77 -41 120 -41 843 0 746 0 750 47 762 10 3 1089 5 2398 6 2122 1
2383 -1 2402 -14z m-2347 -858 c25 -13 37 -27 153 -195 40 -57 100 -143 134
-190 34 -48 84 -121 110 -162 49 -78 141 -206 215 -299 45 -57 154 -213 251
-359 60 -90 94 -140 174 -254 27 -37 77 -111 113 -163 36 -53 95 -137 132
-187 121 -163 127 -158 -199 -158 -191 0 -262 3 -286 14 -23 9 -52 42 -102
117 -38 57 -104 148 -145 202 -89 117 -110 147 -213 301 -43 64 -88 128 -101
143 -13 16 -57 78 -98 138 -128 189 -310 449 -328 470 -10 11 -67 92 -126 180
-59 88 -140 204 -181 258 -73 99 -83 123 -61 145 17 17 523 17 558 -1z`;

function rgbToHex(r, g, b) {
    return '#' + [r, g, b].map(x => {
        const hex = Math.round(x).toString(16);
        return hex.length === 1 ? '0' + hex : hex;
    }).join('');
}

function interpolateColor(color1, color2, t) {
    return [
        color1[0] + (color2[0] - color1[0]) * t,
        color1[1] + (color2[1] - color1[1]) * t,
        color1[2] + (color2[2] - color1[2]) * t,
    ];
}

function generateSVGFrame(rgb, frameNum) {
    const hex = rgbToHex(...rgb);
    return `<?xml version="1.0" encoding="UTF-8"?>
<svg version="1.0" xmlns="http://www.w3.org/2000/svg"
 width="170" height="171" viewBox="0 0 1018 1024">
<g transform="translate(0,1024) scale(0.1,-0.1)"
 fill="none"
 stroke="${hex}"
 stroke-width="${STROKE_WIDTH}"
 stroke-linecap="round"
 stroke-linejoin="round">
<path d="${PATH_DATA}"/>
</g>
</svg>`;
}

function generateSequence(durationSeconds = 10, fps = 30) {
    const totalFrames = durationSeconds * fps;
    const framesPerColor = Math.floor(totalFrames / (COLORS.length - 1));
    
    console.log(`\n🎨 SR Monogram Color Sequence Generator`);
    console.log(`======================================`);
    console.log(`Duration: ${durationSeconds}s`);
    console.log(`FPS: ${fps}`);
    console.log(`Total frames: ${totalFrames}`);
    console.log(`Frames per color: ${framesPerColor}`);
    console.log(`\n📊 Color Progression:\n`);
    
    // Create output directory
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }
    
    const sequence = [];
    
    for (let i = 0; i < totalFrames; i++) {
        const colorIndex = Math.min(Math.floor(i / framesPerColor), COLORS.length - 2);
        const t = (i % framesPerColor) / framesPerColor;
        
        const color1 = COLORS[colorIndex].rgb;
        const color2 = COLORS[colorIndex + 1].rgb;
        const currentRgb = interpolateColor(color1, color2, t);
        const currentHex = rgbToHex(...currentRgb);
        
        // Generate frame
        const frameSvg = generateSVGFrame(currentRgb, i);
        const frameFile = path.join(OUTPUT_DIR, `frame-${String(i).padStart(4, '0')}.svg`);
        fs.writeFileSync(frameFile, frameSvg);
        
        // Print first few frames as preview
        if (i < COLORS.length) {
            console.log(`  Frame ${i}: ${currentHex} (${COLORS[colorIndex].name} → ${COLORS[colorIndex + 1].name})`);
        } else if (i === COLORS.length) {
            console.log(`  ...`);
        } else if (i >= totalFrames - 3) {
            console.log(`  Frame ${i}: ${currentHex} (${COLORS[COLORS.length - 1].name})`);
        }
        
        sequence.push({ frame: i, hex: currentHex, rgb: currentRgb });
    }
    
    // Save sequence metadata
    fs.writeFileSync(
        path.join(OUTPUT_DIR, 'sequence-meta.json'),
        JSON.stringify({ durationSeconds, fps, totalFrames, colors: COLORS, sequence }, null, 2)
    );
    
    console.log(`\n✅ Generated ${totalFrames} SVG frames in:`);
    console.log(`   ${OUTPUT_DIR}/`);
    
    return { totalFrames, framesPerColor, durationSeconds };
}

function showPreview() {
    console.log(`\n🎨 Color Palette Preview\n`);
    console.log(`Recommended sequences:\n`);
    
    console.log(`1. 🌸 DREAMY (soft → bright)`);
    console.log(`   #f5e9ff → #D4B3FF → #FFB3BA → #f5e9ff`);
    console.log(`   Duration: 8-12s - gentle, ethereal transitions\n`);
    
    console.log(`2. 🌿 FRESH (calm → energetic)`);
    console.log(`   #B3FFD9 → #BAE1FF → #f5e9ff → #B3FFD9`);
    console.log(`   Duration: 6-10s - uplifting, nature-inspired\n`);
    
    console.log(`3. 🌙 MYSTICAL (dark → light → dark)`);
    console.log(`   #2a1d3e → #8a7aa0 → #D4B3FF → #f5e9ff → #D4B3FF → #2a1d3e`);
    console.log(`   Duration: 15-20s - dramatic, moody\n`);
    
    console.log(`4. ⚡ ENERGY (high contrast)`);
    console.log(`   #FFB3BA → #B3FFD9 → #BAE1FF → #D4B3FF → #FFB3BA`);
    console.log(`   Duration: 5-8s - vibrant, fast-paced\n`);
    
    console.log(`5. 🎬 DEFAULT (full cycle)`);
    console.log(`   ${COLORS.map(c => c.hex).join(' → ')} → ${COLORS[0].hex}`);
    console.log(`   Duration: 10-15s - showcases all colors\n`);
    
    console.log(`\n📋 All Colors:`);
    COLORS.forEach((c, i) => {
        console.log(`   ${i + 1}. ■ ${c.hex} - ${c.name}`);
    });
}

function generateVideo(args) {
    const duration = args.includes('--sequence') 
        ? parseInt(args[args.indexOf('--sequence') + 1]) || 10 
        : 10;
    
    console.log(`\n🎬 Generating video with ffmpeg...`);
    
    // First generate frames
    const { totalFrames } = generateSequence(duration, 30);
    
    // Generate palette for high quality
    const paletteFile = path.join(OUTPUT_DIR, 'palette.png');
    
    console.log(`\nGenerating palette...`);
    try {
        execSync(`ffmpeg -y -framerate 30 -i "${OUTPUT_DIR}/frame-%04d.svg" -vf "palettegen=stats_mode=diff" ${paletteFile}`, {
            stdio: 'inherit'
        });
        
        console.log(`Encoding video...`);
        const outputFile = path.join(OUTPUT_DIR, `sr-color-${duration}s.mp4`);
        execSync(`ffmpeg -y -framerate 30 -i "${OUTPUT_DIR}/frame-%04d.svg" -i ${paletteFile} -lavfi "paletteuse=dither=bayer:bayer_scale=5:diff_threshold=0.1" -c:v libx264 -pix_fmt yuv420p -crf 18 ${outputFile}`, {
            stdio: 'inherit'
        });
        
        console.log(`\n✅ Video saved: ${outputFile}`);
    } catch (e) {
        console.log(`⚠️ ffmpeg not available. Frames generated, use manual ffmpeg command:`);
        console.log(`   ffmpeg -framerate 30 -i "${OUTPUT_DIR}/frame-%04d.svg" output.mp4`);
    }
}

// CLI
const args = process.argv.slice(2);
if (args.includes('--preview') || args.includes('-p')) {
    showPreview();
} else if (args.includes('--ffmpeg') || args.includes('-f')) {
    generateVideo(args);
} else if (args.includes('--help') || args.includes('-h')) {
    console.log(`
SR Monogram Color Animator

Usage:
  node sr-color-animator.js              Generate full color sequence (10s)
  node sr-color-animator.js --preview    Show color recommendations
  node sr-color-animator.js --ffmpeg     Generate SVG frames + MP4 video
  node sr-color-animator.js --sequence N Generate N second sequence
  
Output: youtube-inbox/uploaded/sr-color-frames/
`);
} else {
    generateSequence(10, 30);
    showPreview();
}
