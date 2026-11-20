import React, { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { ArrowLeft, Shield, UserPlus, Users, RefreshCw } from 'lucide-react';
import { getAuthToken } from '../utils/getAuthToken';
import { useCompanyContext } from '../components/CompanyContext';
import { fetchWithAuth } from '../components/community-ai/fetchWithAuth';
import { emitSetupChanged } from '../lib/setup/setupEvents';
import {
  HeldIdempotencyKeys,
  classifyTeamMutation,
  teamLoadFailureMessage,
  submissionSignature,
  unknownOutcomeMessage,
  type TeamMutationKind,
  type TeamMutationOutcome,
} from '../lib/team/teamMutationOutcome';

// /api/company/users is guarded by withIdempotency (POST/PUT/DELETE) and 400s
// without this header. It replays the stored response only for a key it has
// already completed, so a key is minted once per SUBMISSION and held until the
// server has answered (HeldIdempotencyKeys, lib/team/teamMutationOutcome.ts).
// That avoids a second run when a lost response is followed by the same
// submission; it is not a promise that a re-send is harmless (see that file).
function newIdempotencyKey(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  } catch { /* fall through */ }
  return `team-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

type TeamMember = {
  user_id?: string;
  id?: string;
  name?: string;
  email: string;
  role: string;
  status?: string;
  created_at: string;
};

const roleOptions = [
  { id: 'COMPANY_ADMIN', name: 'Company Admin', description: 'Manage users and permissions' },
  { id: 'CONTENT_CREATOR', name: 'Content Creator', description: 'Create content' },
  { id: 'CONTENT_REVIEWER', name: 'Content Reviewer', description: 'Approve content' },
  { id: 'CONTENT_PUBLISHER', name: 'Content Publisher', description: 'Publish content' },
  { id: 'VIEW_ONLY', name: 'View Only', description: 'View content' },
];

export default function TeamManagement() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState('members');
  const [isLoading, setIsLoading] = useState(false);
  const [teamMembers, setTeamMembers] = useState<TeamMember[]>([]);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [inviteForm, setInviteForm] = useState({
    name: '',
    email: '',
    role: 'CONTENT_CREATOR',
  });
  const [roleNotice, setRoleNotice] = useState('');
  const [toastMessage, setToastMessage] = useState('');
  // F23: a failed roster read is shown as a failure (persistent, with Retry), never as "No users yet".
  const [usersLoadError, setUsersLoadError] = useState<string | null>(null);
  // F25: an unknown mutation outcome stays on screen until the user acts (the toast auto-dismisses in 4s).
  const [outcomeNotice, setOutcomeNotice] = useState('');
  const heldKeys = useRef(new HeldIdempotencyKeys(newIdempotencyKey));
  // The exact invite body whose outcome is unknown; non-null = the invite form is locked (see sendInvitation).
  const [pendingInvite, setPendingInvite] = useState<Record<string, unknown> | null>(null);
  const [inviteModalMessage, setInviteModalMessage] = useState<{ tone: 'error' | 'unknown'; text: string } | null>(null);

  const { selectedCompanyId, selectedCompanyName, userRole, isAuthenticated, refreshCompanies } = useCompanyContext();
  const canManage =
    userRole === 'COMPANY_ADMIN' ||
    userRole === 'SUPER_ADMIN' ||
    userRole === 'ADMIN';


  const loadUsers = async () => {
    if (!selectedCompanyId) return;
    setIsLoading(true);
    try {
      const response = await fetchWithAuth(
        `/api/company/users?companyId=${selectedCompanyId}&ts=${Date.now()}`,
        { cache: 'no-store' }
      );
      const data = await response.json().catch(() => null);
      if (!response.ok || !data) {
        const errorCode = data?.error || 'FAILED_TO_LIST_USERS';
        console.error('[team-management] roster read failed:', response.status, errorCode);
        // Cleared so another company's roster can't stay on screen; the error (not "No users yet") is what renders.
        setTeamMembers([]);
        setUsersLoadError(teamLoadFailureMessage(response.status, data));
        if (errorCode === 'FORBIDDEN_ROLE' || errorCode === 'COMPANY_ACCESS_DENIED') {
          refreshCompanies?.();
        }
        return;
      }
      setUsersLoadError(null);
      const users = (data.users || []).map((row: any) => ({
        user_id: row.user_id,
        name: row.name || '',
        email: row.email || '',
        role: row.role,
        status: row.status || 'active',
        created_at: row.created_at,
      }));
      setTeamMembers(users);
      // Canonical Setup event — the roster changed (invite / role / remove /
      // deactivate all refresh via loadUsers). Setup's Team category re-evaluates.
      emitSetupChanged('team-changed');
    } catch (error: any) {
      console.error('Error loading users:', error);
      setTeamMembers([]);
      setUsersLoadError(teamLoadFailureMessage(null, null));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    if (!toastMessage) return;
    const timer = window.setTimeout(() => {
      setToastMessage('');
    }, 4000);
    return () => window.clearTimeout(timer);
  }, [toastMessage]);

  useEffect(() => {
    // A notice or load error belongs to the company it was about.
    setOutcomeNotice('');
    setUsersLoadError(null);
    if (!isAuthenticated) {
      setTeamMembers([]);
      setRoleNotice('');
      return;
    }
    if (!selectedCompanyId) {
      setRoleNotice('Select a company first');
      return;
    }
    setRoleNotice('');
    loadUsers();
  }, [isAuthenticated, selectedCompanyId]);

  /**
   * Every team mutation goes through here (F24/F25). The key is held per submission until the server has answered;
   * an unknown outcome claims nothing, re-reads the team list and leaves a notice that does not auto-dismiss.
   */
  const runTeamMutation = async (
    kind: TeamMutationKind,
    method: 'POST' | 'PUT' | 'DELETE',
    body: Record<string, unknown>,
  ): Promise<TeamMutationOutcome> => {
    const signature = submissionSignature(method, body);
    let status: number | null = null;
    let payload: unknown = null;
    try {
      const response = await fetchWithAuth('/api/company/users', {
        method,
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': heldKeys.current.keyFor(signature) },
        body: JSON.stringify(body),
      });
      status = response.status;
      payload = await response.json().catch(() => null);
    } catch (error) {
      console.error(`[team-management] ${kind} request did not complete:`, error);
      status = null;
    }
    const outcome = classifyTeamMutation(kind, status, payload);
    heldKeys.current.record(signature, outcome);
    // The invite modal shows its own outcome (it sits over the page toast and notice).
    if (outcome.kind === 'refused' && kind !== 'invite') setToastMessage(outcome.message);
    if (outcome.kind === 'unknown') {
      if (kind !== 'invite') setOutcomeNotice(unknownOutcomeMessage(kind, outcome));
      loadUsers();
    }
    return outcome;
  };

  /**
   * Invite lock (b3, 2026-11-20). After an UNKNOWN outcome the exact submitted body is kept in `pendingInvite` and
   * the form is read-only: the only action is "Check and send", which re-sends THAT body with the held key. The
   * server then replays (completed row) or re-runs; createInvitation and the email job are both keyed off the
   * request key (invitationService findExistingByIdempotencyKey, emailJobsService `${key}:email:magic_link`), so a
   * keyed re-run does not send a second email. Only a definitive answer (2xx done, 4xx refused) unlocks. Editing
   * would change the body, mint a new key, and run normalizeInvitationState + a second email, so it is impossible
   * while locked. Cancel closes the modal and keeps the lock.
   */
  const sendInvitation = async () => {
    const body = pendingInvite ?? (inviteForm.email && inviteForm.role && selectedCompanyId
      ? { name: inviteForm.name, email: inviteForm.email, role: inviteForm.role, companyId: selectedCompanyId }
      : null);
    if (!body) return;
    setIsLoading(true);
    setInviteModalMessage(null);
    try {
      const outcome = await runTeamMutation('invite', 'POST', body);
      if (outcome.kind === 'done') {
        setPendingInvite(null);
        setInviteForm({ name: '', email: '', role: 'CONTENT_CREATOR' });
        setShowInviteModal(false);
        setOutcomeNotice('');
        setToastMessage(typeof outcome.body.message === 'string' ? outcome.body.message : 'Invitation sent');
        loadUsers();
      } else if (outcome.kind === 'refused') {
        setPendingInvite(null);
        setInviteModalMessage({ tone: 'error', text: outcome.message });
      } else {
        setPendingInvite(body);
        setInviteModalMessage({ tone: 'unknown', text: unknownOutcomeMessage('invite', outcome) });
      }
    } finally {
      setIsLoading(false);
    }
  };
  const inviteLocked = pendingInvite !== null;
  const editInviteForm = (patch: Partial<typeof inviteForm>) => {
    if (inviteLocked) return; // read-only while the outcome is unknown
    setInviteForm((prev) => ({ ...prev, ...patch }));
  };

  const updateUserRole = async (userId: string, role: string) => {
    if (!selectedCompanyId) return;
    setIsLoading(true);
    try {
      const outcome = await runTeamMutation('role', 'PUT', { companyId: selectedCompanyId, role, userId });
      if (outcome.kind === 'done') loadUsers();
    } finally {
      setIsLoading(false);
    }
  };

  const reinviteUser = async (email: string, role: string, name?: string) => {
    if (!selectedCompanyId) return;
    setIsLoading(true);
    try {
      const outcome = await runTeamMutation('reinvite', 'POST', { email, role, name, companyId: selectedCompanyId });
      if (outcome.kind === 'done') {
        setToastMessage(typeof outcome.body.message === 'string' ? outcome.body.message : 'Reinvite sent');
        loadUsers();
      }
    } finally {
      setIsLoading(false);
    }
  };

  const deactivateUser = async (userId: string, role: string) => {
    if (!selectedCompanyId) return;
    setIsLoading(true);
    try {
      const outcome = await runTeamMutation('deactivate', 'PUT', {
        companyId: selectedCompanyId, role, userId, status: 'inactive',
      });
      if (outcome.kind === 'done') {
        setToastMessage('User deactivated');
        loadUsers();
      }
    } finally {
      setIsLoading(false);
    }
  };

  const removeUser = async (userId: string) => {
    if (!selectedCompanyId) return;
    if (!window.confirm('Remove this user from the company?')) return;
    setIsLoading(true);
    try {
      const outcome = await runTeamMutation('remove', 'DELETE', { companyId: selectedCompanyId, userId });
      if (outcome.kind === 'done') {
        setToastMessage('User removed');
        loadUsers();
      }
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-gradient-to-br from-indigo-100 via-purple-100 to-pink-100">
      <div className="bg-gradient-to-r from-indigo-200/90 via-purple-200/90 to-pink-200/90 backdrop-blur-sm border-b border-purple-300/50 shadow-lg">
        <div className="max-w-7xl mx-auto px-6 py-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-4">
              <button
                onClick={() => router.push('/team-management')}
                className="p-2 hover:bg-gray-100 rounded-lg transition-colors"
              >
                <ArrowLeft className="h-5 w-5 text-gray-600" />
              </button>
              <div>
                <h1 className="text-3xl font-bold bg-gradient-to-r from-indigo-600 to-purple-600 bg-clip-text text-transparent">
                  Team Management
                </h1>
                <p className="text-gray-600 mt-1">
                  {selectedCompanyName ? `Company: ${selectedCompanyName}` : 'Manage your team members'}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-3">
              <button
                onClick={() => {
                  if (!canManage) return;
                  if (!inviteLocked) setInviteModalMessage(null); // a locked invite keeps its notice
                  setShowInviteModal(true);
                }}
                disabled={!canManage}
                className="bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 text-white px-6 py-3 rounded-xl font-semibold shadow-lg hover:shadow-xl transform hover:scale-105 transition-all duration-200 flex items-center gap-2 disabled:opacity-50"
              >
                <UserPlus className="h-5 w-5" />
                Invite Member
              </button>
              <button
                onClick={loadUsers}
                disabled={isLoading}
                className="px-4 py-2 text-gray-600 hover:text-gray-900 font-medium transition-colors disabled:opacity-50 flex items-center gap-2"
              >
                <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
                Refresh Users
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="max-w-7xl mx-auto px-6 py-8">
        <div className="mb-8">
          <div className="flex space-x-1 bg-white/70 backdrop-blur-sm rounded-xl p-1 border border-gray-200/50">
            {[
              { id: 'members', label: 'Team Members', icon: Users },
              { id: 'roles', label: 'Roles', icon: Shield },
            ].map((tab) => {
              const IconComponent = tab.icon;
              return (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex items-center gap-2 px-4 py-2 rounded-lg font-medium transition-all duration-200 ${
                    activeTab === tab.id
                      ? 'bg-gradient-to-r from-indigo-500 to-purple-600 text-white shadow-lg'
                      : 'text-gray-600 hover:text-gray-900 hover:bg-white/50'
                  }`}
                >
                  <IconComponent className="h-4 w-4" />
                  {tab.label}
                </button>
              );
            })}
          </div>
        </div>

        {!isAuthenticated && (
          <div className="bg-white/70 backdrop-blur-sm rounded-2xl shadow-lg border border-gray-200/50 p-6">
            <p className="text-gray-700">Please log in to manage your team.</p>
          </div>
        )}

        {isAuthenticated && !userRole && (
          <div className="bg-white/70 backdrop-blur-sm rounded-2xl shadow-lg border border-gray-200/50 p-6">
            <p className="text-gray-700">No company role assigned yet.</p>
          </div>
        )}

        {roleNotice && (
          <div className="text-yellow-600 text-sm mb-2">
            {roleNotice}
          </div>
        )}

        {toastMessage && (
          <div className="bg-orange-100 text-orange-700 rounded-lg p-4 mb-6">
            {toastMessage}
          </div>
        )}

        {outcomeNotice && (
          <div role="status" className="mb-6 flex items-start justify-between gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            <span>{outcomeNotice}</span>
            <button type="button" onClick={() => setOutcomeNotice('')} className="text-xs font-medium underline">
              Dismiss
            </button>
          </div>
        )}

        {activeTab === 'members' && isAuthenticated && (
          <div className="space-y-6">
            <div className="bg-white/70 backdrop-blur-sm rounded-2xl shadow-lg border border-gray-200/50 p-6">
              <div className="flex items-center justify-between mb-2">
                <h2 className="text-xl font-bold text-gray-900">
                  Team Members ({usersLoadError ? '—' : teamMembers.length})
                </h2>
                <span className="text-xs text-gray-500">
                  Use the Role dropdown to assign roles
                </span>
              </div>
              {usersLoadError ? (
                <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
                  <span>{usersLoadError}</span>
                  <button
                    type="button"
                    onClick={() => loadUsers()}
                    className="rounded border border-amber-300 bg-white px-2 py-1 text-xs font-medium hover:bg-amber-100"
                  >
                    Retry
                  </button>
                </div>
              ) : teamMembers.length === 0 ? (
                <p className="text-gray-600">No users yet. Invite your first team member.</p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Name</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Email</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Role</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Status</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Created</th>
                        <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase tracking-wider">Actions</th>
                      </tr>
                    </thead>
                    <tbody className="bg-white divide-y divide-gray-200">
                      {teamMembers.map((member) => (
                        <tr key={member.user_id || member.id} className="hover:bg-gray-50">
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                            {member.name || '—'}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                            {member.email}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                            {member.role}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm">
                            <span
                              className={`inline-flex items-center px-2 py-1 rounded-full text-xs font-medium ${
                                member.status === 'invited'
                                  ? 'bg-yellow-100 text-yellow-800'
                                  : member.status === 'expired'
                                  ? 'bg-orange-100 text-orange-700'
                                  : member.status === 'inactive' || member.status === 'deactivated'
                                  ? 'bg-red-100 text-red-700'
                                  : 'bg-green-100 text-green-700'
                              }`}
                            >
                              {member.status || 'active'}
                            </span>
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                            {new Date(member.created_at).toLocaleDateString()}
                          </td>
                          <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                            <div className="flex items-center gap-3">
                              <select
                                value={member.role}
                                onChange={(e) => updateUserRole(String(member.user_id || member.id), e.target.value)}
                                className="border border-gray-300 rounded-lg px-3 py-1"
                                disabled={isLoading || !canManage}
                              >
                                {roleOptions.map((role) => (
                                  <option key={role.id} value={role.id}>
                                    {role.name}
                                  </option>
                                ))}
                              </select>
                              {member.status === 'invited' && (
                                <button
                                  onClick={() => reinviteUser(member.email, member.role, member.name)}
                                  disabled={isLoading || !canManage}
                                  className="text-indigo-600 hover:text-indigo-800 text-sm font-medium disabled:opacity-50"
                                >
                                  Reinvite
                                </button>
                              )}
                              {member.status === 'invited' && canManage && (
                                <button
                                  onClick={() => removeUser(String(member.user_id || member.id))}
                                  disabled={isLoading}
                                  className="text-red-600 hover:text-red-800 text-sm font-medium disabled:opacity-50"
                                >
                                  Cancel Invite
                                </button>
                              )}
                              {member.status === 'active' && canManage && (
                                <button
                                  onClick={() => deactivateUser(String(member.user_id || member.id), member.role)}
                                  disabled={isLoading}
                                  className="text-red-600 hover:text-red-800 text-sm font-medium disabled:opacity-50"
                                >
                                  Deactivate
                                </button>
                              )}
                              {member.status === 'active' && canManage && (
                                <button
                                  onClick={() => removeUser(String(member.user_id || member.id))}
                                  disabled={isLoading}
                                  className="text-red-600 hover:text-red-800 text-sm font-medium disabled:opacity-50"
                                >
                                  Remove
                                </button>
                              )}
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'roles' && (
          <div className="space-y-6">
            <div className="bg-white/70 backdrop-blur-sm rounded-2xl shadow-lg border border-gray-200/50 p-6">
              <h2 className="text-xl font-bold text-gray-900 mb-6">Roles</h2>
              <div className="space-y-3">
                {roleOptions.map((role) => (
                  <div key={role.id} className="bg-white/80 backdrop-blur-sm rounded-xl p-4 border border-gray-200/50">
                    <h4 className="font-semibold text-gray-900">{role.name}</h4>
                    <p className="text-sm text-gray-600 mt-1">{role.description}</p>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      {showInviteModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-md mx-4">
            <h3 className="text-xl font-bold text-gray-900 mb-4">Invite Team Member</h3>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Full Name</label>
                <input
                  type="text"
                  value={inviteForm.name}
                  onChange={(e) => editInviteForm({ name: e.target.value })}
                  readOnly={inviteLocked}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                  placeholder="Alex Johnson"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Email Address</label>
                <input
                  type="email"
                  value={inviteForm.email}
                  onChange={(e) => editInviteForm({ email: e.target.value })}
                  readOnly={inviteLocked}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                  placeholder="colleague@omnivyra.com"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Role</label>
                <select
                  value={inviteForm.role}
                  onChange={(e) => editInviteForm({ role: e.target.value })}
                  disabled={inviteLocked}
                  className="w-full border border-gray-200 rounded-lg px-3 py-2 focus:ring-2 focus:ring-indigo-500 focus:border-transparent"
                >
                  {roleOptions.map((role) => (
                    <option key={role.id} value={role.id}>
                      {role.name}
                    </option>
                  ))}
                </select>
              </div>
            </div>

            {inviteModalMessage && (
              <div
                role={inviteModalMessage.tone === 'error' ? 'alert' : 'status'}
                className={`mt-4 rounded-lg p-3 text-sm ${
                  inviteModalMessage.tone === 'error'
                    ? 'border border-red-200 bg-red-50 text-red-800'
                    : 'border border-amber-200 bg-amber-50 text-amber-900'
                }`}
              >
                {inviteModalMessage.text}
              </div>
            )}

            <div className="flex items-center gap-3 mt-6">
              <button
                onClick={() => setShowInviteModal(false)}
                className="flex-1 px-4 py-2 text-gray-600 hover:text-gray-900 font-medium transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={sendInvitation}
                disabled={isLoading || (!inviteLocked && !inviteForm.email)}
                className="flex-1 bg-gradient-to-r from-indigo-500 to-purple-600 hover:from-indigo-600 hover:to-purple-700 disabled:opacity-50 text-white px-4 py-2 rounded-lg font-medium transition-all duration-200"
              >
                {isLoading ? 'Sending...' : inviteLocked ? 'Check and send' : 'Send Invitation'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
