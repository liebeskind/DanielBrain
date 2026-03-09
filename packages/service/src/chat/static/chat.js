/* global fetch */
const messagesEl = document.getElementById('messages');
const inputEl = document.getElementById('input');
const sendBtn = document.getElementById('send-btn');

let history = [];
let streaming = false;

// Auto-resize textarea
inputEl.addEventListener('input', () => {
  inputEl.style.height = 'auto';
  inputEl.style.height = Math.min(inputEl.scrollHeight, 150) + 'px';
});

// Keyboard shortcuts
inputEl.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

function scrollToBottom() {
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function addMessage(role, content) {
  // Remove welcome message on first interaction
  const welcome = messagesEl.querySelector('.welcome-message');
  if (welcome) welcome.remove();

  const div = document.createElement('div');
  div.className = `message ${role}`;
  div.innerHTML = `<div class="message-bubble">${escapeHtml(content)}</div>`;
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
  // Code blocks (``` ... ```)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code>$2</code></pre>');
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  // Italic
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  // Headings
  html = html.replace(/^### (.+)$/gm, '<h4>$1</h4>');
  html = html.replace(/^## (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^# (.+)$/gm, '<h2>$1</h2>');
  // Unordered list items
  html = html.replace(/^[-*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>');
  // Numbered list items
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  // Line breaks (but not inside pre/code or after block elements)
  html = html.replace(/\n/g, '<br>');
  // Clean up <br> after block elements
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
      <button class="sources-toggle" onclick="this.nextElementSibling.classList.toggle('visible')">Sources (${sources.length + entities.length})</button>
      <div class="sources-list">${items.join('')}</div>
    </div>
  `;
}

async function sendMessage() {
  const text = inputEl.value.trim();
  if (!text || streaming) return;

  streaming = true;
  sendBtn.disabled = true;
  inputEl.value = '';
  inputEl.style.height = 'auto';

  addMessage('user', text);
  const placeholder = addAssistantPlaceholder();
  const bubble = placeholder.querySelector('.message-bubble');

  let fullResponse = '';
  let contextData = null;

  try {
    const response = await fetch('/chat/api/message', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, history }),
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

    // Update history
    history.push({ role: 'user', content: text });
    history.push({ role: 'assistant', content: fullResponse });

  } catch (err) {
    bubble.textContent = 'Connection error: ' + err.message;
  }

  streaming = false;
  sendBtn.disabled = false;
  inputEl.focus();
}

// New chat
function newChat() {
  history = [];
  messagesEl.innerHTML = `
    <div class="welcome-message">
      <h2>DanielBrain Chat</h2>
      <p>Ask me anything about your knowledge base — meetings, people, projects, action items.</p>
    </div>
  `;
  inputEl.focus();
}
