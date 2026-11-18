-- Rollback of 20270217000060_blog_generation_kill_switch_row.sql (c6). Deletes the blog_generation row ONLY if this
-- migration inserted it and nobody has edited it since (updated_by still the migration marker). A pre-existing row
-- (prod) or an admin-edited row is left alone. NOTE: after this rollback the blog routes fail CLOSED (403) if the row
-- is gone - roll the code back first.
DELETE FROM public.intelligence_global_config
 WHERE job_type = 'blog_generation'
   AND updated_by = 'migration:20270217000060';
