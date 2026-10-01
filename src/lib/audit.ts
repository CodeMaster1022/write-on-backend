import { AdminAction, type AdminActionKind } from "../models/AdminAction.js";

/** Records an admin action. A failure to write the log never blocks the action itself. */
export async function logAdminAction(
  adminId: unknown,
  kind: AdminActionKind,
  detail: { targetUserId?: unknown; contestTitle?: string; lessonTitle?: string; note?: string } = {},
): Promise<void> {
  try {
    await AdminAction.create({ adminId, kind, ...detail });
  } catch (err) {
    console.error("[audit] couldn't record an admin action", err instanceof Error ? err.message : err);
  }
}
