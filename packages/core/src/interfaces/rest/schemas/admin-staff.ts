import { z, createRoute } from "@hono/zod-openapi";
import { errorResponses } from "./shared.js";

export const CreateStaffBodySchema = z.object({
  userId: z.string().min(1).openapi({ example: "user_abc123", description: "Better Auth user id of an existing user" }),
  role: z.string().min(1).openapi({ example: "manager" }),
}).openapi("CreateStaffRequest");

export const InviteStaffBodySchema = z.object({
  email: z.email().openapi({ example: "newhire@example.com" }),
  role: z.string().min(1).openapi({ example: "manager" }),
}).openapi("InviteStaffRequest");

export const UpdateStaffRoleBodySchema = z.object({
  role: z.string().min(1).openapi({ example: "admin" }),
}).openapi("UpdateStaffRoleRequest");

const MemberIdParam = z.object({
  id: z.string().min(1).openapi({ example: "mem_abc123" }),
});

const DataResponse = z.object({ data: z.any() }).openapi("AdminStaffResponse");

export const listStaffRoute = createRoute({
  method: "get",
  path: "/staff",
  tags: ["Admin"],
  summary: "List staff members with their roles",
  responses: {
    200: { content: { "application/json": { schema: DataResponse } }, description: "Staff members" },
    ...errorResponses,
  },
});

export const createStaffRoute = createRoute({
  method: "post",
  path: "/staff",
  tags: ["Admin"],
  summary: "Add an existing user as a staff member with a role",
  request: {
    body: { content: { "application/json": { schema: CreateStaffBodySchema } }, required: true },
  },
  responses: {
    201: { content: { "application/json": { schema: DataResponse } }, description: "Staff member created." },
    ...errorResponses,
  },
});

export const inviteStaffRoute = createRoute({
  method: "post",
  path: "/staff/invitations",
  tags: ["Admin"],
  summary: "Invite a teammate by email with a role",
  request: {
    body: { content: { "application/json": { schema: InviteStaffBodySchema } }, required: true },
  },
  responses: {
    201: { content: { "application/json": { schema: DataResponse } }, description: "Invitation created." },
    ...errorResponses,
  },
});

export const listStaffInvitationsRoute = createRoute({
  method: "get",
  path: "/staff/invitations",
  tags: ["Admin"],
  summary: "List pending staff invitations",
  responses: {
    200: { content: { "application/json": { schema: DataResponse } }, description: "Invitations" },
    ...errorResponses,
  },
});

export const listStaffRolesRoute = createRoute({
  method: "get",
  path: "/staff/roles",
  tags: ["Admin"],
  summary: "Role → permission mapping staff roles resolve to",
  responses: {
    200: { content: { "application/json": { schema: DataResponse } }, description: "Roles" },
    ...errorResponses,
  },
});

export const updateStaffRoleRoute = createRoute({
  method: "patch",
  path: "/staff/{id}",
  tags: ["Admin"],
  summary: "Change a staff member's role",
  request: {
    params: MemberIdParam,
    body: { content: { "application/json": { schema: UpdateStaffRoleBodySchema } }, required: true },
  },
  responses: {
    200: { content: { "application/json": { schema: DataResponse } }, description: "Role updated." },
    ...errorResponses,
  },
});

export const revokeStaffRoute = createRoute({
  method: "delete",
  path: "/staff/{id}",
  tags: ["Admin"],
  summary: "Revoke a staff member's membership",
  request: { params: MemberIdParam },
  responses: {
    200: { content: { "application/json": { schema: DataResponse } }, description: "Membership revoked." },
    ...errorResponses,
  },
});
