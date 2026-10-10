#!/usr/bin/env node
/**
 * Persona Engine - Digital life simulation
 * Each persona lives their own schedule, creates content, interacts
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REGISTRY_FILE = path.join(__dirname, 'registry.json');
const STATE_DIR = path.join(__dirname, 'state');

// Load registry
const REGISTRY = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
const PERSONAS = REGISTRY.personas;

class Persona {
  constructor(config) {
    this.id = config.id;
    this.name = config.name;
    this.type = config.type;
    this.role = config.role;
    this.backstory = config.backstory;
    this.voice = config.voice;
    this.schedule = config.schedule;
    this.platforms = config.platforms;
    this.goals = config.goals;
    this.relationships = config.relationships || [];
    
    this.state = this.loadState();
  }
  
  loadState() {
    const stateFile = path.join(STATE_DIR, `${this.id}.json`);
    if (fs.existsSync(stateFile)) {
      return JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    }
    return {
      lastPost: null,
      lastInteraction: null,
      contentQueue: [],
      memory: [],
      followers: 0,
      engagement: 0
    };
  }
  
  saveState() {
    const stateFile = path.join(STATE_DIR, `${this.id}.json`);
    fs.writeFileSync(stateFile, JSON.stringify(this.state, null, 2));
  }
  
  // Generate content based on schedule
  generateContent(contentType) {
    const templates = {
      'studio-update': [
        "Back in the studio. This ones feeling different.",
        "Late night studio session. The best ideas come after midnight.",
        "New track taking shape. Sometimes you just have to trust the process."
      ],
      'production-tip': [
        "Quick tip: Always print your bass to separate channel. Trust me.",
        "Been thinking about signal chain today. What matters and what does not.",
        "Production hack: Use reference tracks. Do not be precious."
      ],
      'new-release': [
        "New track is finally done. Will share soon.",
        "This one took longer than expected but it is ready.",
        "Fresh out the oven. Link in bio."
      ],
      'vinyl-hunt': [
        "Found this at the flea market today. Hidden gem.",
        "Saturday vinyl hunting. Always worth getting up early.",
        "The dig is the best part. Always."
      ],
      'daily-life': [
        "Another day, another session.",
        "Coffee and beats. Standard morning.",
        "Sometimes you just need to step away from the screen."
      ]
    };
    
    const options = templates[contentType] || templates['daily-life'];
    return options[Math.floor(Math.random() * options.length)];
  }
  
  // Check if it's time to post
  shouldPost(currentHour, dayOfWeek) {
    if (!this.schedule.posts) return false;
    
    // Parse schedule like "daily 6PM Berlin"
    const [frequency, time] = this.schedule.posts.split(' ');
    const [hour] = time.replace('PM', '').replace('AM', '').split(':').map(Number);
    const isPM = time.includes('PM');
    const targetHour = isPM && hour !== 12 ? hour + 12 : hour;
    
    if (frequency === 'daily') {
      return Math.abs(currentHour - targetHour) < 2;
    }
    
    // Weekly - check day
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    if (frequency === 'weekly') {
      const targetDay = time.replace(/PM|AM/g, '').trim();
      return days[new Date().getDay()] === targetDay && Math.abs(currentHour - targetHour) < 2;
    }
    
    return false;
  }
  
  // Interact with another persona
  interact(targetPersona, type = 'mention') {
    const interactions = {
      mention: [
        `Big up ${targetPersona.name}. Been listening to their stuff.`,
        `Shoutout ${targetPersona.name} — real one.`,
        `${targetPersona.name} is doing amazing work. Check them out.`
      ],
      collab: [
        `Working on something with ${targetPersona.name}. Stay tuned.`,
        `Excited to share what ${targetPersona.name} and I have been cooking up.`,
        `${targetPersona.name} in the lab. 🔥`
      ],
      reply: [
        `Exactly what I was thinking.`,
        `Couldn't agree more.`,
        `Facts. 🔥`
      ]
    };
    
    const options = interactions[type] || interactions['mention'];
    return options[Math.floor(Math.random() * options.length)];
  }
  
  // Simulate a day in the life
  liveDay() {
    const now = new Date();
    const hour = now.getHours();
    const day = now.getDay();
    
    let activity = null;
    
    // Check scheduled content
    if (this.schedule.content) {
      for (const slot of this.schedule.content) {
        const [targetHour] = slot.time.replace('PM', '').replace('AM', '').split(':').map(Number);
        if (Math.abs(hour - targetHour) < 2) {
          activity = this.generateContent(slot.type);
        }
      }
    }
    
    // Random daily post
    if (!activity && Math.random() > 0.7) {
      activity = this.generateContent('daily-life');
    }
    
    if (activity) {
      this.state.lastPost = {
        content: activity,
        timestamp: now.toISOString(),
        platforms: ['twitter'] // Simplified
      };
      this.state.contentQueue.push(this.state.lastPost);
      this.saveState();
    }
    
    return activity;
  }
}

class PersonaWorld {
  constructor() {
    this.personas = PERSONAS.map(p => new Persona(p));
    this.relationships = REGISTRY.interactions;
  }
  
  getPersona(id) {
    return this.personas.find(p => p.id === id);
  }
  
  // Find who should post now
  getActivePosters() {
    const now = new Date();
    const hour = now.getHours();
    
    return this.personas.filter(p => p.shouldPost(hour, now.getDay()));
  }
  
  // Generate interactions between personas
  generateInteractions() {
    const interactions = [];
    
    for (const persona of this.personas) {
      // Chance to interact with relationship
      if (Math.random() > 0.8 && persona.relationships.length > 0) {
        const targetId = persona.relationships[Math.floor(Math.random() * persona.relationships.length)];
        const target = this.getPersona(targetId);
        
        if (target) {
          const type = Math.random() > 0.5 ? 'mention' : 'collab';
          const content = persona.interact(target, type);
          
          interactions.push({
            from: persona.id,
            to: target.id,
            type,
            content,
            timestamp: new Date().toISOString()
          });
          
          // Update state
          persona.state.lastInteraction = { target: target.id, type, timestamp: new Date().toISOString() };
          persona.saveState();
        }
      }
    }
    
    return interactions;
  }
  
  // Simulate one tick of the world
  tick() {
    const results = {
      posts: [],
      interactions: [],
      newPosts: []
    };
    
    // Who should post now?
    const activePosters = this.getActivePosters();
    for (const poster of activePosters) {
      const post = poster.liveDay();
      if (post) {
        results.posts.push({ persona: poster.id, content: post });
        results.newPosts.push(post);
      }
    }
    
    // Generate interactions
    const newInteractions = this.generateInteractions();
    results.interactions = newInteractions;
    
    return results;
  }
  
  // Get status of all personas
  status() {
    return this.personas.map(p => ({
      id: p.id,
      name: p.name,
      type: p.type,
      role: p.role,
      lastPost: p.state.lastPost?.timestamp,
      lastInteraction: p.state.lastInteraction?.timestamp,
      queueLength: p.state.contentQueue.length,
      followers: p.state.followers
    }));
  }
}

// CLI
const command = process.argv[2];
const world = new PersonaWorld();

// Daemon mode - runs continuously
if (command === '--daemon') {
  console.log('Persona Engine running in daemon mode...');
  
  // Tick every 5 minutes
  setInterval(() => {
    const results = world.tick();
    if (results.newPosts.length > 0 || results.interactions.length > 0) {
      console.log(`[${new Date().toISOString()}] Tick: ${results.newPosts.length} posts, ${results.interactions.length} interactions`);
    }
  }, 5 * 60 * 1000); // 5 minutes
  
  // Initial tick
  world.tick();
} else {
  switch (command) {
    case 'status':
      console.log('\n=== Persona World Status ===\n');
      const statuses = world.status();
      for (const s of statuses) {
        console.log(`${s.name} (${s.type})`);
        console.log(`  Role: ${s.role}`);
        console.log(`  Last post: ${s.lastPost || 'Never'}`);
        console.log(`  Queue: ${s.queueLength}`);
        console.log('');
      }
      break;
      
    case 'tick':
      const results = world.tick();
      console.log('\n=== World Tick ===\n');
      console.log(`New posts: ${results.newPosts.length}`);
      for (const post of results.posts) {
        console.log(`  ${post.persona}: ${post.content.slice(0, 50)}...`);
      }
      console.log(`Interactions: ${results.interactions.length}`);
      break;
      
    case 'post':
      const posterId = process.argv[3];
      const poster = world.getPersona(posterId);
      if (poster) {
        const post = poster.liveDay();
        console.log(`\n=== ${poster.name} posted ===\n`);
        console.log(post);
      } else {
        console.log(`Persona not found: ${posterId}`);
        console.log('Available:', world.personas.map(p => p.id).join(', '));
      }
      break;
      
    case 'add':
      // Add new persona via CLI (future)
      console.log('Use registry.json to add personas');
      break;
      
    default:
      console.log(`
Persona Engine - Digital Life Simulation

Commands:
  node persona-engine.js status       # Show all personas
  node persona-engine.js tick        # Run one world tick  
  node persona-engine.js post <id>   # Force persona to post
  node persona-engine.js --daemon    # Run continuously (5min ticks)

Personas:
${PERSONAS.map(p => `  ${p.id} - ${p.name} (${p.role})`).join('\n')}
`);
  }
}

// Auto-run if called as module
export { Persona, PersonaWorld };
