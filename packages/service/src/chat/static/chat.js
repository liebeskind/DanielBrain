/* global fetch, history */
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send-btn');
const conversationListEl = document.getElementById('conversation-list');
const projectFilterEl = document.getElementById('project-filter');

let currentConversationId = null;
let streaming = false;

// ---- Init ----
async function init() {
  await loadProjects();
  await loadConversations();

  // Check URL for conversation ID
  const params = new URLSearchParams(window.location.search);
  const convId = params.get('c');
  if (convId) {
    await loadConversation(convId);
  }
}

// ---- Auto-resize textarea ----
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 150) + 'px';
});

inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

// ---- Conversations ----
async function loadConversations() {
  try {
    const projectId = projectFilterEl.value;
    const url = projectId
      ? `/chat/api/conversations?project_id=${projectId}`
      : '/chat/api/conversations';
    const res = await fetch(url);
    const conversations = await res.json();
    renderConversationList(conversations);
  } catch (err) {
    console.error('Failed to load conversations:', err);
  }
}

function renderConversationList(conversations) {
  conversationListEl.innerHTML = '';
  if (conversations.length === 0) {
    conversationListEl.innerHTML = '<div class="conv-empty">No conversations yet</div>';
    return;
  }
  for (const conv of conversations) {
    const el = document.createElement('div');
    el.className = `conv-item${conv.id === currentConversationId ? ' active' : ''}`;
    el.dataset.id = conv.id;

    const title = conv.title || 'New conversation';
    const date = new Date(conv.updated_at).toLocaleDateString();

    el.innerHTML = `
      <div class="conv-item-content" onclick="loadConversation('${conv.id}')">
        <div class="conv-title">${escapeHtml(title)}</div>
        <div class="conv-date">${date}</div>
      </div>
      <div class="conv-actions">
        <button class="conv-action-btn" onclick="event.stopPropagation(); showConvMenu('${conv.id}', this)" title="More">&#x22EE;</button>
        <div class="conv-menu hidden" id="menu-${conv.id}">
          <button onclick="renameConversation('${conv.id}')">Rename</button>
          <button onclick="assignProject('${conv.id}')">Move to project</button>
          <button class="danger" onclick="deleteConversation('${conv.id}')">Delete</button>
        </div>
      </div>
    `;
    conversationListEl.appendChild(el);
  }
}

function showConvMenu(id, btn) {
  // Close all other menus
  document.querySelectorAll('.conv-menu').forEach(m => m.classList.add('hidden'));
  const menu = document.getElementById('menu-' + id);
  menu.classList.toggle('hidden');

  // Close on outside click
  const close = (e) => {
    if (!menu.contains(e.target) && e.target !== btn) {
      menu.classList.add('hidden');
      document.removeEventListener('click', close);
    }
  };
  setTimeout(() => document.addEventListener('click', close), 0);
}

async function loadConversation(id) {
  currentConversationId = id;
  window.history.replaceState(null, '', `/chat?c=${id}`);

  // Highlight in sidebar
  document.querySelectorAll('.conv-item').forEach(el => {
    el.classList.toggle('active', el.dataset.id === id);
  });

  // Load messages
  try {
    const res = await fetch(`/chat/api/conversations/${id}/messages`);
    const messages = await res.json();
    renderConversationMessages(messages);
  } catch (err) {
    console.error('Failed to load conversation:', err);
  }
}

function renderConversationMessages(messages) {
  messagesEl.innerHTML = '';
  if (messages.length === 0) {
    messagesEl.innerHTML = `
      <div class="welcome-message">
        <div class="welcome-icon">&#x1F9E0;</div>
        <h2>TopiaBrain Chat</h2>
        <p>Ask me anything about your knowledge base — meetings, people, projects, action items.</p>
      </div>
    `;
    return;
  }

  for (const msg of messages) {
    if (msg.role === 'user') {
      addMessage('user', msg.content);
    } else {
      const div = addAssistantMessage(msg.content);
      if (msg.context_data) {
        div.insertAdjacentHTML('beforeend', renderSources(msg.context_data.sources, msg.context_data.entities));
      }
    }
  }
  scrollToBottom();
}

