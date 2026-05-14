import { SUPABASE_FUNCTION_URL } from './supabase-config.js';

const DEVICE_STORAGE_KEY = 'ai-device-code';
const app = document.getElementById('admin-app');

const state = {
  deviceCode: '',
  authorized: false,
  loading: true,
  error: '',
  otpList: [],
  deviceList: [],
};

function getOrCreateDeviceCode() {
  let code = localStorage.getItem(DEVICE_STORAGE_KEY);
  if (!code) {
    code = crypto.randomUUID();
    localStorage.setItem(DEVICE_STORAGE_KEY, code);
  }
  return code;
}

async function apiCall(action, payload = {}) {
  const response = await fetch(`${SUPABASE_FUNCTION_URL}/api`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-device-code': state.deviceCode,
      'x-access-password': '',
    },
    body: JSON.stringify({ action, payload }),
  });

  const data = await response.json();
  if (!response.ok || data?.error) {
    throw new Error(data?.error || `Function request failed with status ${response.status}`);
  }
  return data;
}

function generateOtp() {
  return Array.from({ length: 8 }, () => Math.floor(Math.random() * 36).toString(36)).join('').toUpperCase();
}

function renderBlocked(message) {
  app.innerHTML = `
    <div class="section centered">
      <h1>Access Denied</h1>
      <p>${message || 'This device is not authorized to view the admin dashboard.'}</p>
      <a class="button" href="index.html">Go to Chat Home</a>
    </div>
  `;
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
          <table id="devices-table"><thead><tr><th>Device Code</th><th>Admin</th><th>Status</th><th>Actions</th></tr></thead><tbody></tbody></table>
        </div>
      </div>
      <div class="section">
        <h2>One-time Passwords</h2>
        <div class="table-wrapper">
          <table id="otps-table"><thead><tr><th>Code</th><th>Redeemed</th><th>Redeemed Device</th><th>Created</th></tr></thead><tbody></tbody></table>
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
    const [devices, otps] = await Promise.all([apiCall('listDevices'), apiCall('listOtps')]);
    state.deviceList = devices || [];
    state.otpList = otps || [];
    renderDevices();
    renderOtps();
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
    row.innerHTML = `
      <td>${device.device_code}</td>
      <td>${device.is_admin ? '<span class="status-pill active">Admin</span>' : 'User'}</td>
      <td>${device.active ? '<span class="status-pill active">Active</span>' : '<span class="status-pill inactive">Revoked</span>'}</td>
      <td></td>
    `;
    const actionCell = row.querySelector('td:last-child');
    if (!device.is_admin && device.active) {
      const button = document.createElement('button');
      button.className = 'button';
      button.textContent = 'Revoke';
      button.addEventListener('click', async () => {
        await revokeDevice(device.device_code);
      });
      actionCell.appendChild(button);
    } else {
      actionCell.textContent = '—';
    }
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
    `;
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

async function ensureAdmin() {
  try {
    const result = await apiCall('checkAuth');
    state.authorized = result?.authorized === true && result?.is_admin === true;
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
