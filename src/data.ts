import type {
  ControlMode,
  DeliveryStatus,
  MessageDirection,
  SenderType,
} from "../shared/contracts";

export type { ControlMode } from "../shared/contracts";
export type Channel = string;

export interface Message {
  id: string;
  body: string;
  direction: MessageDirection;
  sender: SenderType;
  time: string;
  status?: DeliveryStatus;
  createdAt?: string;
}

export type ConversationTimelineItem =
  | { kind: "message"; message: Message }
  | {
      kind: "event";
      id: string;
      eventType: string;
      actorType: string;
      createdAt: string;
      metadata: Record<string, unknown>;
    };

export interface Conversation {
  id: string;
  customer: string;
  initials: string;
  email: string;
  phone: string;
  channel: Channel;
  mode: ControlMode;
  subject: string;
  preview: string;
  time: string;
  unread: number;
  priority: "normal" | "high";
  tags: string[];
  messages: Message[];
  order: string;
  controlVersion?: number;
  assignee?: { userId?: string; teamId?: string; displayName: string } | null;
  status?: "open" | "closed";
  timeline?: ConversationTimelineItem[];
}

const makeMessages = (
  entries: Array<[string, Message["direction"], Message["sender"], string]>,
): Message[] =>
  entries.map(([body, direction, sender, time], index) => ({
    id: `message-${index}`,
    body,
    direction,
    sender,
    time,
    status: direction === "outbound" ? "delivered" : undefined,
  }));

