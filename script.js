import { SUPABASE_FUNCTION_URL, SUPABASE_ANON_KEY } from './supabase-config.js';

const PASSWORD_STORAGE_KEY = 'ai-access-password';
const DEVICE_STORAGE_KEY = 'ai-device-code';
const functionUrlCandidates = (() => {
  const url = SUPABASE_FUNCTION_URL.replace(/\/$/, '');
  const candidates = [url];
  if (url.includes('.supabase.co/functions/v1')) {
    candidates.push(url.replace('.supabase.co/functions/v1', '.functions.supabase.co'));
  }
  if (url.includes('.functions.supabase.co')) {
    candidates.push(url.replace('.functions.supabase.co', '.supabase.co/functions/v1'));
  }
  return [...new Set(candidates)];
})();
let activeFunctionUrl = null;

const app = document.getElementById('app');

const state = {
  deviceCode: '',
  accessPassword: '',
  authorized: false,
  isAdmin: false,
  error: '',
  messages: [
    { role: 'system', content: 'You are a helpful AI assistant. Answer user questions clearly and politely.' },
  ],
  availableModels: [],
  selectedModel: '',
  editingMessageIndex: null,
  editingOriginalText: '',
};

function getOrCreateDeviceCode() {
  let code = localStorage.getItem(DEVICE_STORAGE_KEY);
  if (!code) {
    code = crypto.randomUUID();
    localStorage.setItem(DEVICE_STORAGE_KEY, code);
  }
  return code;
}

function getFunctionEndpoint(url) {
  return url.endsWith('/api') ? url : `${url}/api`;
}

async function resolveFunctionUrl() {
  if (activeFunctionUrl) return activeFunctionUrl;

  const errors = [];
  for (const candidate of functionUrlCandidates) {
    const endpoint = getFunctionEndpoint(candidate);
    try {
      const response = await fetch(endpoint, { method: 'OPTIONS' });
      if (response.ok) {
        activeFunctionUrl = endpoint;
        return activeFunctionUrl;
      }
      errors.push(`${endpoint} returned ${response.status}`);
    } catch (fetchError) {
      errors.push(`${endpoint} error: ${fetchError.message}`);
    }
  }

  throw new Error(`No working function endpoint found. Tried: ${errors.join('; ')}`);
}

async function apiCall(action, payload = {}) {
  const endpoint = await resolveFunctionUrl();
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        apikey: SUPABASE_ANON_KEY,
        'x-device-code': state.deviceCode,
        'x-access-password': state.accessPassword || '',
      },
      body: JSON.stringify({ action, payload }),
    });

    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch (parseError) {
      throw new Error(`Invalid JSON response from function at ${endpoint}: ${parseError.message} - response text: ${text}`);
    }

    if (!response.ok) {
      throw new Error(`Function request failed with status ${response.status}: ${data?.error || text || response.statusText}`);
    }
    if (data?.error) {
      throw new Error(data.error);
    }
    return data;
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(`Failed to connect to the edge function at ${endpoint}: ${error.message}`);
    }
    throw error;
  }
}

async function testFunctionEndpoint() {
  const results = [];
  for (const candidate of functionUrlCandidates) {
    const endpoint = getFunctionEndpoint(candidate);
    try {
      const optionsResponse = await fetch(endpoint, { method: 'OPTIONS' });
      results.push(`${endpoint} OPTIONS ${optionsResponse.status}`);
    } catch (error) {
      results.push(`${endpoint} OPTIONS failed: ${error.message}`);
      continue;
    }
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          apikey: SUPABASE_ANON_KEY,
          'x-device-code': state.deviceCode,
          'x-access-password': state.accessPassword || '',
        },
        body: JSON.stringify({ action: 'checkAuth', payload: {} }),
      });
      const text = await response.text();
      if (!response.ok) {
        results.push(`${endpoint} POST ${response.status}: ${text}`);
      } else {
        results.push(`${endpoint} POST ${response.status}: OK`);
      }
    } catch (error) {
      results.push(`${endpoint} POST failed: ${error.message}`);
    }
  }
  return results.join(' | ');
}

async function claimAdminIfMissing() {
  try {
    await apiCall('claimAdminIfMissing', { device_code: state.deviceCode });
  } catch (error) {
    console.warn('Claim admin check failed:', error.message || error);
  }
}

async function checkAuthorization() {
  try {
    const result = await apiCall('checkAuth');
    state.authorized = result?.authorized === true;
    state.isAdmin = result?.is_admin === true;
    state.error = '';
    
    if (state.authorized) {
      try {
        const modelsResult = await apiCall('getModels');
        state.availableModels = modelsResult?.models || [];
        const defaultModelResult = await apiCall('getDefaultModel');
        state.selectedModel = defaultModelResult?.defaultModel || '';
      } catch (error) {
        console.warn('Failed to load models:', error.message);
      }
    }
  } catch (error) {
    state.authorized = false;
    state.isAdmin = false;
    state.error = error.message || 'Unable to verify access.';
  }
}

