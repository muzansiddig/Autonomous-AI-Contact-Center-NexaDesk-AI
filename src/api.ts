import { AccessTokenError, getAccessToken, notifyAuthenticationExpired } from "./auth";
import type {
  ApprovalSummary,
  ApiError,
  AssignmentResponse,
  ConversationDetail,
  ConversationSummary,
  ControlMode,
  ControlMutationResponse,
  DirectoryMember,
  DirectoryTeam,
  KnowledgeDocumentSummary,
  KnowledgeSearchResult,
  MessageSummary,
  OutboundMessageResponse,
  Page,
  ReadConversationResponse,
  RealtimeEvent,
  TaskSummary,
  TimelinePage,
} from "../shared/contracts";

export class ApiClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
    readonly requestId?: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

const apiBaseUrl = (import.meta.env.VITE_API_BASE_URL ?? "").replace(/\/$/, "");
const tenantId = import.meta.env.VITE_TENANT_ID?.trim();

function requestHeaders(initial?: HeadersInit): Headers {
  const headers = new Headers(initial);
  headers.set("Accept", "application/json");
  if (tenantId) headers.set("X-Tenant-Id", tenantId);
  return headers;
}

function errorFromResponse(status: number, body: unknown): ApiClientError {
  const apiError = body as ApiError | null;
  const error = apiError?.error;
  return new ApiClientError(
    error?.message ?? "The server returned an unexpected response.",
    status,
    error?.code ?? "INVALID_API_RESPONSE",
    error?.requestId,
    error?.retryable ?? status >= 500,
  );
}

