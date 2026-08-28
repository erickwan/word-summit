-- Remove the second throwaway row from testing the conflict-then-patch flow.
delete from public.push_subs where endpoint like 'https://test.invalid%';
