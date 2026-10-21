# Web Dashboard Integration Plan

## Current State

### Working Components
- ✅ Local server at `localhost:5173`
- ✅ Twin OS PWA dashboard
- ✅ Midjourney automation (web + cookies)
- ✅ VHS GIF Maker / Images → MOV tools
- ✅ GarageBand Mixer (mock)
- ✅ Watermark tool
- ✅ MJ Style Prefix with image attachment

### Missing Integration
- ❌ No unified dashboard showing all tools
- ❌ No job queue / status tracking
- ❌ No unified image gallery
- ❌ No cross-tool workflow (e.g., MJ → watermark → email)

---

## Phase 1: Unified Dashboard (Priority: HIGH)

### 1.1 Main Dashboard Page
```
/pages/dashboard.html
```

Features:
- Grid of all available tools
- Recent activity feed
- Quick actions
- System status (server, MJ browser, disk space)

### 1.2 Unified Job Queue
```
/data/jobs/catalog.json
```

Structure:
```json
{
  "jobs": [
    {
      "id": "uuid",
      "type": "mj-generation|watermark|conversion",
      "status": "pending|running|complete|failed",
      "input": { ... },
      "output": { "url": "...", "path": "..." },
      "createdAt": "ISO",
      "completedAt": "ISO"
    }
  ]
}
```

---

## Phase 2: Cross-Tool Workflows (Priority: MEDIUM)

### 2.1 MJ → Watermark Pipeline
1. Generate image in MJ
2. Auto-download result
3. Apply watermark
4. Option: email or save

### 2.2 Batch Processing
- Queue multiple MJ prompts
- Process sequentially
- Apply consistent watermark to all

### 2.3 Gallery View
- Show all generated images
- Filter by date/type
- Bulk actions (watermark, delete, email)

---

## Phase 3: Automation (Priority: LOW)

### 3.1 Background Watchers
- Watch `mj-input/` folder for new prompts
- Auto-submit to MJ
- Notify on completion

### 3.2 Scheduled Jobs
- Cron-like scheduling
- Daily batch processing

---

## Implementation Tasks

### Week 1: Dashboard
- [ ] Create unified dashboard page
- [ ] Add job queue storage
- [ ] Build status indicators

### Week 2: Integration  
- [ ] Connect MJ output to gallery
- [ ] Add watermark workflow
- [ ] Email integration

### Week 3: Polish
- [ ] Add notifications
- [ ] Offline support (service worker)
- [ ] Mobile responsive

---

## File Structure

```
pages/
  dashboard.html      # Main unified dashboard
  mj-style-prefix.html
  watermark.html
  vhs-gif-maker.html
  images-to-mov.html
  garageband-mixer.html

lib/
  serve.js           # Add API routes
  job-queue.js       # Job management
  gallery.js         # Image gallery

data/
  jobs/
    catalog.json    # Job queue
  gallery/
    catalog.json   # Image gallery
```

---

## API Endpoints Needed

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/jobs | List all jobs |
| POST | /api/jobs | Create new job |
| GET | /api/jobs/:id | Get job status |
| DELETE | /api/jobs/:id | Cancel/delete job |
| POST | /api/watermark | Apply watermark |
| POST | /api/gallery | Add to gallery |

---

## Success Metrics

- All tools accessible from one dashboard
- Job status visible in real-time
- Complete workflow: prompt → generate → watermark → email works
- < 3 second page load
- Works offline (PWA)
