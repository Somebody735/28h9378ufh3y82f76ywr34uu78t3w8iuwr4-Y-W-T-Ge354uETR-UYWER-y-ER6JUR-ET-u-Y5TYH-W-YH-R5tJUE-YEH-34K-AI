import { serve } from 'https://deno.land/std@0.201.0/http/server.ts';
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const ZAI_API_KEY = Deno.env.get('ZAI_API_KEY');
const ZAI_API_URL = Deno.env.get('ZAI_API_URL') || 'https://api.z.ai/v1/chat/completions';
const ZAI_MODEL = Deno.env.get('ZAI_MODEL') || 'glm';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

async function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function parseRequest(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

async function verifyDevice(deviceCode, accessPassword) {
  if (!deviceCode) return null;
  const { data, error } = await supabase
    .from('device_codes')
    .select('device_code,is_admin,active')
    .eq('device_code', deviceCode)
    .eq('access_password', accessPassword || '')
    .single();
  if (error || !data || !data.active) {
    return null;
  }
  return data;
}

async function handleClaimAdminIfMissing(payload) {
  const deviceCode = payload?.device_code;
  if (!deviceCode) {
    return jsonResponse({ error: 'Missing device_code for claimAdminIfMissing' }, 400);
  }
  const { data: currentAdmin } = await supabase.from('device_codes').select('device_code').eq('is_admin', true).limit(1).single();
  if (currentAdmin?.device_code) {
    return jsonResponse({ ok: true, message: 'Admin already exists' });
  }
  const { error } = await supabase.from('device_codes').upsert({
    device_code: deviceCode,
    access_password: '',
    active: true,
    is_admin: true,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }, { onConflict: 'device_code' });
  if (error) {
    return jsonResponse({ error: error.message }, 500);
  }
  return jsonResponse({ ok: true, message: 'Admin device registered' });
}

async function handleCheckAuth(request) {
  const deviceCode = request.headers.get('x-device-code');
  const accessPassword = request.headers.get('x-access-password');
  const device = await verifyDevice(deviceCode, accessPassword);
  return jsonResponse({ authorized: !!device, is_admin: !!device?.is_admin });
}

async function handleRedeemOtp(request, payload) {
  const deviceCode = request.headers.get('x-device-code');
  const otp = payload?.otp?.trim();
  if (!deviceCode || !otp) {
    return jsonResponse({ error: 'Missing device code or OTP.' }, 400);
  }

  const { data: foundOtp, error: otpError } = await supabase
    .from('one_time_passwords')
    .select('*')
    .eq('code', otp)
    .single();

  if (otpError || !foundOtp) {
    return jsonResponse({ error: 'Invalid or expired code.' }, 400);
  }
  if (foundOtp.redeemed_at) {
    return jsonResponse({ error: 'This access code has already been used.' }, 400);
  }

  const now = new Date().toISOString();
  const { error: upsertError } = await supabase.from('device_codes').upsert({
    device_code: deviceCode,
    access_password: otp,
    active: true,
    is_admin: false,
    created_at: now,
    updated_at: now,
  }, { onConflict: 'device_code' });

  if (upsertError) {
    return jsonResponse({ error: upsertError.message }, 500);
  }

  const { error: updateError } = await supabase.from('one_time_passwords').update({
    redeemed_at: now,
    redeemed_device_code: deviceCode,
  }).eq('code', otp);

  if (updateError) {
    return jsonResponse({ error: updateError.message }, 500);
  }

  return jsonResponse({ ok: true });
}

async function handleChat(request, payload) {
  const deviceCode = request.headers.get('x-device-code');
  const accessPassword = request.headers.get('x-access-password');
  const device = await verifyDevice(deviceCode, accessPassword);
  if (!device) {
    return jsonResponse({ error: 'Unauthorized chat request.' }, 403);
  }
  const messages = payload?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return jsonResponse({ error: 'Missing chat history.' }, 400);
  }

  const body = {
    model: ZAI_MODEL,
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
  };

  const response = await fetch(ZAI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ZAI_API_KEY}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    return jsonResponse({ error: `ZAI error: ${errorText}` }, 500);
  }

  const result = await response.json();
  const assistant = result?.choices?.[0]?.message?.content || result?.output?.[0]?.content || result?.response || JSON.stringify(result);
  return jsonResponse({ assistant });
}

