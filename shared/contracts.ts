import { z } from "zod";

export const controlModes = ["ai", "human", "paused"] as const;
export type ControlMode = (typeof controlModes)[number];

export const messageDirections = ["inbound", "outbound"] as const;
export type MessageDirection = (typeof messageDirections)[number];

export const senderTypes = ["customer", "agent", "human", "system"] as const;
export type SenderType = (typeof senderTypes)[number];

export const deliveryStatuses = [
  "queued",
  "sending",
  "accepted",
  "delivered",
  "read",
  "failed",
  "unknown",
] as const;
export type DeliveryStatus = (typeof deliveryStatuses)[number];

export interface ContactSummary {
  id: string;
  displayName: string;
  email: string | null;
  phone: string | null;
}

export interface MessageSummary {
  id: string;
  direction: MessageDirection;
  senderType: SenderType;
  body: string;
  deliveryStatus: DeliveryStatus | null;
  createdAt: string;
}

export interface ConversationSummary {
  id: string;
  contact: ContactSummary;
  channel: string;
  controlMode: ControlMode;
  controlVersion: number;
  status: "open" | "closed";
  priority: "normal" | "high";
  subject: string | null;
  assignee: { userId?: string; teamId?: string; displayName: string } | null;
  unreadCount: number;
  lastMessage: MessageSummary | null;
  updatedAt: string;
}

export interface ConversationDetail extends ConversationSummary {
  tags: string[];
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export interface TimelinePage {
  items: Array<
    | { kind: "message"; message: MessageSummary }
    | {
        kind: "event";
        id: string;
        eventType: string;
        actorType: string;
        createdAt: string;
        metadata: Record<string, unknown>;
      }
  >;
  nextCursor: string | null;
}

export interface ApiError {
  error: {
    code: string;
    message: string;
    requestId: string;
    retryable: boolean;
    details?: Record<string, unknown>;
  };
}

export const uuidSchema = z.string().uuid();
export const controlVersionSchema = z.number().int().nonnegative().safe();

export const listConversationsQuerySchema = z.object({
  query: z.string().trim().max(200).optional(),
  controlMode: z.enum(controlModes).optional(),
  channel: z.string().trim().min(1).max(64).optional(),
  priority: z.enum(["normal", "high"]).optional(),
  assigneeId: uuidSchema.optional(),
  teamId: uuidSchema.optional(),
  unread: z.enum(["true", "false"]).optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const timelineQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const controlRequestSchema = z.object({
  expectedControlVersion: controlVersionSchema,
});
export type ControlRequest = z.infer<typeof controlRequestSchema>;

export const sendMessageRequestSchema = z.object({
  clientMessageId: uuidSchema,
  expectedControlVersion: controlVersionSchema,
  body: z.string().trim().min(1).max(4000),
});
export type SendMessageRequest = z.infer<typeof sendMessageRequestSchema>;

export const assignConversationRequestSchema = z
  .object({
    expectedControlVersion: controlVersionSchema,
    assigneeUserId: uuidSchema.optional(),
    teamId: uuidSchema.optional(),
  })
  .refine((value) => Number(Boolean(value.assigneeUserId)) + Number(Boolean(value.teamId)) === 1, {
    message: "Provide exactly one of assigneeUserId or teamId",
  });
export type AssignConversationRequest = z.infer<typeof assignConversationRequestSchema>;

export type TaskStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "approved_not_executed"
  | "succeeded"
  | "failed"
  | "unknown"
  | "cancelled";
export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired";

export interface TaskSummary {
  id: string;
  conversationId: string | null;
  taskType: string;
  status: TaskStatus;
  attemptCount: number;
  errorCode: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TaskDetail extends TaskSummary {
  result: unknown;
}

export interface ApprovalSummary {
  id: string;
  taskId: string;
  conversationId: string | null;
  status: ApprovalStatus;
  requestedAction: Record<string, unknown>;
  actionHash: string | null;
  approvedBy: string | null;
  expiresAt: string | null;
  createdAt: string;
  canDecide: boolean;
}

export const approvalActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("refund"),
    orderReference: z.string().trim().min(1).max(120),
    amount: z.number().positive().max(100_000),
  }).strict(),
  z.object({
    type: z.literal("cancel_order"),
    orderReference: z.string().trim().min(1).max(120),
  }).strict(),
]);

export const approvalDecisionRequestSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  actionHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const approvalDecisionHeadersSchema = z.object({
  "idempotency-key": uuidSchema,
}).strict();

export interface AssignmentResponse {
  conversationId: string;
  assigneeUserId: string | null;
  teamId: string | null;
  controlVersion: number;
  updatedAt: string;
}

export interface DirectoryMember {
  userId: string;
  displayName: string;
}

export interface DirectoryTeam {
  id: string;
  name: string;
}

export interface ReadConversationResponse {
  conversationId: string;
  unreadCount: number;
}

export const messageSendHeadersSchema = z.object({
  "idempotency-key": uuidSchema,
});

export const listTasksQuerySchema = z.object({
  conversationId: uuidSchema.optional(),
  status: z.enum([
    "queued",
    "running",
    "waiting_approval",
    "approved_not_executed",
    "succeeded",
    "failed",
    "unknown",
    "cancelled",
  ]).optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export const listApprovalsQuerySchema = z.object({
  conversationId: uuidSchema.optional(),
  status: z.enum(["pending", "approved", "rejected", "expired"]).optional(),
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
});

export interface ControlMutationResponse {
  conversationId: string;
  controlMode: ControlMode;
  controlVersion: number;
  updatedAt: string;
}

export interface OutboundMessageResponse {
  message: MessageSummary;
  adapter: "test";
}

export interface RealtimeEvent {
  id: string;
  type: string;
  conversationId: string | null;
  occurredAt: string;
  data: Record<string, unknown>;
}

export const knowledgeDocumentRequestSchema = z.object({
  sourceKey: z.string().trim().min(1).max(200),
  sourceName: z.string().trim().min(1).max(200),
  mediaType: z.enum(["text/plain", "text/markdown"]),
  content: z.string().trim().min(1).max(20_000),
});

export const knowledgeSearchQuerySchema = z.object({
  q: z.string().trim().min(2).max(500),
  limit: z.coerce.number().int().min(1).max(20).default(8),
});

export interface KnowledgeDocumentSummary {
  id: string;
  sourceKey: string;
  sourceName: string;
  version: number;
  mediaType: "text/plain" | "text/markdown";
  status: "active" | "replaced" | "deleted" | "failed";
  ingestionErrorCode: string | null;
  chunkCount: number;
  createdAt: string;
}

export interface KnowledgeSearchResult {
  documentId: string;
  sourceName: string;
  version: number;
  chunk: string;
}

export const agentSettingsRequestSchema = z.object({
  enabled: z.boolean(),
  provider: z.enum(["disabled", "fake", "openai"]),
  systemInstructions: z.string().max(4_000).default(""),
}).strict();

export interface AgentSettingsResponse {
  enabled: boolean;
  provider: "disabled" | "fake" | "openai";
}

export interface AgentRunSummary {
  runId: string;
  status: "completed" | "stale" | "skipped";
  decisionType?: "respond" | "clarify" | "handoff" | "create_task" | "request_approval";
  messageId?: string;
  taskId?: string;
  approvalId?: string;
}

export const testInboundMessageSchema = z.object({
  eventId: uuidSchema,
  body: z.string().trim().min(1).max(4_000),
}).strict();
