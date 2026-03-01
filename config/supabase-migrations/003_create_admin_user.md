# Create Admin User — Dallas

After applying migrations 001 and 002, create the admin user via the Supabase Dashboard.

## Steps

1. Go to **Supabase Dashboard** → Project `idorgloobxkmlnwnxbej`
2. Navigate to **Authentication** → **Users** → **Add User**
3. Enter:
   - Email: `<dallas-email>`
   - Password: `<strong-password>`
   - Check "Auto Confirm User"
4. After user is created, click on the user row
5. Go to the **Edit User** section and set `app_metadata`:
   ```json
   {
     "role": "admin"
   }
   ```
6. Set `user_metadata`:
   ```json
   {
     "display_name": "Dallas"
   }
   ```
7. Save.

## Verify

The `on_auth_user_created` trigger will auto-create a row in `public.profiles`
with `role = 'admin'` (read from `app_metadata.role`).

Check: `SELECT * FROM public.profiles;`

## Alternative: SQL (run in SQL Editor)

```sql
-- After creating the user via Dashboard, update their metadata:
UPDATE auth.users
SET raw_app_meta_data = raw_app_meta_data || '{"role": "admin"}'::jsonb,
    raw_user_meta_data = raw_user_meta_data || '{"display_name": "Dallas"}'::jsonb
WHERE email = '<dallas-email>';
```
