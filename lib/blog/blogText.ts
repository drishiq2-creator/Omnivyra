/**
 * Plain-text helpers for blog HTML. Moved out of pages/blogs.helpers.tsx (2026-11-20): modules under pages/ are
 * Next.js ROUTES, so that file was served at /blogs.helpers with a stub default export, and server-side content
 * code (lib/content/*) imported a page module (React + icons) just for this one function.
 */
export function wordCount(html: string) {
  return html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean).length;
}
