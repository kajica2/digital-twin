// Draw Things Script: Viral Thumbnail Generator
// Version: 1.0
// Description: Generate viral thumbnails based on tags/metadata

// API Version - do not change
const API_VERSION = "1.0";

// Get configuration from user
const config = requestFromUser(
    "Viral Thumbnail Generator",
    "Generate",
    function() {
        return [
            this.section("Content", "Thumbnail settings", [
                this.textField("", "Prompt for thumbnail generation", true, 120),
                this.segmented(0, ["9:16", "1:1", "16:9"]),
                this.slider(0.7, this.slider.percent, 0.1, 1.0, "Strength"),
            ]),
            this.section("Style", "Visual style", [
                this.segmented(0, ["Bold", "Minimal", "Typography", "Photo"]),
                this.slider(30, this.slider.percent, 0, 100, "Contrast"),
            ]),
            this.imageField("Reference image (optional)"),
        ];
    }
);

// Extract values
const prompt = config[0].value;
const aspectRatio = config[1].value; // 0=9:16, 1=1:1, 2=16:9
const strength = config[2].value;
const style = config[3].value;
const contrast = config[4].value;
const refImage = config[5].value;

// Set dimensions based on aspect ratio
let width, height;
if (aspectRatio === 0) { // 9:16
    width = 768;
    height = 1344;
} else if (aspectRatio === 1) { // 1:1
    width = 1024;
    height = 1024;
} else { // 16:9
    width = 1344;
    height = 768;
}

// Build enhanced prompt
let enhancedPrompt = prompt;

// Add style modifiers
const styleModifiers = {
    "Bold": "bold colors, high contrast, dramatic lighting, ",
    "Minimal": "minimalist, clean, whitespace, simple, ",
    "Typography": "typography focused, large text, bold letters, ",
    "Photo": "photorealistic, detailed, professional photography, "
};

enhancedPrompt = styleModifiers[style] + enhancedPrompt;

// Add contrast
if (contrast > 60) {
    enhancedPrompt += ", high contrast, dramatic shadows";
} else if (contrast < 30) {
    enhancedPrompt += ", soft lighting, low contrast, dreamy";
}

// Add quality tags
enhancedPrompt += ", high quality, 4k, detailed, viral thumbnail, social media";

// Set up the pipeline
pipeline.configuration = {
    model: "flux-dev", // or your preferred model
    width: width,
    height: height,
    steps: 25,
    guidance: strength * 10,
    seed: Math.floor(Math.random() * 1000000),
};

// Set prompts
pipeline.prompts = [
    { text: enhancedPrompt, weight: 1.0 },
    { text: "blurry, low quality, watermark, text", weight: -1.0 }
];

// Use reference image if provided
if (refImage && refImage.length > 0) {
    canvas.loadImage(refImage[0]);
    // Apply as style reference
    pipeline.configuration.imagePrompt = refImage[0];
}

// Run generation
const result = await pipeline.run({
    count: 4, // Generate 4 variants
});

// Save results
const outputDir = filesystem.pictures.path + "/ViralThumbnails/";
const timestamp = Date.now();

for (let i = 0; i < result.images.length; i++) {
    const filename = outputDir + "thumbnail_" + timestamp + "_" + (i+1) + ".png";
    canvas.saveImage(filename);
}

// Clear canvas for next run
canvas.clear();

// Show completion
console.log("Generated " + result.images.length + " thumbnails in " + outputDir);