async function authenticatedHeaders(initial?: HeadersInit): Promise<Headers> {
  const headers = requestHeaders(initial);
  let token: string | null;
  try {
    token = await getAccessToken();
  } catch (error) {
    if (error instanceof AccessTokenError) {
      throw new ApiClientError(
        "انتهت جلسة الدخول أو تعذر الحصول على رمز API. سجّل الدخول مجددًا.",
        401,
        "TOKEN_UNAVAILABLE",
      );
    }
    throw error;
  }
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

export async function apiRequest<T>(
  path: string,
  init: RequestInit = {},
): Promise<T> {
  if (init.signal?.aborted) throw new DOMException("Request aborted", "AbortError");
  const headers = await authenticatedHeaders(init.headers);
  let response: Response;
  try {
    response = await fetch(`${apiBaseUrl}${path}`, {
      ...init,
      headers,
    });
  } catch (error) {
    if (init.signal?.aborted) throw new DOMException("Request aborted", "AbortError");
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new ApiClientError(
      "The API could not be reached. Check the connection and try again.",
      0,
      "NETWORK_ERROR",
      undefined,
      true,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (!response.ok) {
    if (response.status === 401) notifyAuthenticationExpired();
    throw errorFromResponse(response.status, body);
  }
  return body as T;
}

const jsonBody = (body: unknown): Pick<RequestInit, "method" | "headers" | "body"> => ({
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

function queryString(values: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== "") params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `?${query}` : "";
}

export const inboxApi = {
  listConversations(
    options: {
      query?: string;
      controlMode?: ControlMode;
      unread?: boolean;
      cursor?: string;
      limit?: number;
    },
    signal?: AbortSignal,
  ) {
    return apiRequest<Page<ConversationSummary>>(
      `/v1/conversations${queryString({
        query: options.query,
        controlMode: options.controlMode,
        unread: options.unread === undefined ? undefined : String(options.unread),
        cursor: options.cursor,
        limit: options.limit ?? 30,
      })}`,
      { signal },
    );
  },

  getConversation(id: string, signal?: AbortSignal) {
    return apiRequest<ConversationDetail>(`/v1/conversations/${id}`, { signal });
  },

  markConversationRead(id: string) {
    return apiRequest<ReadConversationResponse>(
      `/v1/conversations/${id}/read`,
      jsonBody({}),
    );
  },

  getTimeline(id: string, cursor?: string, signal?: AbortSignal) {
    return apiRequest<TimelinePage>(
      `/v1/conversations/${id}/timeline${queryString({ cursor, limit: 50 })}`,
      { signal },
    );
  },

  setControl(id: string, mode: ControlMode, expectedControlVersion: number) {
    const action = mode === "human" ? "takeover" : mode === "paused" ? "pause-ai" : "resume-ai";
    return apiRequest<ControlMutationResponse>(
      `/v1/conversations/${id}/${action}`,
      jsonBody({ expectedControlVersion }),
    );
  },

  assignConversation(
    id: string,
    expectedControlVersion: number,
    assignment: { assigneeUserId: string } | { teamId: string },
  ) {
    return apiRequest<AssignmentResponse>(
      `/v1/conversations/${id}/assign`,
      jsonBody({ expectedControlVersion, ...assignment }),
    );
  },

  sendMessage(
    conversationId: string,
    body: string,
    expectedControlVersion: number,
    clientMessageId: string,
  ) {
    return apiRequest<OutboundMessageResponse>(
      `/v1/conversations/${conversationId}/messages`,
      {
        ...jsonBody({ body, expectedControlVersion, clientMessageId }),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": clientMessageId,
        },
      },
    );
  },

  getMessage(id: string, signal?: AbortSignal) {
    return apiRequest<MessageSummary>(`/v1/messages/${id}`, { signal });
  },

  getTasks(conversationId: string, signal?: AbortSignal) {
    return apiRequest<Page<TaskSummary>>(
      `/v1/tasks${queryString({ conversationId, limit: 30 })}`,
      { signal },
    );
  },

  getApprovals(conversationId: string, signal?: AbortSignal) {
    return apiRequest<Page<ApprovalSummary>>(
      `/v1/approvals${queryString({ conversationId, limit: 30 })}`,
      { signal },
    );
  },

  decideApproval(
    approvalId: string,
    decision: "approve" | "reject",
    actionHash: string,
    idempotencyKey: string,
  ) {
    return apiRequest<{
      approvalId: string;
      status: ApprovalSummary["status"];
      approvedBy: string;
      executionStatus: "not_implemented" | "not_applicable";
      executed: false;
      duplicate: boolean;
    }>(
      `/v1/approvals/${approvalId}/decision`,
      {
        ...jsonBody({ decision, actionHash }),
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
      },
    );
  },

  getMembers(signal?: AbortSignal) {
    return apiRequest<DirectoryMember[]>("/v1/members", { signal });
  },

  getTeams(signal?: AbortSignal) {
    return apiRequest<DirectoryTeam[]>("/v1/teams", { signal });
  },

  getChannels(signal?: AbortSignal) {
    return apiRequest<Array<{
      id: string;
      channelType: string;
      status: "active" | "disabled" | "error";
      configurationStatus: "not_configured" | "ready" | "error";
      capabilities: Record<string, boolean>;
      lastCheckedAt: string | null;
      lastErrorCode: string | null;
    }>>("/v1/channels", { signal });
  },

  getKnowledgeDocuments(signal?: AbortSignal) {
    return apiRequest<KnowledgeDocumentSummary[]>("/v1/knowledge/documents", { signal });
  },

  registerKnowledgeDocument(input: {
    sourceKey: string;
    sourceName: string;
    mediaType: "text/plain" | "text/markdown";
    content: string;
  }) {
    return apiRequest<KnowledgeDocumentSummary>(
      "/v1/knowledge/documents",
      jsonBody(input),
    );
  },

  deleteKnowledgeDocument(id: string) {
    return apiRequest<void>(`/v1/knowledge/documents/${id}`, { method: "DELETE" });
  },

  searchKnowledge(query: string, signal?: AbortSignal) {
    return apiRequest<{ items: KnowledgeSearchResult[] }>(
      `/v1/knowledge/search${queryString({ q: query, limit: 8 })}`,
      { signal },
    );
  },
};

export type RealtimeStatus = "connecting" | "connected" | "reconnecting" | "unauthorized";

const wait = (delay: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const finish = () => {
      window.clearTimeout(timeout);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timeout = window.setTimeout(finish, delay);
    signal.addEventListener("abort", finish, { once: true });
  });

export async function listenForEvents(
  onEvent: (event: RealtimeEvent) => void,
  onStatus: (status: RealtimeStatus) => void,
  signal: AbortSignal,
): Promise<void> {
  let lastEventId = "0";
  onStatus("connecting");

  while (!signal.aborted) {
    try {
      const headers = await authenticatedHeaders({ Accept: "text/event-stream" });
      headers.set("Last-Event-ID", lastEventId);
      const response = await fetch(`${apiBaseUrl}/v1/events`, { headers, signal });
      if (!response.ok) {
        let body: unknown;
        try {
          body = await response.json();
        } catch {
          body = null;
        }
        if (response.status === 401) notifyAuthenticationExpired();
        throw errorFromResponse(response.status, body);
      }
      if (!response.body) throw new ApiClientError("The event stream is unavailable.", 0, "STREAM_UNAVAILABLE", undefined, true);

      onStatus("connected");
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (!signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split(/\r?\n\r?\n/);
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          let eventId = "";
          let eventName = "";
          const data: string[] = [];
          for (const line of frame.split(/\r?\n/)) {
            if (line.startsWith("id:")) eventId = line.slice(3).trim();
            else if (line.startsWith("event:")) eventName = line.slice(6).trim();
            else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
          }
          if (eventId) lastEventId = eventId;
          if (eventName === "stream-error" || data.length === 0) continue;
          const parsed: unknown = JSON.parse(data.join("\n"));
          if (typeof parsed === "object" && parsed !== null && "type" in parsed) {
            onEvent(parsed as RealtimeEvent);
          }
        }
      }
      if (!signal.aborted) onStatus("reconnecting");
    } catch (error) {
      if (signal.aborted) return;
      if (error instanceof ApiClientError && (error.status === 401 || error.status === 403)) {
        onStatus("unauthorized");
        return;
      }
      onStatus("reconnecting");
    }
    await wait(3_000, signal);
  }
}
