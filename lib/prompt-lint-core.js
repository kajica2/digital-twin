// lib/prompt-lint-core.js
//
// The prompt lint RULE — shared by the Node linter and the browser
// console.
//
// WHY THIS IS A SEPARATE FILE.
//
// The rule is the user's own (2026-10-22): a prompt must not name the
// subject's race or ethnicity, because these prompts are written so a
// REFERENCE PHOTO can be attached — and a demographic adjective
// overrides the photo. The model renders whoever the prompt named,
// whatever the reference actually contains.
//
// The linter (`lib/prompt-lint.js`) enforces it on the repo's packs, and
// CI runs `npm run prompt:check` on every push. The console enforces it
// on what the user types, BEFORE the prompt is saved.
//
// If the console had its own copy of the rule, the two could drift —
// and the console is exactly where a stray "a Black man" would be typed
// by hand, one keystroke away from a pack the CI linter then fails on.
// So the console loads THIS FILE: the same rule, the same term lists,
// the same exceptions.
//
// It is a classic script (no modules, no bundler), the same shape as
// lib/theme.js and lib/skin.js:
//
//   <script src="../lib/prompt-lint-core.js"></script>
//   <script>
//     window.PromptLint.findViolations('a Black man in a red coat');
//   </script>
//
// In Node it is `require('./prompt-lint-core.js')`.

