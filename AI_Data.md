## Change Supabase Edge Function environment

You need to set the function secrets / environment variables in Supabase, not in supabase-config.js.

### Option 1: Supabase CLI

Run from your repo folder:

```bash
supabase login
supabase link --project-ref <your-project-ref>
supabase secrets set SUPABASE_URL=https://your-project.supabase.co
supabase secrets set SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
supabase secrets set ZAI_API_KEY=your-zai-api-key
supabase secrets set ZAI_API_URL=https://api.z.ai/v1/chat/completions
supabase secrets set ZAI_MODEL=glm
```

### Option 2: Supabase dashboard

1. Open your Supabase project.
2. Go to `Functions`.
3. Find the `Secrets` section.
4. Add/replace:
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `ZAI_API_KEY`
   - `ZAI_API_URL`
   - `ZAI_MODEL`

### Notes

- In index.js, the code reads:
  - `Deno.env.get('SUPABASE_URL')`
  - `Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')`
  - `Deno.env.get('ZAI_API_KEY')`
  - `Deno.env.get('ZAI_API_URL')`
  - `Deno.env.get('ZAI_MODEL')`
- `SUPABASE_ANON_KEY` stays in supabase-config.js for the browser client.
- After updating secrets, your function will use the new values on the next invocation.