async function handleListOtps(request) {
  const deviceCode = request.headers.get('x-device-code');
  const accessPassword = request.headers.get('x-access-password');
  const device = await verifyDevice(deviceCode, accessPassword);
  if (!device?.is_admin) {
    return jsonResponse({ error: 'Admin required.' }, 403);
  }
  const { data, error } = await supabase.from('one_time_passwords').select('*').order('created_at', { ascending: false });
  if (error) {
    return jsonResponse({ error: error.message }, 500);
  }
  return jsonResponse(data);
}

async function handleCreateOtp(request, payload) {
  const deviceCode = request.headers.get('x-device-code');
  const accessPassword = request.headers.get('x-access-password');
  const device = await verifyDevice(deviceCode, accessPassword);
  if (!device?.is_admin) {
    return jsonResponse({ error: 'Admin required.' }, 403);
  }
  const code = payload?.code?.trim();
  if (!code) {
    return jsonResponse({ error: 'OTP code is required.' }, 400);
  }
  const now = new Date().toISOString();
  const { error } = await supabase.from('one_time_passwords').insert({
    code,
    created_at: now,
  });
  if (error) {
    return jsonResponse({ error: error.message }, 500);
  }
  return jsonResponse({ ok: true });
}

async function handleListDevices(request) {
  const deviceCode = request.headers.get('x-device-code');
  const accessPassword = request.headers.get('x-access-password');
  const device = await verifyDevice(deviceCode, accessPassword);
  if (!device?.is_admin) {
    return jsonResponse({ error: 'Admin required.' }, 403);
  }
  const { data, error } = await supabase
    .from('device_codes')
    .select('device_code,is_admin,active,created_at')
    .order('created_at', { ascending: false });
  if (error) {
    return jsonResponse({ error: error.message }, 500);
  }
  return jsonResponse(data);
}

async function handleRevokeDevice(request, payload) {
  const deviceCode = request.headers.get('x-device-code');
  const accessPassword = request.headers.get('x-access-password');
  const device = await verifyDevice(deviceCode, accessPassword);
  if (!device?.is_admin) {
    return jsonResponse({ error: 'Admin required.' }, 403);
  }
  const targetDevice = payload?.device_code;
  if (!targetDevice) {
    return jsonResponse({ error: 'Target device code is required.' }, 400);
  }
  const { error } = await supabase.from('device_codes').update({ active: false, updated_at: new Date().toISOString() }).eq('device_code', targetDevice);
  if (error) {
    return jsonResponse({ error: error.message }, 500);
  }
  return jsonResponse({ ok: true });
}

serve(async (request) => {
  if (request.method !== 'POST') {
    return jsonResponse({ error: 'Only POST requests are supported.' }, 405);
  }
  const body = await parseRequest(request);
  const action = body?.action;
  const payload = body?.payload || {};

  switch (action) {
    case 'claimAdminIfMissing':
      return handleClaimAdminIfMissing(payload);
    case 'checkAuth':
      return handleCheckAuth(request);
    case 'redeemOtp':
      return handleRedeemOtp(request, payload);
    case 'chat':
      return handleChat(request, payload);
    case 'listOtps':
      return handleListOtps(request);
    case 'createOtp':
      return handleCreateOtp(request, payload);
    case 'listDevices':
      return handleListDevices(request);
    case 'revokeDevice':
      return handleRevokeDevice(request, payload);
    default:
      return jsonResponse({ error: `Unknown action: ${action}` }, 400);
  }
});
