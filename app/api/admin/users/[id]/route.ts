import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";
import { requireAuthWithCsrf } from "@/lib/auth/request-auth";
import { logAuditEvent } from "@/lib/observability/audit";
import { getClientIp } from "@/lib/security/request";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const updateRoleSchema = z.object({
  role: z.enum(["reader", "admin", "suspended"]),
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const authResult = await requireAuthWithCsrf(request, ["admin"]);
  const ipAddress = getClientIp(request);
  const { id: targetUserId } = await params;

  if (!authResult.ok) {
    logAuditEvent({
      action: "admin.user.role_change",
      actorId: null,
      actorRole: "anonymous",
      outcome: "failure",
      resource: "admin",
      ipAddress,
      metadata: { reason: "unauthorized", targetUserId },
    });
    return authResult.response;
  }

  // Prevent self-demotion
  if (targetUserId === authResult.user.id) {
    return NextResponse.json({ error: "Cannot change your own role" }, { status: 400 });
  }

  const parsed = updateRoleSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { role: newRole } = parsed.data;

  try {
    const supabase = getSupabaseAdminClient();

    // Get current user to log the before state
    const { data: currentUser, error: getUserError } = await supabase.auth.admin.getUserById(targetUserId);
    if (getUserError || !currentUser.user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const previousRole = (currentUser.user.app_metadata?.role as string) ?? "pending";

    const { data: updatedUser, error: updateError } = await supabase.auth.admin.updateUserById(targetUserId, {
      app_metadata: { role: newRole },
    });

    if (updateError) {
      throw updateError;
    }

    logAuditEvent({
      action: "admin.user.role_change",
      actorId: authResult.user.id,
      actorRole: "admin",
      outcome: "success",
      resource: "admin",
      ipAddress,
      metadata: {
        targetUserId,
        targetEmail: updatedUser.user.email,
        previousRole,
        newRole,
      },
    });

    return NextResponse.json({
      id: updatedUser.user.id,
      email: updatedUser.user.email ?? null,
      role: newRole,
      created_at: updatedUser.user.created_at,
      last_sign_in_at: updatedUser.user.last_sign_in_at ?? null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    logAuditEvent({
      action: "admin.user.role_change",
      actorId: authResult.user.id,
      actorRole: "admin",
      outcome: "failure",
      resource: "admin",
      ipAddress,
      metadata: { reason: "update_failed", targetUserId, message },
    });
    return NextResponse.json({ error: "Failed to update user role" }, { status: 500 });
  }
}