export const initialConversations: Conversation[] = [
  {
    id: "NC-2048",
    customer: "سارة العتيبي",
    initials: "سع",
    email: "sara.alotaibi@email.com",
    phone: "+966 55 821 4902",
    channel: "whatsapp",
    mode: "ai",
    subject: "استفسار عن حالة الطلب",
    preview: "شكرًا لك، طلبك في الطريق وسيصلك غدًا...",
    time: "الآن",
    unread: 2,
    priority: "high",
    tags: ["طلب #48291", "توصيل"],
    order: "48291",
    messages: makeMessages([
      ["مرحبًا، طلبت قبل يومين وأحتاج أعرف متى يوصلني.", "inbound", "customer", "١٠:٤٢ ص"],
      ["أهلًا سارة! يسعدني مساعدتك. هل تقصدين الطلب رقم 48291؟", "outbound", "agent", "١٠:٤٢ ص"],
      ["نعم، هذا هو. عندي سفر بعد بكرة.", "inbound", "customer", "١٠:٤٤ ص"],
      ["تحققت من حالة طلبك، وهو الآن مع شركة الشحن. موعد التوصيل المتوقع غدًا قبل الساعة ٦ مساءً. هل أساعدك بشيء آخر؟", "outbound", "agent", "١٠:٤٥ ص"],
      ["ممتاز، هل ممكن أتأكد أن العنوان صحيح؟", "inbound", "customer", "١٠:٤٧ ص"],
    ]),
  },
  {
    id: "NC-2047",
    customer: "خالد الشمري",
    initials: "خش",
    email: "khalid.s@email.com",
    phone: "+966 50 214 8831",
    channel: "web",
    mode: "human",
    subject: "استبدال منتج",
    preview: "تمام، سأرسل لك خطوات الاستبدال...",
    time: "منذ ٤ دقائق",
    unread: 1,
    priority: "normal",
    tags: ["استبدال"],
    order: "48176",
    messages: makeMessages([
      ["وصلني المقاس خطأ، كيف أبدله؟", "inbound", "customer", "١٠:٣١ ص"],
      ["أهلًا خالد، أعتذر عن ذلك. أتحقق لك من طلب الاستبدال الآن.", "outbound", "human", "١٠:٣٤ ص"],
    ]),
  },
  {
    id: "NC-2046",
    customer: "نورة الحربي",
    initials: "نح",
    email: "noura.h@email.com",
    phone: "+966 54 793 2061",
    channel: "email",
    mode: "paused",
    subject: "طلب استرداد مبلغ",
    preview: "أفهم رغبتك في الاسترداد...",
    time: "منذ ١٢ دقيقة",
    unread: 0,
    priority: "high",
    tags: ["استرداد", "موافقة مطلوبة"],
    order: "48092",
    messages: makeMessages([
      ["أرغب في استرداد المبلغ، المنتج لم يناسبني.", "inbound", "customer", "١٠:١٧ ص"],
      ["أفهم رغبتك في الاسترداد. أحوّل طلبك لفريقنا لمراجعته ومساعدتك بأسرع وقت.", "outbound", "agent", "١٠:١٨ ص"],
    ]),
  },
  {
    id: "NC-2045",
    customer: "عبدالله القحطاني",
    initials: "عق",
    email: "abdullah.q@email.com",
    phone: "+966 56 601 2374",
    channel: "whatsapp",
    mode: "ai",
    subject: "معلومات عن منتج",
    preview: "نعم، يتوفر باللون الأسود...",
    time: "منذ ٢٥ دقيقة",
    unread: 0,
    priority: "normal",
    tags: ["استفسار منتج"],
    order: "—",
    messages: makeMessages([
      ["هل هذا الجهاز متوفر باللون الأسود؟", "inbound", "customer", "٩:٥٤ ص"],
      ["نعم، يتوفر باللون الأسود وباللون الفضي. أرسل لك رابط المنتج؟", "outbound", "agent", "٩:٥٥ ص"],
    ]),
  },
  {
    id: "NC-2044",
    customer: "ريم الغامدي",
    initials: "رغ",
    email: "reem.g@email.com",
    phone: "+966 53 435 0932",
    channel: "web",
    mode: "ai",
    subject: "تغيير عنوان التوصيل",
    preview: "تم تحديث عنوان التوصيل بنجاح...",
    time: "منذ ٣٨ دقيقة",
    unread: 0,
    priority: "normal",
    tags: ["طلب #48102"],
    order: "48102",
    messages: makeMessages([
      ["أحتاج أغير عنوان التوصيل للطلب الأخير.", "inbound", "customer", "٩:٤١ ص"],
      ["تم تحديث عنوان التوصيل بنجاح. سيصل طلبك إلى حي النرجس، الرياض.", "outbound", "agent", "٩:٤٢ ص"],
    ]),
  },
  {
    id: "NC-2043",
    customer: "فيصل المطيري",
    initials: "فم",
    email: "faisal.m@email.com",
    phone: "+966 59 830 4177",
    channel: "email",
    mode: "human",
    subject: "شكوى عن التأخير",
    preview: "أعتذر لك عن هذا التأخير...",
    time: "منذ ساعة",
    unread: 0,
    priority: "high",
    tags: ["شكوى", "متابعة"],
    order: "47988",
    messages: makeMessages([
      ["الطلب متأخر أسبوعًا ولم يصلني أي تحديث.", "inbound", "customer", "٩:١٢ ص"],
      ["أعتذر لك عن هذا التأخير يا فيصل. تواصلت مع شركة الشحن وأتابع الموضوع بنفسي.", "outbound", "human", "٩:١٨ ص"],
    ]),
  },
  {
    id: "NC-2042",
    customer: "لينا الدوسري",
    initials: "لد",
    email: "lina.d@email.com",
    phone: "+966 55 344 7209",
    channel: "whatsapp",
    mode: "ai",
    subject: "ساعات العمل",
    preview: "نحن متاحون يوميًا من ٩ صباحًا...",
    time: "منذ ساعتين",
    unread: 0,
    priority: "normal",
    tags: ["سؤال عام"],
    order: "—",
    messages: makeMessages([
      ["ما هي ساعات عمل خدمة العملاء؟", "inbound", "customer", "٨:٣٥ ص"],
      ["نحن متاحون يوميًا من ٩ صباحًا حتى ١٠ مساءً، ويسعدنا خدمتك.", "outbound", "agent", "٨:٣٥ ص"],
    ]),
  },
  {
    id: "NC-2041",
    customer: "ماجد السبيعي",
    initials: "مس",
    email: "majed.s@email.com",
    phone: "+966 50 914 7860",
    channel: "web",
    mode: "ai",
    subject: "تأكيد الدفع",
    preview: "تم تأكيد الدفع، شكرًا لطلبك...",
    time: "أمس",
    unread: 0,
    priority: "normal",
    tags: ["دفع"],
    order: "47890",
    messages: makeMessages([
      ["هل وصل الدفع؟ لم يظهر لي تأكيد.", "inbound", "customer", "أمس، ٨:١٢ م"],
      ["تم تأكيد الدفع بنجاح، شكرًا لطلبك! ستصلك رسالة عند شحن الطلب.", "outbound", "agent", "أمس، ٨:١٣ م"],
    ]),
  },
];