function render() {
  app.innerHTML = '';
  if (state.authorized) {
    renderChatInterface();
  } else {
    renderAccessForm();
  }
}

function renderAccessForm() {
  const section = document.createElement('div');
  section.className = 'section';
  section.innerHTML = `
    <div class="centered">
      <h1>Secure Access</h1>
      <p>Enter your one-time access code to register this device.</p>
    </div>
    <form id="access-form" class="form-field">
      <label for="access-code">One-time access code</label>
      <input id="access-code" class="input" type="text" autocomplete="off" placeholder="Enter code" />
      <button class="button" type="submit">Unlock</button>
    </form>
    <div id="access-error"></div>
    <div style="display:flex; gap:12px; flex-wrap:wrap; align-items:center; margin-top:16px;">
      <button id="diagnose-button" class="button" type="button">Check Connection</button>
      <div id="diagnostic-result" style="font-size:0.95rem; color:var(--muted);"></div>
    </div>
  `;
  app.appendChild(section);

  const form = section.querySelector('#access-form');
  const errorBox = section.querySelector('#access-error');
  const diagnoseButton = section.querySelector('#diagnose-button');
  const diagnosticResult = section.querySelector('#diagnostic-result');
  if (state.error) {
    errorBox.innerHTML = `<div class="alert">${state.error}</div>`;
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const code = section.querySelector('#access-code').value.trim();
    if (!code) {
      errorBox.innerHTML = `<div class="alert">Please enter the one-time code you received.</div>`;
      return;
    }
    try {
      await redeemOtp(code);
      render();
    } catch (error) {
      errorBox.innerHTML = `<div class="alert">${error.message || 'Failed to redeem code. Please try again.'}</div>`;
    }
  });

  diagnoseButton.addEventListener('click', async () => {
    diagnosticResult.textContent = 'Checking...';
    diagnoseButton.disabled = true;
    try {
      const result = await testFunctionEndpoint();
      diagnosticResult.textContent = result;
    } catch (error) {
      diagnosticResult.textContent = error.message || 'Connection test failed.';
    } finally {
      diagnoseButton.disabled = false;
    }
  });
}

function parseMarkdown(text) {
  // Simple markdown parser
  let html = text
    // Escape HTML
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    // Code blocks
    .replace(/```([\s\S]*?)```/g, '<pre><code>$1</code></pre>')
    // Inline code
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    // Bold
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    // Italic
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    // Line breaks
    .replace(/\n/g, '<br>');
  return html;
}

function appendMessage(role, text, index = null) {
  const message = document.createElement('div');
  message.className = `message ${role}`;
  message.dataset.index = index !== null ? index : '';
  
  const label = document.createElement('small');
  label.textContent = role === 'user' ? 'You' : 'Assistant';
  message.appendChild(label);
  
  const content = document.createElement('div');
  content.className = 'message-content';
  content.innerHTML = parseMarkdown(text);
  message.appendChild(content);
  
  // Add action buttons (edit/copy) - only show on hover
  const actions = document.createElement('div');
  actions.className = 'message-actions';
  actions.style.cssText = 'opacity:0; transition:opacity 0.2s; display:flex; gap:8px; margin-top:8px;';
  
  if (role === 'user') {
    const editButton = document.createElement('button');
    editButton.className = 'button';
    editButton.textContent = 'Edit';
    editButton.style.cssText = 'font-size:0.8rem; padding:4px 8px;';
    editButton.addEventListener('click', () => startEditingMessage(index, text));
    actions.appendChild(editButton);
  }
  
  const copyButton = document.createElement('button');
  copyButton.className = 'button';
  copyButton.textContent = 'Copy';
  copyButton.style.cssText = 'font-size:0.8rem; padding:4px 8px;';
  copyButton.addEventListener('click', () => copyMessage(text));
  actions.appendChild(copyButton);
  
  message.appendChild(actions);
  
  // Show actions on hover
  message.addEventListener('mouseenter', () => actions.style.opacity = '1');
  message.addEventListener('mouseleave', () => actions.style.opacity = '0');
  
  return message;
}

