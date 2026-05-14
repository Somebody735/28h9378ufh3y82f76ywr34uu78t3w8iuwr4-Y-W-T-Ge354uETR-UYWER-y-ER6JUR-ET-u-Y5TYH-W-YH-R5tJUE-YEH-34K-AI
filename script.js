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
      <h1>Secure AI Chat</h1>
      <p>Enter your one-time access code to register this device and start chatting.</p>
    </div>
    <form id="access-form" class="form-field">
      <label for="access-code">One-time access code</label>
      <input id="access-code" class="input" type="text" autocomplete="off" placeholder="Enter code" />
      <button class="button" type="submit">Unlock Chat</button>
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

function appendMessage(role, text) {
  const message = document.createElement('div');
  message.className = `message ${role}`;
  const label = document.createElement('small');
  label.textContent = role === 'user' ? 'You' : 'Assistant';
  message.appendChild(label);
  const content = document.createElement('div');
  content.textContent = text;
  message.appendChild(content);
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
              <button class="button" type="submit">Send</button>
              <button id="signout-button" class="button" type="button">Sign Out</button>
            </div>
          </form>
        </div>
      </div>
    </div>
  `;
  app.appendChild(section);

  const chatLog = section.querySelector('#chat-log');
  const form = section.querySelector('#chat-form');
  const input = section.querySelector('#chat-input');
  const signout = section.querySelector('#signout-button');

  if (state.messages.length > 1) {
    state.messages.slice(1).forEach((message) => {
      if (message.role !== 'system') {
        chatLog.appendChild(appendMessage(message.role, message.content));
      }
    });
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    state.messages.push({ role: 'user', content: text });
    chatLog.appendChild(appendMessage('user', text));
    input.value = '';
    const spinner = appendMessage('assistant', 'Thinking...');
    chatLog.appendChild(spinner);
    chatLog.scrollTop = chatLog.scrollHeight;

    try {
      const response = await apiCall('chat', { messages: state.messages.filter((msg) => msg.role !== 'system') });
      const assistantText = response?.assistant || 'Received no answer. Try again.';
      state.messages.push({ role: 'assistant', content: assistantText });
      spinner.textContent = '';
      spinner.appendChild(document.createTextNode(assistantText));
    } catch (error) {
      spinner.textContent = '';
      spinner.appendChild(document.createTextNode(`Chat failed: ${error.message || 'unknown error'}`));
    }
    chatLog.scrollTop = chatLog.scrollHeight;
  });

  signout.addEventListener('click', () => {
    localStorage.removeItem(PASSWORD_STORAGE_KEY);
    state.accessPassword = '';
    state.authorized = false;
    render();
  });
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
