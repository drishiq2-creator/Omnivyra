/**
 * pages/blogs.helpers.tsx and pages/blogs.types.ts were modules living under pages/, so Next.js served them as
 * ROUTES (/blogs.helpers, /blogs.types) via stub `export default () => null` pages, and server-side lib/content
 * imported a page module for wordCount (b3, 2026-11-20). They now live in lib/blog/; the dead helpers are deleted.
 */
import * as fs from 'fs';
import * as path from 'path';
import { wordCount } from '../../../lib/blog/blogText';

const ROOT = path.join(__dirname, '../../..');

describe('blog modules are no longer routes', () => {
  it.each(['pages/blogs.helpers.tsx', 'pages/blogs.types.ts'])('%s is gone', (rel) => {
    expect(fs.existsSync(path.join(ROOT, rel))).toBe(false);
  });

  it('control: the moved types module exists and has no stub default export', () => {
    const src = fs.readFileSync(path.join(ROOT, 'lib/blog/blogsTypes.ts'), 'utf8');
    expect(src).toMatch(/export interface BriefInsight/);
    expect(src).not.toMatch(/export default/);
  });

  it('wordCount behaves as before', () => {
    expect(wordCount('<p>Hello <b>big</b>   world</p>')).toBe(3);
    expect(wordCount('')).toBe(0);
  });
});