(function () {
    'use strict';

    // ------------------------------------------------------------------
    // The term lists
    //
    // RACE_TERMS are the adjectives that carry a demographic claim. They
    // are only a finding when they modify a PERSON noun — "black and
    // white" and "a black coat" must not trip the lint.
    //
    // Multi-word terms are matched with a flexible separator so
    // "African-American", "african american" and "African American" all
    // hit, and so the two-word form wins over a bare "african".
    // ------------------------------------------------------------------
    const RACE_TERMS = [
        'african american', 'african-american', 'native american', 'native-american',
        'first nations', 'first-nations', 'mixed race', 'mixed-race',
        'mixed ethnicity', 'east asian', 'east-asian', 'south asian', 'south-asian',
        'middle eastern', 'middle-eastern', 'african descent', 'asian descent',
        'arab descent', 'black', 'white', 'african', 'asian', 'arab', 'arabic',
        'hispanic', 'latino', 'latina', 'latinx', 'cuban', 'puerto rican',
        'dominican', 'mexican', 'colombian', 'peruvian', 'argentine', 'venezuelan',
        'indian', 'pakistani', 'bangladeshi', 'sri lankan', 'nepali',
        'chinese', 'taiwanese', 'japanese', 'korean', 'vietnamese', 'filipino',
        'indonesian', 'thai', 'cambodian', 'burmese',
        'nigerian', 'ethiopian', 'somali', 'kenyan', 'ghanaian', 'sudanese',
        'south african', 'zimbabwean', 'zambian',
        'moroccan', 'algerian', 'tunisian', 'egyptian', 'libyan',
        'turkish', 'iranian', 'iraqi', 'syrian', 'lebanese', 'levantine', 'greek',
        'caucasian', 'european', 'slavic', 'balkan', 'nordic', 'scandinavian',
        'mediterranean', 'roma', 'romani',
        'indigenous', 'aboriginal', 'aborigine', 'inuit', 'sami',
        'biracial', 'mixed-race',
    ];

    // PERSON_NOUNS are the nouns that make a demographic adjective a
    // claim about a person rather than about a colour, a garment or a
    // scene.
    const PERSON_NOUNS = [
        'man', 'men', 'woman', 'women', 'person', 'people', 'boy', 'boys',
        'girl', 'girls', 'kid', 'kids', 'child', 'children', 'adult', 'adults',
        'musician', 'musicians', 'artist', 'artists',
        'saxophonist', 'saxophonists', 'trumpeter', 'trumpeters',
        'player', 'players', 'drummer', 'drummers', 'singer', 'singers',
        'model', 'models', 'guy', 'guys', 'lady', 'ladies',
        'elder', 'elders', 'elderly', 'worker', 'workers',
        'pedestrian', 'pedestrians', 'passerby', 'passersby',
        'crowd', 'crowds', 'audience', 'teen', 'teens', 'teenager', 'teenagers',
        'student', 'students', 'performer', 'performers', 'dancer', 'dancers',
        // roles the corpus actually uses — a musician pack is full of these
        'pianist', 'pianists', 'guitarist', 'guitarists', 'bassist', 'bassists',
        'keyboardist', 'keyboardists', 'violinist', 'violinists', 'cellist',
        'composer', 'composers', 'conductor', 'bandleader', 'bandleaders',
        'actor', 'actress', 'photographer', 'photographers', 'chef', 'chefs',
        'doctor', 'doctors', 'nurse', 'nurses', 'teacher', 'teachers', 'professor',
        'officer', 'officers', 'soldier', 'soldiers', 'couple', 'family',
        'friend', 'friends', 'guest', 'guests', 'shopper', 'shoppers',
        'customer', 'customers', 'subject', 'subjects',
        // hospitality + trade — the other roles the corpus reaches for
        'barista', 'shopkeeper', 'vendor', 'waiter', 'waitress', 'cashier',
        'clerk', 'driver', 'pilot', 'sailor', 'farmer', 'fisherman', 'miner',
        'priest', 'monk', 'nun', 'judge', 'lawyer', 'scientist', 'engineer',
        'architect', 'journalist', 'editor', 'writer', 'poet', 'painter',
        'ballerina', 'acrobat', 'clown', 'juggler', 'boxer', 'swimmer',
        'runner', 'cyclist', 'skater', 'surfer', 'climber', 'golfer',
    ];

    // "a person of colour" — a demographic claim with a different shape.
    const OF_COLOR_RE = /\b(?:people|persons?|men|women|someone|somebody|human|humans)\s+of\s+colou?r\b/gi;

    // "of African descent" — the noun follows the descriptor.
    const DESCENT_RE = /\bof\s+(?:african|asian|arab|european|latino|latina|hispanic|middle\s+eastern)\s+descent\b/gi;

    function escapeRe(s) {
        return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    // A descriptor may be two words joined by a space or a hyphen.
    function termToPattern(term) {
        const parts = term.split(/[\s-]+/);
        return parts.map(escapeRe).join('[\\s-]+');
    }

    const RACE_ALT = RACE_TERMS.map(termToPattern).join('|');
    const NOUN_ALT = PERSON_NOUNS.map(escapeRe).join('|');

    // The descriptor must directly modify the person noun: one or two
    // intervening words ("a young Black man") still count, but a clause
    // in between does not.
    const PERSON_RE = new RegExp(
        `\\b(${RACE_ALT})\\s+(?:\\w+\\s+){0,2}?(${NOUN_ALT})\\b`,
        'gi'
    );

    // ------------------------------------------------------------------
    // findViolations(promptText) -> [{ term, noun, match }]
    // ------------------------------------------------------------------
    function findViolations(promptText) {
        const out = [];
        if (typeof promptText !== 'string' || !promptText) return out;
        const seen = new Set();
        for (const re of [PERSON_RE, OF_COLOR_RE, DESCENT_RE]) {
            re.lastIndex = 0;
            let m;
            while ((m = re.exec(promptText)) !== null) {
                const match = m[0].replace(/\s+/g, ' ').trim();

                // "black and white" is a photographic TREATMENT, never a
                // claim about a person: "a framed black-and-white portrait",
                // "a black-and-white photo of a man". Neither word in
                // the compound may act as a descriptor.
                if (/^black[\s-]+and[\s-]+white\b/i.test(match)) continue;
                if (/^white\b/i.test(match)) {
                    const before = promptText.slice(Math.max(0, m.index - 24), m.index);
                    if (/black[\s-]+and[\s-]+$/i.test(before)) continue;
                }

                const key = match.toLowerCase();
                if (seen.has(key)) continue;
                seen.add(key);
                out.push({
                    term: (m[1] || match).toLowerCase(),
                    noun: m[2] ? m[2].toLowerCase() : null,
                    match,
                });
                if (m.index === re.lastIndex) re.lastIndex++; // zero-width guard
            }
        }
        return out;
    }

    const api = { findViolations, RACE_TERMS, PERSON_NOUNS };

    // CommonJS (Node, tests) — the file must not touch browser APIs here.
    if (typeof module === 'object' && module && typeof module.exports === 'object') {
        module.exports = api;
        return;
    }

    if (typeof window !== 'undefined' && window) {
        window.PromptLint = api;
    }
})();