function renderChatInterface() {
  const section = document.createElement('div');
  section.className = 'section';
  section.innerHTML = `
    <div class="centered">
      <h1>AI Chat</h1>
      <p>Secure access granted. Chat with the AI below.</p>
    </div>
    <div class="chat-shell">
      <div class="chat-window">
        <div id="chat-log" class="chat-log"></div>
        <div class="chat-actions">
          <form id="chat-form">
            <label for="chat-input">Message</label>
            <textarea id="chat-input" placeholder="Ask the AI anything..." required></textarea>
            <div style="display:flex; gap:12px; flex-wrap:wrap; align-items:center;">
              ${state.editingMessageIndex !== null ? `
                <button class="button" type="submit">Update</button>
                <button id="cancel-edit-button" class="button" type="button">Cancel</button>
              ` : `
                <button class="button" type="submit">Send</button>
                <button id="export-chat-button" class="button" type="button">Export Chat</button>
                <button id="import-chat-button" class="button" type="button">Import Chat</button>
              `}
            </div>
            ${state.isAdmin ? `
            <div style="margin-top:12px;">
              <label for="model-select">Model</label>
              <select id="model-select" class="input">
                <option value="">Use Default</option>
                ${state.availableModels.map(m => `<option value="${m.key}">${m.name}</option>`).join('')}
              </select>
            </div>
            ` : ''}
          </form>
        </div>
      </div>
    </div>
  `;
  app.appendChild(section);

  const chatLog = section.querySelector('#chat-log');
  const form = section.querySelector('#chat-form');
  const input = section.querySelector('#chat-input');
  const exportButton = section.querySelector('#export-chat-button');
  const importButton = section.querySelector('#import-chat-button');
  const modelSelect = section.querySelector('#model-select');
  const cancelEditButton = section.querySelector('#cancel-edit-button');

  exportButton?.addEventListener('click', exportChat);
  importButton?.addEventListener('click', importChat);
  cancelEditButton?.addEventListener('click', cancelEditing);
  
  if (modelSelect) {
    modelSelect.addEventListener('change', (e) => {
      state.selectedModel = e.target.value;
    });
  }
  
  if (state.editingMessageIndex !== null) {
    input.value = state.editingOriginalText;
    input.focus();
  }

  if (state.messages.length > 1) {
    state.messages.slice(1).forEach((message, index) => {
      if (message.role !== 'system') {
        chatLog.appendChild(appendMessage(message.role, message.content, index + 1));
      }
    });
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    
    if (state.editingMessageIndex !== null) {
      // Edit mode: revert to that point and send
      state.messages = state.messages.slice(0, state.editingMessageIndex);
      state.messages.push({ role: 'user', content: text });
      state.editingMessageIndex = null;
      state.editingOriginalText = '';
      render();
    } else {
      // Normal mode
      state.messages.push({ role: 'user', content: text });
      chatLog.appendChild(appendMessage('user', text, state.messages.length - 1));
    }
    
    input.value = '';
    const spinner = appendMessage('assistant', 'Thinking...');
    chatLog.appendChild(spinner);
    chatLog.scrollTop = chatLog.scrollHeight;

    try {
      const payload = { messages: state.messages.filter((msg) => msg.role !== 'system') };
      if (state.isAdmin && state.selectedModel) {
        payload.model = state.selectedModel;
      }
      const response = await apiCall('chat', payload);
      const assistantText = response?.assistant || 'Received no answer. Try again.';
      state.messages.push({ role: 'assistant', content: assistantText });
      spinner.textContent = '';
      spinner.appendChild(document.createTextNode(assistantText));
      // Re-render to show markdown formatting
      const newMessage = appendMessage('assistant', assistantText, state.messages.length - 1);
      chatLog.replaceChild(newMessage, spinner);
    } catch (error) {
      spinner.textContent = '';
      spinner.appendChild(document.createTextNode(`Chat failed: ${error.message || 'unknown error'}`));
    }
    chatLog.scrollTop = chatLog.scrollHeight;
  });
}

function startEditingMessage(index, text) {
  state.editingMessageIndex = index;
  state.editingOriginalText = text;
  render();
}

function cancelEditing() {
  state.editingMessageIndex = null;
  state.editingOriginalText = '';
  render();
}

function copyMessage(text) {
  navigator.clipboard.writeText(text).then(() => {
    alert('Message copied to clipboard.');
  }).catch(() => {
    alert('Failed to copy message.');
  });
}

function exportChat() {
  const chatData = {
    messages: state.messages.filter((msg) => msg.role !== 'system'),
    exportedAt: new Date().toISOString(),
  };
  const blob = new Blob([JSON.stringify(chatData, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `chat-export-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function importChat() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json';
  input.addEventListener('change', (event) => {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.addEventListener('load', (e) => {
      try {
        const chatData = JSON.parse(e.target.result);
        if (Array.isArray(chatData.messages)) {
          state.messages = [
            { role: 'system', content: 'You are a helpful AI assistant. Answer user questions clearly and politely.' },
            ...chatData.messages,
          ];
          render();
        } else {
          alert('Invalid chat file format.');
        }
      } catch (error) {
        alert('Failed to parse chat file: ' + error.message);
      }
    });
    reader.readAsText(file);
  });
  input.click();
}

async function redeemOtp(code) {
  const result = await apiCall('redeemOtp', { otp: code });
  if (!result?.ok) {
    throw new Error(result?.message || 'Unable to redeem this access code.');
  }
  localStorage.setItem(PASSWORD_STORAGE_KEY, code);
  state.accessPassword = code;
  return await checkAuthorization();
}

async function init() {
  state.deviceCode = getOrCreateDeviceCode();
  state.accessPassword = localStorage.getItem(PASSWORD_STORAGE_KEY) || '';
  await claimAdminIfMissing();
  await checkAuthorization();
  render();
}

init();
