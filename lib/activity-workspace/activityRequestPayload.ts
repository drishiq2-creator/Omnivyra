/**
 * The `activity` object sent to /api/activity-workspace/content (one builder; it was copied in the
 * content-ops and refinement-ops hooks).
 *
 * The fallback id is DETERMINISTIC (was `workspace-${Date.now()}`): the request body is the client
 * key's scope (lib/activity-workspace/postGenerateVariants) and the server scopes a billed key to the
 * activity, so a time-based id made every retry a different request = a second charge
 * (synthesised-key class, 7c 2026-11-18). A real activityId / schedule id is always preferred.
 */
import type { WorkspacePayload } from './shared';
import type { ScheduleItem } from '../../types/activityWorkspace';

export function buildActivityRequestPayload(payload: WorkspacePayload | null, schedules: ScheduleItem[]) {
  const primary = schedules[0];
  const platform = primary?.platform || 'linkedin';
  const contentType = primary?.contentType || 'post';
  const topic = payload?.topic || payload?.title || '';
  return {
    id: payload?.activityId || primary?.id || `workspace-${platform}-${contentType}-${topic}`,
    platform,
    contentType,
    topic,
    title: payload?.title || payload?.topic || '',
    description: payload?.description || '',
  };
}
