/**
 * @jest-environment jsdom
 *
 * Admin-only pages render what the SERVER said (owner ruling 2026-11-20): the page for an admin, "Only company admins
 * can manage this" for a member, and an honest "couldn't check" + Retry for anything that is not an answer (Rule 1:
 * a failed check is never shown as "not allowed", and never as the page).
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

let mockCompanyId = 'co-A';
jest.mock('../../../components/CompanyContext', () => ({ useCompanyContext: () => ({ selectedCompanyId: mockCompanyId }) }));
jest.mock('next/link', () => ({ __esModule: true, default: ({ href, children, ...p }: any) => <a href={href} {...p}>{children}</a> }));

import CompanyAdminOnly, { ACCESS_UNAVAILABLE_MESSAGE } from '../../../components/shared/CompanyAdminOnly';
import { COMPANY_ADMIN_REQUIRED, COMPANY_ADMIN_REQUIRED_MESSAGE } from '../../../shared/auth/companyAdminRequired';

const reply = (status: number, body: unknown) => Promise.resolve({ ok: status < 400, status, json: async () => body });
function stub(...answers: Array<() => Promise<unknown>>) {
  const queue = [...answers];
  (global as any).fetch = jest.fn(() => (queue.length > 1 ? queue.shift()! : queue[0])());
}
const PAGE = <CompanyAdminOnly><div data-testid="page">website setup</div></CompanyAdminOnly>;

afterEach(() => { delete (global as any).fetch; mockCompanyId = 'co-A'; });

describe('CompanyAdminOnly', () => {
  it('CONTROL: an admin (200 {admin:true}) sees the page, after a neutral checking state', async () => {
    stub(() => reply(200, { admin: true }));
    render(PAGE);
    expect(screen.getByTestId('company-admin-checking')).toBeInTheDocument();
    expect(await screen.findByTestId('page')).toBeInTheDocument();
    expect((global as any).fetch).toHaveBeenCalledWith('/api/company-admin/access?company_id=co-A', { credentials: 'include' });
  });

  it('a member (403 COMPANY_ADMIN_REQUIRED) sees the admin-only copy, NOT the page', async () => {
    stub(() => reply(403, { error: 'FORBIDDEN_ROLE', code: COMPANY_ADMIN_REQUIRED, message: COMPANY_ADMIN_REQUIRED_MESSAGE }));
    render(PAGE);
    expect(await screen.findByText(COMPANY_ADMIN_REQUIRED_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByTestId('page')).not.toBeInTheDocument();
  });

  it.each<[string, () => Promise<unknown>]>([
    ['a 500', () => reply(500, { error: 'boom' })],
    ['a non-member 403', () => reply(403, { error: 'COMPANY_ACCESS_DENIED' })],
    ['a 401', () => reply(401, { code: 'UNAUTHENTICATED' })],
    ['a malformed 200', () => reply(200, { ok: true })],
    ['a network error', () => Promise.reject(new Error('offline'))],
  ])('%s is NOT an answer: "couldn\'t check" + Retry, neither the page nor "admins only"', async (_n, answer) => {
    stub(answer);
    render(PAGE);
    expect(await screen.findByText(ACCESS_UNAVAILABLE_MESSAGE)).toBeInTheDocument();
    expect(screen.queryByTestId('page')).not.toBeInTheDocument();
    expect(screen.queryByText(COMPANY_ADMIN_REQUIRED_MESSAGE)).not.toBeInTheDocument();
  });

  it('Retry asks again and shows the new answer', async () => {
    stub(() => reply(500, {}), () => reply(200, { admin: true }));
    render(PAGE);
    fireEvent.click(await screen.findByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('page')).toBeInTheDocument();
    expect((global as any).fetch).toHaveBeenCalledTimes(2);
  });

  it('no company selected: nothing to check, the page renders its own state, no request', async () => {
    mockCompanyId = '';
    stub(() => reply(200, { admin: true }));
    render(PAGE);
    expect(screen.getByTestId('page')).toBeInTheDocument();
    expect((global as any).fetch).not.toHaveBeenCalled();
  });

  it('a company switch mid-flight never shows the OLD company\'s answer', async () => {
    let releaseA!: (v: unknown) => void;
    (global as any).fetch = jest.fn((url: string) =>
      url.includes('co-A') ? new Promise((r) => { releaseA = r; }) : reply(403, { code: COMPANY_ADMIN_REQUIRED }));
    const { rerender } = render(PAGE);
    mockCompanyId = 'co-B';
    rerender(<CompanyAdminOnly><div data-testid="page">website setup</div></CompanyAdminOnly>);
    expect(await screen.findByText(COMPANY_ADMIN_REQUIRED_MESSAGE)).toBeInTheDocument();
    await act(async () => { releaseA({ ok: true, status: 200, json: async () => ({ admin: true }) }); });
    await waitFor(() => expect(screen.queryByTestId('page')).not.toBeInTheDocument());
    expect(screen.getByText(COMPANY_ADMIN_REQUIRED_MESSAGE)).toBeInTheDocument();
  });
});
