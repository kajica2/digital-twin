/* Browser controller for capture, memory and the command palette. No network or model calls. */
(function () {
  'use strict';
  const pages = new URL('../pages/', document.currentScript.src);
  const M = globalThis.TwinMemory;
  const $ = selector => document.querySelector(selector);
  const el = (tag, text, className) => {
    const node = document.createElement(tag);
    if (text !== undefined) node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const button = (text, action) => {
    const node = el('button', text); node.type = 'button'; node.addEventListener('click', action); return node;
  };
  const panel = name => $(`.rail-item[data-panel="${name}"]`).click();

  class TwinMemoryElement extends HTMLElement {
    connectedCallback() {
      if (this.ready) return;
      this.ready = true;
      const list = this.querySelector('[data-memory-list]');
      const search = this.querySelector('[data-memory-search]');
      const spaces = this.querySelector('[data-memory-spaces]');
      const capture = $('[data-memory-capture]');
      const text = $('[data-memory-text]');
      const cancel = $('[data-memory-cancel]');
      const dialog = $('[data-command-dialog]');
      const commandSearch = $('[data-command-search]');
      const results = $('[data-command-results]');
      let editing = null;
      let deleted = null;
      let state;
      let healthy = true;
      const report = (message, error = false) => {
        document.querySelectorAll('[data-memory-status]').forEach(node => {
          node.textContent = message; node.dataset.error = String(error);
        });
      };
      function load() {
        try { state = M.read(localStorage); healthy = true; }
        catch (_) {
          healthy = false; state = M.empty();
          report('Memory could not be read. Your stored data has been left untouched. Download the stored data below before repairing browser storage.', true);
        }
      }
      const commit = change => {
        try {
          if (!healthy) throw new Error('Memory is unavailable. Download the stored data before repairing browser storage.');
          // Read again before every change so another tab’s latest work is preserved.
          state = M.write(localStorage, change(M.read(localStorage)));
          render(); return true;
        } catch (error) {
          report(error.name === 'QuotaExceededError' ? 'Memory was not saved: browser storage is full. Export a backup, then remove older notes.' : 'Memory was not saved. ' + error.message, true);
          return false;
        }
      };
      const startCapture = note => {
        editing = note?.id || null;
        text.value = note?.text || '';
        cancel.hidden = !editing;
        $('[data-memory-save]').textContent = editing ? 'Save changes' : 'Save memory';
        panel('today'); text.focus();
        capture.scrollIntoView({ block: 'center' });
      };
      const finishCapture = () => {
        editing = null; text.value = ''; cancel.hidden = true;
        $('[data-memory-save]').textContent = 'Save memory';
      };
      const stats = () => {
        const pending = document.querySelectorAll('.agenda-check:not(:checked)').length;
        $('[data-memory-total]').textContent = String(state.notes.length);
        $('[data-agenda-pending]').textContent = String(pending);
        $('[data-workspace-summary]').textContent = `${state.notes.length} memories · ${pending} tasks open`;
        $('[data-memory-count]').textContent = `${state.notes.length} saved on this browser`;
      };
      const render = () => {
        list.replaceChildren(); spaces.replaceChildren();
        const query = search.value.trim();
        const notes = state.notes.filter(note => M.matches(note.text, query))
          .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.updatedAt.localeCompare(a.updatedAt));
        this.querySelector('[data-memory-results]').textContent = `${notes.length} of ${state.notes.length} memories`;
        if (!notes.length) list.append(el('p', query ? 'No memories match. Try fewer words or clear the search.' : 'Your memory starts here. Save a phrase, a reference, or a decision from Today.', 'memory-empty'));
        for (const note of notes) {
          const card = el('article', undefined, 'memory-card'); card.dataset.pinned = String(note.pinned); card.tabIndex = -1;
          card.append(el('p', note.text, 'memory-text'));
          const meta = el('div', undefined, 'memory-meta');
          meta.append(el('span', (note.pinned ? 'Pinned · ' : '') + new Date(note.updatedAt).toLocaleString()));
          const tagGroup = el('span');
          for (const tag of note.tags) {
            const tagButton = button('#' + tag, () => { search.value = '#' + tag; render(); });
            tagButton.className = 'workspace-button'; tagGroup.append(tagButton);
          }
          meta.append(tagGroup); card.append(meta);
          const actions = el('div', undefined, 'memory-actions');
          actions.append(button(note.pinned ? 'Unpin' : 'Pin', () => {
            if (commit(s => ({ ...s, notes: s.notes.map(n => n.id === note.id ? { ...n, pinned: !n.pinned } : n) }))) report(note.pinned ? 'Memory unpinned.' : 'Memory pinned.');
          }));
          actions.append(button('Edit', () => startCapture(note)));
          actions.append(button('Delete', () => {
            if (commit(s => ({ ...s, notes: s.notes.filter(n => n.id !== note.id) }))) {
              deleted = note; $('[data-memory-undo]').hidden = false; report('Memory deleted. Undo is available until you leave this page.');
            }
          }));
          card.append(actions); list.append(card);
        }
        spaces.append(button('All memories', () => { search.value = ''; render(); }));
        for (const space of state.spaces) {
          const group = el('span', undefined, 'memory-space');
          const open = button(space.name, () => { search.value = space.query; render(); });
          open.setAttribute('aria-pressed', String(query === space.query));
          const remove = button('×', () => {
            if (commit(s => ({ ...s, spaces: s.spaces.filter(x => x.id !== space.id) }))) report('Saved search removed. Your memories are unchanged.');
          });
          remove.setAttribute('aria-label', 'Remove saved search ' + space.name);
          group.append(open, remove); spaces.append(group);
        }
        stats();
      };
      load(); render();
      search.addEventListener('input', render);
      capture.addEventListener('submit', event => {
        event.preventDefault();
        const body = text.value.trim(); if (!body) { text.focus(); return; }
        const now = new Date().toISOString();
        if (commit(s => {
          if (editing && !s.notes.some(n => n.id === editing)) throw new Error('This memory was removed in another tab. Cancel editing and save it as a new memory.');
          return { ...s, notes: editing ? s.notes.map(n => n.id === editing ? { ...n, text: body, updatedAt: now } : n)
            : [...s.notes, { id: M.id(), text: body, pinned: false, createdAt: now, updatedAt: now }] };
        })) {
          finishCapture(); report('Memory saved on this browser. Find it in Twin or with Search.'); text.focus();
        }
      });
      cancel.addEventListener('click', () => { finishCapture(); report('Editing cancelled.'); });
      $('[data-capture-open]').addEventListener('click', () => startCapture());
      $('[data-memory-undo]').addEventListener('click', () => {
        if (deleted && commit(s => M.merge(s, { version: 1, notes: [deleted], spaces: [] }))) {
          deleted = null; $('[data-memory-undo]').hidden = true; report('Memory restored.');
        }
      });
      $('[data-memory-save-search]').addEventListener('click', () => {
        const query = search.value.trim();
        if (!query) { report('Enter a search first, then save it.'); search.focus(); return; }
        if (commit(s => s.spaces.some(x => x.query === query) ? s : { ...s, spaces: [...s.spaces, { id: M.id(), name: query.slice(0, 60), query }] })) report('Search saved. New matching memories appear here automatically.');
      });
      function download(raw, filename) {
        const url = URL.createObjectURL(new Blob([raw], { type: 'application/json' }));
        const link = el('a'); link.href = url; link.download = filename;
        document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      }
      $('[data-memory-export]').addEventListener('click', () => {
        try {
          const raw = localStorage.getItem(M.KEY);
          if (!healthy) { download(raw || '{}', 'twin-memory-recovery.json'); report('Stored memory downloaded for recovery.'); return; }
          const current = M.read(localStorage);
          download(JSON.stringify({ app: 'digital-twin-memory', exportedAt: new Date().toISOString(), ...current }, null, 2), 'twin-memory-' + new Date().toISOString().slice(0, 10) + '.json');
          report('Memory backup downloaded. Keep it somewhere safe.');
        } catch (error) { report('Could not export memory. ' + error.message, true); }
      });
      $('[data-memory-import-open]').addEventListener('click', () => $('[data-memory-import]').click());
      $('[data-memory-import]').addEventListener('change', async event => {
        const file = event.target.files[0]; if (!file) return;
        try {
          if (file.size > M.MAX_BYTES) throw new Error('Choose a memory backup smaller than 2 MB.');
          const incoming = M.parseBackup(await file.text());
          let added = 0;
          if (commit(s => { const merged = M.merge(s, incoming); added = merged.notes.length - s.notes.length; return merged; })) report(`Backup imported: ${added} new memories. Existing memories were kept.`);
        } catch (error) { report('Backup was not imported. ' + (error instanceof SyntaxError ? 'Choose a valid JSON memory backup.' : error.message), true); }
        event.target.value = '';
      });
      addEventListener('storage', event => { if (event.key === M.KEY || event.key === null) { load(); render(); } });
      new MutationObserver(stats).observe($('.agenda'), { childList: true, subtree: true, attributes: true, attributeFilter: ['data-done'] });

      // The command palette searches explicit local sources; it never sends a query anywhere.
      const tools = [
        ['Today', 'Agenda and quick capture', () => panel('today')],
        ['Songs', 'Audio catalogue and transcription corpus', () => panel('songs')],
        ['Twin', 'Memory and workspace overview', () => panel('twin')],
        ['Save a memory', 'Capture a phrase, reference or decision', () => startCapture()],
        ...[
          ['MP4 Maker', 'Audio to video, covers and batch export', 'refael-mp4-maker.html'],
          ['Loopable Video Segmenter', 'Beat-aligned mirror loops', 'loopable-video-segmenter.html'],
          ['CLIP Interrogator', 'Image to prompt analysis', 'clip-interrogator.html'],
          ['Midjourney Console', 'Compose and save image prompts', 'mj-console.html'],
          ['How-to guide', 'Operator instructions for the toolkit', 'how-to.html'],
          ['Mood Frames', 'Browse the creative catalogue', 'marketplace.html']
        ].map(([title, detail, path]) => [title, detail, () => location.assign(new URL(path, pages))])
      ];
      let choices = [];
      function renderCommands() {
        const query = commandSearch.value;
        choices = tools.map(([title, detail, run]) => ({ title, detail, run }));
        choices.push(...state.notes.map(note => ({ title: note.text.slice(0, 100), detail: 'Memory · ' + note.tags.map(t => '#' + t).join(' '),
          matchText: note.text, run: () => { search.value = note.text.slice(0, 200); panel('twin'); render(); list.querySelector('article')?.focus(); } })));
        choices.push(...Array.from(document.querySelectorAll('.agenda-item')).map(row => ({
          title: row.querySelector('.agenda-label').childNodes[0].textContent.trim(), detail: row.dataset.done === 'true' ? 'Task · complete' : 'Task · open',
          run: () => { panel('today'); row.tabIndex = -1; row.focus(); row.scrollIntoView({ block: 'center' }); }
        })));
        choices = choices.filter(item => M.matches(item.title + ' ' + item.detail + ' ' + (item.matchText || ''), query)).slice(0, 30);
        results.replaceChildren();
        $('[data-command-count]').textContent = `${choices.length} results · Enter to open · ↑ ↓ to move`;
        if (!choices.length) results.append(el('p', 'Nothing found. Try a tool name, a task, or words from a saved memory.', 'memory-empty'));
        for (const item of choices) {
          const result = button('', () => { dialog.close(); item.run(); });
          result.className = 'command-result'; result.append(el('span', item.title), el('small', item.detail)); results.append(result);
        }
      }
      function openCommands() { if (!dialog.open) dialog.showModal(); commandSearch.value = ''; renderCommands(); commandSearch.focus(); }
      $('[data-command-open]').addEventListener('click', openCommands);
      $('[data-command-close]').addEventListener('click', () => dialog.close());
      commandSearch.addEventListener('input', renderCommands);
      dialog.addEventListener('keydown', event => {
        const items = Array.from(results.querySelectorAll('button'));
        if (event.key === 'Enter' && event.target === commandSearch && items.length) { event.preventDefault(); items[0].click(); }
        if (['ArrowDown', 'ArrowUp'].includes(event.key) && items.length) {
          event.preventDefault(); const index = items.indexOf(document.activeElement);
          if (event.key === 'ArrowUp' && index <= 0) commandSearch.focus();
          else items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
        }
      });
      document.addEventListener('keydown', event => {
        if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
          event.preventDefault(); if (dialog.open) dialog.close(); else openCommands();
        }
      });
    }
  }
  customElements.define('twin-memory', TwinMemoryElement);
})();
