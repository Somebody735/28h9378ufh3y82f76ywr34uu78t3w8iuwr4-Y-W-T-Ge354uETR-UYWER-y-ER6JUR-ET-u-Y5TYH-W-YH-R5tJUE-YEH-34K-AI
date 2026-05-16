import { serve } from 'https://deno.land/std@0.201.0/http/server.ts';
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js/+esm';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
const ZAI_API_KEY = Deno.env.get('ZAI_API_KEY');
const GEMINI_API_KEY = Deno.env.get('GEMINI_API_KEY');
const ADMIN_DEVICE_CODE = Deno.env.get('ADMIN_DEVICE_CODE');

// Model configuration - user will add models and endpoints here
const MODELS = {
  zai_glm: {
    name: 'ZAI GLM-4.7',
    provider: 'zai',
    model: 'glm-4.7-flash',
    url: 'https://api.z.ai/api/paas/v4/chat/completions',
    apiKey: ZAI_API_KEY,
  },
  zai_glm4: {
    name: 'ZAI GLM-4.5',
    provider: 'zai',
    model: 'glm-4.5-flash',
    url: 'https://api.z.ai/api/paas/v4/chat/completions',
    apiKey: ZAI_API_KEY,
  },
  gemini_pro: {
    name: 'Gemini Pro',
    provider: 'gemini',
    model: 'gemini-pro',
    url: 'https://generativelanguage.googleapis.com/v1beta/models/gemini-pro:generateContent',
    apiKey: GEMINI_API_KEY,
  },
};

// Fallback models for ZAI rate limit
const ZAI_FALLBACK_MODELS = ['zai_glm', 'zai_glm4'];

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const CORS_HEADERS = {
  'Content-Type': 'application/json',
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey, x-device-code, x-access-password',
};

async function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: CORS_HEADERS,
  });
}

