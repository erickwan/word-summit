-- Removes the throwaway row the apps are pointed at while a change is being
-- tested in a browser, so testing can never touch a child's real progress.
-- Idempotent: it is a no-op once the row is gone.
delete from public.word_lab where id = 'SCRATCH-TEST';
