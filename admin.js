import { SUPABASE_FUNCTION_URL, SUPABASE_ANON_KEY } from './supabase-config.js';

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

const app = document.getElementById('admin-app');

const state = {
  deviceCode: '',
  authorized: false,
  loading: true,
  error: '',
  otpList: [],
  deviceList: [],
  unauthorizedVisits: [],
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
        'x-access-password': '',
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
          'x-access-password': '',
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

function generateOtp() {
  return Array.from({ length: 8 }, () => Math.floor(Math.random() * 36).toString(36)).join('').toUpperCase();
}

function renderBlocked(message) {
  app.innerHTML = `
    <div class="section centered">
      <h1>Access Denied</h1>
      <p>${message || 'This device is not authorized to view the admin dashboard.'}</p>
      <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;justify-content:center; margin-top:16px;">
        <button id="admin-diagnose-button" class="button" type="button">Check Function Connection</button>
        <a class="button" href="index.html">Go to Chat Home</a>
      </div>
      <div id="admin-diagnostic-result" style="margin-top:16px; color:var(--muted); font-size:0.95rem;"></div>
    </div>
  `;

  const diagnoseButton = document.getElementById('admin-diagnose-button');
  const diagnosticResult = document.getElementById('admin-diagnostic-result');

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

function renderAdminPanel() {
  app.innerHTML = `
    <div class="section">
      <div class="centered">
        <h1>Admin Dashboard</h1>
        <p>Manage one-time passwords and active devices.</p>
      </div>
      <div class="form-field">
        <form id="create-otp-form">
          <label for="otp-code">Create a new one-time access code</label>
          <div style="display:flex;gap:12px;flex-wrap:wrap;align-items:center;">
            <input id="otp-code" class="input" type="text" placeholder="Leave blank to generate" />
            <button class="button" type="submit">Create OTP</button>
          </div>
        </form>
      </div>
      <div id="admin-feedback"></div>
      <div class="section">
        <h2>Active Devices</h2>
        <div class="table-wrapper">
          <table id="devices-table"><thead><tr><th>Name</th><th>Device Code</th><th>Type</th><th>Status</th><th>Actions</th></tr></thead><tbody></tbody></table>
        </div>
      </div>
      <div class="section">
        <h2>One-time Passwords</h2>
        <div class="table-wrapper">
          <table id="otps-table"><thead><tr><th>Code</th><th>Redeemed</th><th>Redeemed Device</th><th>Created</th><th>Actions</th></tr></thead><tbody></tbody></table>
        </div>
      </div>
      <div class="section">
        <h2>Unauthorized Visits</h2>
        <div class="table-wrapper">
          <table id="visits-table"><thead><tr><th>Device Code</th><th>Visited At</th><th>Actions</th></tr></thead><tbody></tbody></table>
        </div>
      </div>
      <div style="margin-top:18px;display:flex;gap:12px;flex-wrap:wrap;align-items:center;">
        <button id="refresh-button" class="button">Refresh</button>
        <a class="button" href="index.html">Back to Chat</a>
      </div>
    </div>
  `;

  const form = document.querySelector('#create-otp-form');
  const feedback = document.querySelector('#admin-feedback');
  const refreshButton = document.querySelector('#refresh-button');

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const input = document.getElementById('otp-code');
    const code = input.value.trim() || generateOtp();
    try {
      await apiCall('createOtp', { code });
      feedback.innerHTML = `<div class="alert success">Created OTP: <strong>${code}</strong></div>`;
      input.value = '';
      await loadAdminData();
    } catch (error) {
      feedback.innerHTML = `<div class="alert">${error.message || 'Unable to create OTP.'}</div>`;
    }
  });

  refreshButton.addEventListener('click', async () => {
    await loadAdminData();
  });

  renderDevices();
  renderOtps();
}

async function loadAdminData() {
  try {
    const [devices, otps, visits] = await Promise.all([apiCall('listDevices'), apiCall('listOtps'), apiCall('listUnauthorizedVisits')]);
    state.deviceList = devices || [];
    state.otpList = otps || [];
    state.unauthorizedVisits = visits || [];
    renderDevices();
    renderOtps();
    renderUnauthorizedVisits();
  } catch (error) {
    renderBlocked(error.message || 'Unable to load admin data.');
  }
}