function optionsResponse() {
  return new Response(null, {
    status: 204,
    headers: {
      ...CORS_HEADERS,
      'Content-Length': '0',
    },
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
  const isAdmin = deviceCode === ADMIN_DEVICE_CODE;
  if (isAdmin) {
    return { device_code: deviceCode, is_admin: true, active: true };
  }
  const { data, error } = await supabase
    .from('device_codes')
    .select('device_code,active')
    .eq('device_code', deviceCode)
    .eq('access_password', accessPassword || '')
    .single();
  if (error || !data || !data.active) {
    return null;
  }
  return { ...data, is_admin: false };
}

async function handleClaimAdminIfMissing(payload) {
  return jsonResponse({ ok: true, message: 'Admin is now set via ADMIN_DEVICE_CODE environment variable' });
}

async function handleCheckAuth(request) {
  const deviceCode = request.headers.get('x-device-code');
  const accessPassword = request.headers.get('x-access-password');
  const device = await verifyDevice(deviceCode, accessPassword);
  if (!device) {
    await supabase.from('unauthorized_visits').insert({ device_code: deviceCode });
  }
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

  // Get model to use - admin can override, others use default
  let modelKey = payload?.model;
  if (!modelKey || !MODELS[modelKey]) {
    // Get default model from settings
    const { data: settingData } = await supabase.from('settings').select('value').eq('key', 'default_model').single();
    modelKey = settingData?.value || 'zai_glm';
  }

  const modelConfig = MODELS[modelKey];
  if (!modelConfig) {
    return jsonResponse({ error: 'Invalid model configuration.' }, 500);
  }

  // Try the requested model with fallback for ZAI rate limit
  let result;
  let lastError;
  
  if (modelConfig.provider === 'zai') {
    // Try the requested model first
    result = await tryZaiModel(modelConfig, messages);
    
    // If rate limit error, try fallback models
    if (result?.error?.includes('1302') || result?.error?.includes('Rate limit')) {
      for (const fallbackKey of ZAI_FALLBACK_MODELS) {
        if (fallbackKey !== modelKey && MODELS[fallbackKey]) {
          result = await tryZaiModel(MODELS[fallbackKey], messages);
          if (!result?.error) break;
        }
      }
    }
  } else if (modelConfig.provider === 'gemini') {
    result = await tryGeminiModel(modelConfig, messages);
  } else {
    return jsonResponse({ error: 'Unsupported model provider.' }, 500);
  }

  if (result?.error) {
    return jsonResponse({ error: result.error }, 500);
  }

  return jsonResponse({ assistant: result.assistant });
}

async function tryZaiModel(modelConfig, messages) {
  const body = {
    model: modelConfig.model,
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
  };

  const response = await fetch(modelConfig.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${modelConfig.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    return { error: `ZAI error: ${errorText}` };
  }

  const result = await response.json();
  const assistant = result?.choices?.[0]?.message?.content || result?.output?.[0]?.content || result?.response || JSON.stringify(result);
  return { assistant };
}

async function tryGeminiModel(modelConfig, messages) {
  const body = {
    contents: messages.map((message) => ({
      role: message.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: message.content }],
    })),
  };

  const url = `${modelConfig.url}?key=${modelConfig.apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    return { error: `Gemini error: ${errorText}` };
  }

  const result = await response.json();
  const assistant = result?.candidates?.[0]?.content?.parts?.[0]?.text || JSON.stringify(result);
  return { assistant };
}

async function handleGetModels(request) {
  const models = Object.keys(MODELS).map((key) => ({
    key,
    name: MODELS[key].name,
    provider: MODELS[key].provider,
  }));
  return jsonResponse({ models });
}

async function handleGetDefaultModel(request) {
  const { data: settingData } = await supabase.from('settings').select('value').eq('key', 'default_model').single();
  const defaultModel = settingData?.value || 'zai_glm';
  return jsonResponse({ defaultModel });
}

async function handleSetDefaultModel(request, payload) {
  const deviceCode = request.headers.get('x-device-code');
  const accessPassword = request.headers.get('x-access-password');
  const device = await verifyDevice(deviceCode, accessPassword);
  if (!device?.is_admin) {
    return jsonResponse({ error: 'Admin required.' }, 403);
  }
  const modelKey = payload?.model;
  if (!modelKey || !MODELS[modelKey]) {
    return jsonResponse({ error: 'Invalid model key.' }, 400);
  }
  const { error } = await supabase.from('settings').upsert({
    key: 'default_model',
    value: modelKey,
    updated_at: new Date().toISOString(),
  }, { onConflict: 'key' });
  if (error) {
    return jsonResponse({ error: error.message }, 500);
  }
  return jsonResponse({ ok: true });
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
    .select('device_code,name,active,created_at')
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

async function handleUpdateDeviceName(request, payload) {
  const deviceCode = request.headers.get('x-device-code');
  const accessPassword = request.headers.get('x-access-password');
  const device = await verifyDevice(deviceCode, accessPassword);
  if (!device?.is_admin) {
    return jsonResponse({ error: 'Admin required.' }, 403);
  }
  const targetDevice = payload?.device_code;
  const name = payload?.name;
  if (!targetDevice) {
    return jsonResponse({ error: 'Target device code is required.' }, 400);
  }
  const { error } = await supabase.from('device_codes').update({ name, updated_at: new Date().toISOString() }).eq('device_code', targetDevice);
  if (error) {
    return jsonResponse({ error: error.message }, 500);
  }
  return jsonResponse({ ok: true });
}

async function handleDeleteDevice(request, payload) {
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
  const { error } = await supabase.from('device_codes').delete().eq('device_code', targetDevice);
  if (error) {
    return jsonResponse({ error: error.message }, 500);
  }
  return jsonResponse({ ok: true });
}

async function handleDeleteOtp(request, payload) {
  const deviceCode = request.headers.get('x-device-code');
  const accessPassword = request.headers.get('x-access-password');
  const device = await verifyDevice(deviceCode, accessPassword);
  if (!device?.is_admin) {
    return jsonResponse({ error: 'Admin required.' }, 403);
  }
  const code = payload?.code;
  if (!code) {
    return jsonResponse({ error: 'OTP code is required.' }, 400);
  }
  const { error } = await supabase.from('one_time_passwords').delete().eq('code', code);
  if (error) {
    return jsonResponse({ error: error.message }, 500);
  }
  return jsonResponse({ ok: true });
}

async function handleListUnauthorizedVisits(request) {
  const deviceCode = request.headers.get('x-device-code');
  const accessPassword = request.headers.get('x-access-password');
  const device = await verifyDevice(deviceCode, accessPassword);
  if (!device?.is_admin) {
    return jsonResponse({ error: 'Admin required.' }, 403);
  }
  const { data, error } = await supabase.from('unauthorized_visits').select('*').order('visited_at', { ascending: false });
  if (error) {
    return jsonResponse({ error: error.message }, 500);
  }
  return jsonResponse(data);
}

async function handleTrackUnauthorizedVisit(request) {
  const deviceCode = request.headers.get('x-device-code');
  if (!deviceCode) {
    return jsonResponse({ ok: true });
  }
  await supabase.from('unauthorized_visits').insert({ device_code: deviceCode });
  
  // Limit logs to 1000 entries by deleting oldest ones
  const { data: countData } = await supabase.from('unauthorized_visits').select('id', { count: 'exact', head: true });
  const count = countData?.count || 0;
  if (count > 1000) {
    const { data: oldestData } = await supabase
      .from('unauthorized_visits')
      .select('id')
      .order('visited_at', { ascending: true })
      .limit(count - 1000);
    if (oldestData && oldestData.length > 0) {
      const idsToDelete = oldestData.map(v => v.id);
      await supabase.from('unauthorized_visits').delete().in('id', idsToDelete);
    }
  }
  
  return jsonResponse({ ok: true });
}

async function handleDeleteVisit(request, payload) {
  const deviceCode = request.headers.get('x-device-code');
  const accessPassword = request.headers.get('x-access-password');
  const device = await verifyDevice(deviceCode, accessPassword);
  if (!device?.is_admin) {
    return jsonResponse({ error: 'Admin required.' }, 403);
  }
  const id = payload?.id;
  if (!id) {
    return jsonResponse({ error: 'Visit ID is required.' }, 400);
  }
  const { error } = await supabase.from('unauthorized_visits').delete().eq('id', id);
  if (error) {
    return jsonResponse({ error: error.message }, 500);
  }
  return jsonResponse({ ok: true });
}

async function handleClearAllVisits(request) {
  const deviceCode = request.headers.get('x-device-code');
  const accessPassword = request.headers.get('x-access-password');
  const device = await verifyDevice(deviceCode, accessPassword);
  if (!device?.is_admin) {
    return jsonResponse({ error: 'Admin required.' }, 403);
  }
  const { error } = await supabase.from('unauthorized_visits').delete().neq('id', 0);
  if (error) {
    return jsonResponse({ error: error.message }, 500);
  }
  return jsonResponse({ ok: true });
}

serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return optionsResponse();
  }
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
    case 'updateDeviceName':
      return handleUpdateDeviceName(request, payload);
    case 'deleteDevice':
      return handleDeleteDevice(request, payload);
    case 'deleteOtp':
      return handleDeleteOtp(request, payload);
    case 'listUnauthorizedVisits':
      return handleListUnauthorizedVisits(request);
    case 'trackUnauthorizedVisit':
      return handleTrackUnauthorizedVisit(request);
    case 'deleteVisit':
      return handleDeleteVisit(request, payload);
    case 'clearAllVisits':
      return handleClearAllVisits(request);
    case 'getModels':
      return handleGetModels(request);
    case 'getDefaultModel':
      return handleGetDefaultModel(request);
    case 'setDefaultModel':
      return handleSetDefaultModel(request, payload);
    default:
      return jsonResponse({ error: `Unknown action: ${action}` }, 400);
  }
});