async function renameConversation(id) {
  const newTitle = prompt('Rename conversation:');
  if (newTitle === null) return;
  try {
    await fetch(`/chat/api/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: newTitle.trim() || null }),
    });
    await loadConversations();
  } catch (err) {
    console.error('Failed to rename:', err);
  }
}

async function assignProject(id) {
  // Build options from loaded projects
  const options = projectFilterEl.options;
  const choices = [];
  for (let i = 1; i < options.length; i++) {
    choices.push(`${i}. ${options[i].text}`);
  }
  if (choices.length === 0) {
    alert('No projects created yet. Create one first.');
    return;
  }
  const input = prompt(`Assign to project:\n0. None\n${choices.join('\n')}\n\nEnter number:`);
  if (input === null) return;
  const idx = parseInt(input, 10);
  const projectId = idx === 0 ? null : (options[idx]?.value || null);

  try {
    await fetch(`/chat/api/conversations/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project_id: projectId }),
    });
    await loadConversations();
  } catch (err) {
    console.error('Failed to assign project:', err);
  }
}

async function deleteConversation(id) {
  if (!confirm('Delete this conversation?')) return;
  try {
    await fetch(`/chat/api/conversations/${id}`, { method: 'DELETE' });
    if (currentConversationId === id) {
      newChat();
    }
    await loadConversations();
  } catch (err) {
    console.error('Failed to delete:', err);
  }
}

// ---- Projects ----
async function loadProjects() {
  try {
    const res = await fetch('/chat/api/projects');
    const projects = await res.json();
    // Keep first option ("All conversations")
    while (projectFilterEl.options.length > 1) {
      projectFilterEl.remove(1);
    }
    for (const p of projects) {
      const opt = document.createElement('option');
      opt.value = p.id;
      opt.textContent = p.name;
      projectFilterEl.appendChild(opt);
    }
    // Add "Manage projects..." option
    const manage = document.createElement('option');
    manage.value = '__manage__';
    manage.textContent = '--- Manage Projects ---';
    projectFilterEl.appendChild(manage);
  } catch (err) {
    console.error('Failed to load projects:', err);
  }
}

async function filterByProject(value) {
  if (value === '__manage__') {
    projectFilterEl.value = '';
    await manageProjects();
    return;
  }
  await loadConversations();
}

async function manageProjects() {
  const action = prompt('Projects:\n1. Create new project\n2. Delete a project\n\nEnter 1 or 2:');
  if (action === '1') {
    const name = prompt('Project name:');
    if (!name?.trim()) return;
    try {
      await fetch('/chat/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: name.trim() }),
      });
      await loadProjects();
    } catch (err) {
      console.error('Failed to create project:', err);
    }
  } else if (action === '2') {
    const options = projectFilterEl.options;
    const choices = [];
    for (let i = 1; i < options.length - 1; i++) {
      choices.push(`${i}. ${options[i].text}`);
    }
    if (choices.length === 0) {
      alert('No projects to delete.');
      return;
    }
    const idx = parseInt(prompt(`Delete project:\n${choices.join('\n')}\n\nEnter number:`) || '', 10);
    const projectId = options[idx]?.value;
    if (!projectId) return;
    if (!confirm(`Delete project "${options[idx].text}"?`)) return;
    try {
      await fetch(`/chat/api/projects/${projectId}`, { method: 'DELETE' });
      await loadProjects();
      await loadConversations();
    } catch (err) {
      console.error('Failed to delete project:', err);
    }
  }
}

// ---- Message rendering ----
function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addMessage(role, content) {
  const welcome = messagesEl.querySelector('.welcome-message');
  if (welcome) welcome.remove();

  const div = document.createElement('div');
  div.className = `message ${role}`;
  if (role === 'user') {
    div.innerHTML = `<div class="message-bubble">${escapeHtml(content)}</div>`;
  } else {
    div.innerHTML = `<div class="message-bubble">${renderMarkdown(content)}</div>`;
  }
  messagesEl.appendChild(div);
  scrollToBottom();
  return div;
}

function addAssistantMessage(content) {
  const welcome = messagesEl.querySelector('.welcome-message');
  if (welcome) welcome.remove();

  const div = document.createElement('div');
  div.className = 'message assistant';
  div.innerHTML = `<div class="message-bubble">${renderMarkdown(content)}</div>`;
  messagesEl.appendChild(div);
  scrollToBottom();
  return div;
}