function renderDevices() {
  const tbody = document.querySelector('#devices-table tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  state.deviceList.forEach((device) => {
    const row = document.createElement('tr');
    const displayName = device.name || '—';
    row.innerHTML = `
      <td><input class="input" type="text" value="${displayName}" data-device-code="${device.device_code}" style="width:120px; padding:4px 8px;" /></td>
      <td>${device.device_code}</td>
      <td>User</td>
      <td>${device.active ? '<span class="status-pill active">Active</span>' : '<span class="status-pill inactive">Revoked</span>'}</td>
      <td></td>
    `;
    const actionCell = row.querySelector('td:last-child');
    const nameInput = row.querySelector('input');
    
    const updateButton = document.createElement('button');
    updateButton.className = 'button';
    updateButton.textContent = 'Update';
    updateButton.style.marginRight = '8px';
    updateButton.addEventListener('click', async () => {
      const newName = nameInput.value.trim();
      try {
        await apiCall('updateDeviceName', { device_code: device.device_code, name: newName || null });
        await loadAdminData();
      } catch (error) {
        alert(error.message || 'Unable to update device name.');
      }
    });
    actionCell.appendChild(updateButton);
    
    if (device.active) {
      const revokeButton = document.createElement('button');
      revokeButton.className = 'button';
      revokeButton.textContent = 'Revoke';
      revokeButton.style.marginRight = '8px';
      revokeButton.addEventListener('click', async () => {
        await revokeDevice(device.device_code);
      });
      actionCell.appendChild(revokeButton);
    }
    
    const deleteButton = document.createElement('button');
    deleteButton.className = 'button';
    deleteButton.textContent = 'Delete';
    deleteButton.style.backgroundColor = '#dc2626';
    deleteButton.addEventListener('click', async () => {
      if (confirm('Are you sure you want to delete this device?')) {
        await deleteDevice(device.device_code);
      }
    });
    actionCell.appendChild(deleteButton);
    
    tbody.appendChild(row);
  });
}

function renderOtps() {
  const tbody = document.querySelector('#otps-table tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  state.otpList.forEach((otp) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${otp.code}</td>
      <td>${otp.redeemed_at ? 'Yes' : 'No'}</td>
      <td>${otp.redeemed_device_code || '—'}</td>
      <td>${new Date(otp.created_at).toLocaleString()}</td>
      <td></td>
    `;
    const actionCell = row.querySelector('td:last-child');
    const deleteButton = document.createElement('button');
    deleteButton.className = 'button';
    deleteButton.textContent = 'Delete';
    deleteButton.style.backgroundColor = '#dc2626';
    deleteButton.addEventListener('click', async () => {
      if (confirm('Are you sure you want to delete this OTP?')) {
        await deleteOtp(otp.code);
      }
    });
    actionCell.appendChild(deleteButton);
    tbody.appendChild(row);
  });
}

async function revokeDevice(deviceCode) {
  try {
    await apiCall('revokeDevice', { device_code: deviceCode });
    await loadAdminData();
  } catch (error) {
    renderBlocked(error.message || 'Unable to revoke the device.');
  }
}

async function deleteDevice(deviceCode) {
  try {
    await apiCall('deleteDevice', { device_code: deviceCode });
    await loadAdminData();
  } catch (error) {
    renderBlocked(error.message || 'Unable to delete the device.');
  }
}

async function deleteOtp(code) {
  try {
    await apiCall('deleteOtp', { code });
    await loadAdminData();
  } catch (error) {
    renderBlocked(error.message || 'Unable to delete the OTP.');
  }
}

function renderUnauthorizedVisits() {
  const tbody = document.querySelector('#visits-table tbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  state.unauthorizedVisits.forEach((visit) => {
    const row = document.createElement('tr');
    row.innerHTML = `
      <td>${visit.device_code}</td>
      <td>${new Date(visit.visited_at).toLocaleString()}</td>
      <td></td>
    `;
    const actionCell = row.querySelector('td:last-child');
    const deleteButton = document.createElement('button');
    deleteButton.className = 'button';
    deleteButton.textContent = 'Delete';
    deleteButton.style.backgroundColor = '#dc2626';
    deleteButton.addEventListener('click', async () => {
      if (confirm('Are you sure you want to delete this visit record?')) {
        await deleteVisit(visit.id);
      }
    });
    actionCell.appendChild(deleteButton);
    tbody.appendChild(row);
  });
}

async function deleteVisit(id) {
  try {
    await apiCall('deleteVisit', { id });
    await loadAdminData();
  } catch (error) {
    renderBlocked(error.message || 'Unable to delete the visit record.');
  }
}

async function ensureAdmin() {
  try {
    const result = await apiCall('checkAuth');
    state.authorized = result?.authorized === true;
    if (!state.authorized) {
      renderBlocked('This device is not the admin device.');
      return;
    }
    renderAdminPanel();
    await loadAdminData();
  } catch (error) {
    renderBlocked(error.message || 'Unable to verify admin status.');
  }
}

function init() {
  state.deviceCode = getOrCreateDeviceCode();
  ensureAdmin();
}

init();
