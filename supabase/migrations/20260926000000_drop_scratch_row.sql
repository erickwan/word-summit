-- Clears the throwaway row the apps are pointed at during browser testing.
-- Runs again whenever testing leaves one behind; a no-op when it does not.
delete from public.word_lab where id = 'SCRATCH-TEST';