function addAssistantPlaceholder() {
  const welcome = messagesEl.querySelector('.welcome-message');
  if (welcome) welcome.remove();

  const div = document.createElement('div');
  div.className = 'message assistant';
  div.innerHTML = `
    <div class="message-bubble"><div class="typing-indicator"><span></span><span></span><span></span></div></div>
  `;
  messagesEl.appendChild(div);
  scrollToBottom();
  return div;
}

function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

function renderMarkdown(text) {
  let html = escapeHtml(text);
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  html = html.replace(/\n/g, '<br>');
  html = html.replace(/(<\/(?:h[2-4]|pre|ul|li)>)<br>/g, '$1');
  html = html.replace(/<br>(<(?:h[2-4]|pre|ul|li))/g, '$1');
  return html;
}

function renderSources(sources, entities) {
  if ((!sources || sources.length === 0) && (!entities || entities.length === 0)) return '';

  const items = [];
  if (sources) {
    for (const s of sources) {
      const summary = s.summary || 'No summary';
      items.push(`<div class="source-item">${escapeHtml(s.source)}: ${escapeHtml(summary)} (${(s.similarity * 100).toFixed(0)}% match)</div>`);
    }
  }
  if (entities) {
    for (const e of entities) {
      items.push(`<div class="source-item">${escapeHtml(e.name)} (${e.entity_type})</div>`);
    }
  }

  return `
    <div class="message-sources">
      <button class="sources-toggle" onclick="this.nextElementSibling.classList.toggle('visible')">Sources (${(sources || []).length + (entities || []).length})</button>
      <div class="sources-list">${items.join('')}</div>
    </div>
  `;
}

// ---- Send message ----
async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || streaming) return;

  streaming = true;
  sendBtn.disabled = true;
  inputEl.value = '';
  inputEl.style.height = 'auto';

  // Create conversation if needed
  if (!currentConversationId) {
    try {
      const res = await fetch('/chat/api/conversations', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const conv = await res.json();
      currentConversationId = conv.id;
      window.history.replaceState(null, '', `/chat?c=${conv.id}`);
    } catch (err) {
      console.error('Failed to create conversation:', err);
      streaming = false;
      sendBtn.disabled = false;
      return;
    }
  }

  addMessage('user', text);
  const placeholder = addAssistantPlaceholder();
  const bubble = placeholder.querySelector('.message-bubble');

  let fullResponse = '';
  let contextData = null;

  try {
    const response = await fetch(`/chat/api/conversations/${currentConversationId}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text }),
    });

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let started = false;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6);

        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);

          if (parsed.type === 'context') {
            contextData = parsed;
            continue;
          }

          if (parsed.error) {
            bubble.textContent = 'Error: ' + parsed.error;
            continue;
          }

          if (parsed.token) {
            if (!started) {
              bubble.innerHTML = '';
              started = true;
            }
            fullResponse += parsed.token;
            bubble.innerHTML = renderMarkdown(fullResponse);
            scrollToBottom();
          }
        } catch {
          // skip malformed
        }
      }
    }

    // Add sources below the message
    if (contextData) {
      placeholder.insertAdjacentHTML('beforeend', renderSources(contextData.sources, contextData.entities));
    }

    // Refresh conversation list (title may have been auto-generated)
    await loadConversations();

  } catch (err) {
    bubble.textContent = 'Connection error: ' + err.message;
  }

  streaming = false;
  sendBtn.disabled = false;
  inputEl.focus();
}

// ---- New chat ----
function newChat() {
  currentConversationId = null;
  window.history.replaceState(null, '', '/chat');
  document.querySelectorAll('.conv-item').forEach(el => el.classList.remove('active'));
  messagesEl.innerHTML = `
    <div class="welcome-message">
      <div class="welcome-icon">&#x1F9E0;</div>
      <h2>TopiaBrain Chat</h2>
      <p>Ask me anything about your knowledge base — meetings, people, projects, action items.</p>
    </div>
  `;
  inputEl.focus();
}

// ---- Start ----
init();
