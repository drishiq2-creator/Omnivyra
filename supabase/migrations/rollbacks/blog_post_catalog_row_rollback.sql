-- Rollback of 20270217000058_blog_post_catalog_row.sql (c6). Deletes ONLY the catalog row 058 wrote (description marker).
DELETE FROM public.credit_cost_config
 WHERE action_type = 'blog_post'
   AND description = 'Blog post, fixed per blog (20270217000058)';
