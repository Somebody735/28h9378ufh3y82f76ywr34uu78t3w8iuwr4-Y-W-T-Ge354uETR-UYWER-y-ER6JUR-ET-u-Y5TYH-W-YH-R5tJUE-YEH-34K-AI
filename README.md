# AI Chat with Supabase and z.ai

This repository contains a static GitHub Pages site for a secure AI chat experience and an admin console for issuing one-time access codes.

## What is included

- `index.html` — user-facing chatbot page
- `admin.html` — admin dashboard for managing one-time access codes and devices
- `style.css` — shared styling for both pages
- `script.js` — chat access and messaging logic
- `admin.js` — admin workflow and device/OTP management
- `supabase-config.js` — Supabase configuration placeholders
- `supabase/functions/api/index.js` — Supabase Edge Function backend for authorization and z.ai chat requests
- `supabase-schema.sql` — table schema for storing device codes and one-time passwords

## How it works

1. When a visitor opens the site for the first time, a unique device code is generated and stored in browser local storage.
2. The first visitor to claim admin status becomes the admin device.
3. Admin can create one-time passwords in `admin.html`.
4. A new user opens `index.html`, enters a one-time code, and the code is consumed and assigned to their device.
5. The browser stores both the device code and assigned password and sends them on every visit.
6. If the admin revokes a device, that device loses access.

## Setup instructions

### 1. Create a Supabase project

- Create a new Supabase project at https://app.supabase.com/
- Note the project URL and anon key
- Also note the service role key (for Supabase Edge Functions)

### 2. Set up the database tables

Use the SQL in `supabase-schema.sql` in your Supabase SQL editor.

### 3. Deploy the Supabase Edge Function

Install the Supabase CLI if you do not already have it:

```bash
npm install -g supabase
```

Log in and initialize if needed:

```bash
supabase login
supabase init
```

Deploy the `api` function from `supabase/functions/api`:

```bash
cd /path/to/repository
supabase functions deploy api
```

Set these environment variables for the function (SUPABASE_* are auto-provided, only set ZAI_*):

- `ZAI_API_KEY` — your z.ai API key
- `ZAI_API_URL` — the z.ai endpoint URL (optional; default: `https://api.z.ai/v1/chat/completions`)
- `ZAI_MODEL` — the model name (optional; default: `glm`)

Example using the CLI:

```bash
supabase secrets set ZAI_API_KEY=your-zai-api-key
supabase secrets set ZAI_API_URL=https://api.z.ai/v1/chat/completions
supabase secrets set ZAI_MODEL=glm
```

### 4. Configure the site

Open `supabase-config.js` and replace:

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `SUPABASE_FUNCTION_URL`

The function URL should look like:

```js
export const SUPABASE_FUNCTION_URL = 'https://your-project.supabase.co/functions/v1';
```

### 5. Deploy to GitHub Pages

1. Push this repository to GitHub on the `main` branch.
2. In repository Settings > Pages, select the branch `main` and the root folder.
3. Save and visit the published site.

## Admin flow

- Visit `admin.html` from the published site.
- The first device to visit the normal site and load `index.html` becomes the admin device.
- The admin page allows creation of one-time codes and revocation of active devices.

## User flow

- Open the main site at `index.html`.
- If the browser has no device code or access authorization, it will prompt for a one-time password.
- Enter the one-time code issued by the admin.
- If valid, the device is registered and the chat interface opens.

## Notes

- Device identity is stored in browser local storage.
- Clearing the browser data removes the device record and forces re-authentication.
- Only one device can use each one-time code.
- If you want stronger security, configure Supabase RLS and deploy the function behind a secure proxy.