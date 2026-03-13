import { z } from "zod";
import { NextResponse, type NextRequest } from "next/server";
import { requireAuthWithCsrf } from "@/lib/auth/request-auth";
import { logAuditEvent } from "@/lib/observability/audit";
import { getClientIp } from "@/lib/security/request";
import { consumeSharedRateLimit } from "@/lib/security/rate-limit";
import { getSupabaseAdminClient } from "@/lib/supabase/admin";

export const runtime = "nodejs";

const updateRoleSchema = z.object({
  role: z.enum(["reader", "suspended", "rejected"]),
});

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ipAddress = getClientIp(request);

  // Rate limit: 30 requests per 15 minutes per IP
  const rl = await consumeSharedRateLimit(`admin:users:update:${ipAddress}`, 30, 900);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  const authResult = await requireAuthWithCsrf(request, ["admin"]);
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

    // Guard: prevent demoting the last admin
    if (previousRole === "admin") {
      const { data: allUsers } = await supabase.auth.admin.listUsers();
      const adminCount = (allUsers?.users ?? []).filter(
        (u) => (u.app_metadata?.role as string) === "admin",
      ).length;
      if (adminCount <= 1) {
        return NextResponse.json({ error: "Cannot demote the last admin" }, { status: 400 });
      }
    }

    // Spread existing app_metadata to avoid destructive overwrite
    const { data: updatedUser, error: updateError } = await supabase.auth.admin.updateUserById(targetUserId, {
      app_metadata: { ...currentUser.user.app_metadata, role: newRole },
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

export async function DELETE(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const ipAddress = getClientIp(request);

  // Rate limit: reuse admin update bucket
  const rl = await consumeSharedRateLimit(`admin:users:update:${ipAddress}`, 30, 900);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many requests" },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSeconds) } },
    );
  }

  const authResult = await requireAuthWithCsrf(request, ["admin"]);
  const { id: targetUserId } = await params;

  if (!authResult.ok) {
    logAuditEvent({
      action: "admin.user.delete",
      actorId: null,
      actorRole: "anonymous",
      outcome: "failure",
      resource: "admin",
      ipAddress,
      metadata: { reason: "unauthorized", targetUserId },
    });
    return authResult.response;
  }

  // Prevent self-deletion
  if (targetUserId === authResult.user.id) {
    return NextResponse.json({ error: "Cannot delete your own account" }, { status: 400 });
  }

  try {
    const supabase = getSupabaseAdminClient();

    // Get user info for audit log before deletion
    const { data: targetUser, error: getUserError } = await supabase.auth.admin.getUserById(targetUserId);
    if (getUserError || !targetUser.user) {
      return NextResponse.json({ error: "User not found" }, { status: 404 });
    }

    const { error: deleteError } = await supabase.auth.admin.deleteUser(targetUserId);
    if (deleteError) {
      throw deleteError;
    }

    logAuditEvent({
      action: "admin.user.delete",
      actorId: authResult.user.id,
      actorRole: "admin",
      outcome: "success",
      resource: "admin",
      ipAddress,
      metadata: {
        targetUserId,
        targetEmail: targetUser.user.email,
        targetRole: targetUser.user.app_metadata?.role ?? "pending",
      },
    });

    return NextResponse.json({ deleted: true, id: targetUserId, email: targetUser.user.email ?? null });
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown_error";
    logAuditEvent({
      action: "admin.user.delete",
      actorId: authResult.user.id,
      actorRole: "admin",
      outcome: "failure",
      resource: "admin",
      ipAddress,
      metadata: { reason: "delete_failed", targetUserId, message },
    });
    return NextResponse.json({ error: "Failed to delete user" }, { status: 500 });
  }
}
