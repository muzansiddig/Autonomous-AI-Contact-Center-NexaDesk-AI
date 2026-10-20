import type {
  ConversationDetail,
  ConversationSummary,
  MessageSummary,
  TimelinePage,
} from "../shared/contracts";
import type { Channel, Conversation, ConversationTimelineItem, Message } from "./data";

export function mapMessage(message: MessageSummary): Message {
  return {
    id: message.id,
    body: message.body,
    direction: message.direction,
    sender: message.senderType,
    time: formatTime(message.createdAt),
    status: message.deliveryStatus ?? undefined,
    createdAt: message.createdAt,
  };
}

export function mapTimeline(page: TimelinePage): ConversationTimelineItem[] {
  return page.items
    .map((item): ConversationTimelineItem => {
      if (item.kind === "message") {
        return { kind: "message", message: mapMessage(item.message) };
      }
      return item;
    })
    .reverse();
}

export function mapConversation(
  summary: ConversationSummary | ConversationDetail,
  messages: Message[] = [],
  timeline?: ConversationTimelineItem[],
): Conversation {
  const contactName = summary.contact.displayName || "عميل";
  const initials = Array.from(contactName).slice(0, 2).join("");
  return {
    id: summary.id,
    customer: contactName,
    initials,
    email: summary.contact.email ?? "",
    phone: summary.contact.phone ?? "",
    channel: summary.channel as Channel,
    mode: summary.controlMode,
    subject: summary.subject ?? "محادثة جديدة",
    preview: summary.lastMessage?.body ?? "",
    time: formatRelativeTime(summary.updatedAt),
    unread: summary.unreadCount,
    priority: summary.priority,
    tags: "tags" in summary ? summary.tags : [],
    messages,
    timeline,
    order: "",
    controlVersion: summary.controlVersion,
    assignee: summary.assignee,
    status: summary.status,
  };
}

function formatTime(value: string): string {
  return new Intl.DateTimeFormat("ar-SA", {
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatRelativeTime(value: string): string {
  const age = Date.now() - new Date(value).getTime();
  if (age < 60_000) return "الآن";
  if (age < 3_600_000) {
    return `منذ ${new Intl.NumberFormat("ar-SA", { maximumFractionDigits: 0 }).format(Math.floor(age / 60_000))} دقيقة`;
  }
  if (age < 86_400_000) {
    return `منذ ${new Intl.NumberFormat("ar-SA", { maximumFractionDigits: 0 }).format(Math.floor(age / 3_600_000))} ساعة`;
  }
  return new Intl.DateTimeFormat("ar-SA", { dateStyle: "short" }).format(new Date(value));
}
