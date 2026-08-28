-- Remove the throwaway row created while testing the push_subs RLS policies.
delete from public.push_subs where endpoint like 'https://test.invalid%';
