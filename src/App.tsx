import { useEffect, useMemo, useRef, useState } from "react";
import {
  Activity,
  ArrowLeft,
  Bell,
  Bot,
  Check,
  CheckCheck,
  ChevronDown,
  ChevronLeft,
  CircleHelp,
  Clock3,
  FileText,
  Headphones,
  Inbox,
  Instagram,
  LayoutDashboard,
  Mail,
  MessageCircle,
  MoreHorizontal,
  Paperclip,
  Pause,
  Search,
  Send,
  Settings2,
  ShieldCheck,
  Sparkles,
  UserRound,
  UserRoundCheck,
  UsersRound,
  Wifi,
  X,
  Zap,
} from "lucide-react";
import {
  initialConversations,
  type Channel,
  type Conversation,
  type ConversationTimelineItem,
  type ControlMode,
  type Message,
} from "./data";
import {
  ApiClientError,
  inboxApi,
  listenForEvents,
  type RealtimeStatus,
} from "./api";
import { mapConversation, mapMessage, mapTimeline } from "./api-model";
import type {
  ApprovalSummary,
  DirectoryMember,
  DirectoryTeam,
  RealtimeEvent,
  TaskSummary,
} from "../shared/contracts";
import KnowledgePanel from "./KnowledgePanel";

type Filter = "all" | ControlMode | "unread";

const STORAGE_KEY = "nexadesk-demo-conversations-v1";
const demoMode = import.meta.env.VITE_APP_MODE === "demo" && !import.meta.env.PROD;

if (import.meta.env.PROD && import.meta.env.VITE_APP_MODE === "demo") {
  throw new Error("Demo mode cannot be enabled in a production build.");
}

function apiErrorMessage(error: unknown): string {
  if (!(error instanceof ApiClientError)) return "حدث خطأ غير متوقع. حاول مرة أخرى.";
  if (error.status === 401) return "انتهت الجلسة أو لم يتم إعداد تسجيل الدخول. سجّل الدخول ثم أعد المحاولة.";
  if (error.status === 403) return "ليس لديك صلاحية لتنفيذ هذا الإجراء في مساحة العمل.";
  if (error.status === 409) return "تغيرت حالة المحادثة. تم تحديث البيانات من الخادم؛ راجعها ثم حاول مجددًا.";
  if (error.status === 400 || error.status === 422) return "تعذر قبول البيانات. راجع الاختيار أو محتوى الرسالة.";
  if (error.status === 0) return "تعذر الاتصال بالخادم. تحقق من الشبكة؛ لم تُغيّر البيانات المعروضة.";
  if (error.status >= 500) return "الخادم غير متاح مؤقتًا. تحقق من الاتصال قبل إعادة المحاولة.";
  return error.message;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function mergeTimeline(
  conversation: Conversation,
  addedItems: ConversationTimelineItem[],
): Conversation {
  const existing = conversation.timeline ?? conversation.messages.map((message) => ({
    kind: "message" as const,
    message,
  }));
  const items = new Map<string, ConversationTimelineItem>();
  for (const item of [...addedItems, ...existing]) {
    items.set(item.kind === "message" ? `message:${item.message.id}` : `event:${item.id}`, item);
  }
  const timeline = Array.from(items.values()).sort((left, right) => {
    const leftAt = left.kind === "message" ? left.message.createdAt : left.createdAt;
    const rightAt = right.kind === "message" ? right.message.createdAt : right.createdAt;
    return Date.parse(leftAt ?? "") - Date.parse(rightAt ?? "");
  });
  return {
    ...conversation,
    timeline,
    messages: timeline.flatMap((item) => item.kind === "message" ? [item.message] : []),
  };
}

function getInitialConversations(): Conversation[] {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return initialConversations;
    const parsed: unknown = JSON.parse(saved);
    return Array.isArray(parsed) ? (parsed as Conversation[]) : initialConversations;
  } catch {
    return initialConversations;
  }
}

function App() {
  const [conversations, setConversations] = useState<Conversation[]>(() =>
    demoMode ? getInitialConversations() : [],
  );
  const [activeId, setActiveId] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState("");
  const [toast, setToast] = useState("");
  const [mobileShowChat, setMobileShowChat] = useState(false);
  const [showDetails, setShowDetails] = useState(true);
  const [showKnowledge, setShowKnowledge] = useState(false);
  const [listLoading, setListLoading] = useState(!demoMode);
  const [detailLoading, setDetailLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [listError, setListError] = useState("");
  const [detailError, setDetailError] = useState("");
  const [recordsError, setRecordsError] = useState("");
  const [directoryError, setDirectoryError] = useState("");
  const [actionError, setActionError] = useState("");
  const [connectionStatus, setConnectionStatus] = useState<RealtimeStatus>(
    demoMode ? "connected" : "connecting",
  );
  const [listCursor, setListCursor] = useState<string | null>(null);
  const [timelineCursor, setTimelineCursor] = useState<string | null>(null);
  const [listRefresh, setListRefresh] = useState(0);
  const [detailRefresh, setDetailRefresh] = useState(0);
  const [mutationPending, setMutationPending] = useState(false);
  const [sendPending, setSendPending] = useState(false);
  const [pendingSends, setPendingSends] = useState<Record<string, { id: string; body: string }>>({});
  const [approvalDecisionKeys, setApprovalDecisionKeys] = useState<Record<string, string>>({});
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [approvals, setApprovals] = useState<ApprovalSummary[]>([]);
  const [members, setMembers] = useState<DirectoryMember[]>([]);
  const [teams, setTeams] = useState<DirectoryTeam[]>([]);
  const activeIdRef = useRef(activeId);
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  useEffect(() => {
    activeIdRef.current = activeId;
  }, [activeId]);

  useEffect(() => {
    if (demoMode) localStorage.setItem(STORAGE_KEY, JSON.stringify(conversations));
  }, [conversations]);

  useEffect(() => {
    if (demoMode) return;
    const controller = new AbortController();
    setListLoading(true);
    setListError("");
    const timeout = window.setTimeout(() => {
      void inboxApi.listConversations({
        query: query.trim() || undefined,
        controlMode: filter === "ai" || filter === "human" || filter === "paused" ? filter : undefined,
        unread: filter === "unread" ? true : undefined,
      }, controller.signal).then((page) => {
        if (controller.signal.aborted) return;
        setConversations((current) =>
          page.items.map((item) => {
            const previous = current.find((conversation) => conversation.id === item.id);
            return mapConversation(item, previous?.messages ?? []);
          }),
        );
        setListCursor(page.nextCursor);
        setActiveId((current) =>
          page.items.some((item) => item.id === current) ? current : page.items[0]?.id ?? "",
        );
      }).catch((error: unknown) => {
        if (!isAbort(error)) setListError(apiErrorMessage(error));
      }).finally(() => {
        if (!controller.signal.aborted) setListLoading(false);
      });
    }, 200);
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [query, filter, listRefresh]);

  useEffect(() => {
    if (demoMode || !activeId) {
      setDetailLoading(false);
      return;
    }
    const controller = new AbortController();
    setDetailLoading(true);
    setDetailError("");
    setRecordsError("");
    setDirectoryError("");

    void Promise.all([
      inboxApi.getConversation(activeId, controller.signal),
      inboxApi.getTimeline(activeId, undefined, controller.signal),
    ]).then(([detail, timeline]) => {
      if (controller.signal.aborted) return;
      const timelineItems = mapTimeline(timeline);
      const messages = timelineItems.flatMap((item) => item.kind === "message" ? [item.message] : []);
      setConversations((current) => current.map((item) =>
        item.id === activeId ? mapConversation(detail, messages, timelineItems) : item,
      ));
      setTimelineCursor(timeline.nextCursor);
    }).catch((error: unknown) => {
      if (!isAbort(error)) setDetailError(apiErrorMessage(error));
    }).finally(() => {
      if (!controller.signal.aborted) setDetailLoading(false);
    });

    void Promise.all([
      inboxApi.getTasks(activeId, controller.signal),
      inboxApi.getApprovals(activeId, controller.signal),
    ]).then(([taskPage, approvalPage]) => {
      if (controller.signal.aborted) return;
      setTasks(taskPage.items);
      setApprovals(approvalPage.items);
    }).catch((error: unknown) => {
      if (!isAbort(error)) setRecordsError(apiErrorMessage(error));
    });

    void Promise.all([
      inboxApi.getMembers(controller.signal),
      inboxApi.getTeams(controller.signal),
    ]).then(([memberOptions, teamOptions]) => {
      if (controller.signal.aborted) return;
      setMembers(memberOptions);
      setTeams(teamOptions);
    }).catch((error: unknown) => {
      if (!isAbort(error)) setDirectoryError(apiErrorMessage(error));
    });

    return () => controller.abort();
  }, [activeId, detailRefresh]);

  useEffect(() => {
    if (demoMode) return;
    const controller = new AbortController();
    let lastStatus: RealtimeStatus = "connecting";
    void listenForEvents((event: RealtimeEvent) => {
      setListRefresh((value) => value + 1);
      if (event.conversationId && event.conversationId === activeIdRef.current) {
        setDetailRefresh((value) => value + 1);
      }
    }, (status) => {
      setConnectionStatus(status);
      if (status === "connected" && lastStatus === "reconnecting") {
        setListRefresh((value) => value + 1);
        if (activeIdRef.current) setDetailRefresh((value) => value + 1);
      }
      lastStatus = status;
    }, controller.signal);
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (demoMode) return;
    const unsettled = conversations
      .filter((conversation) => conversation.id === activeId)
      .flatMap((conversation) => conversation.messages)
      .filter((message) => message.direction === "outbound" &&
        (message.status === "queued" || message.status === "sending" || message.status === "unknown"));
    if (unsettled.length === 0) return;
    const interval = window.setInterval(() => {
      for (const message of unsettled) {
        void inboxApi.getMessage(message.id).then((updated) => {
          setConversations((current) => current.map((conversation) =>
            conversation.id === activeId
              ? {
                  ...conversation,
                  messages: conversation.messages.map((item) =>
                    item.id === updated.id ? mapMessage(updated) : item,
                  ),
                  timeline: conversation.timeline?.map((item) =>
                    item.kind === "message" && item.message.id === updated.id
                      ? { ...item, message: mapMessage(updated) }
                      : item,
                  ),
                }
              : conversation,
          ));
        }).catch((error: unknown) => {
          if (error instanceof ApiClientError && (error.status === 0 || error.status >= 500)) {
            setConnectionStatus("reconnecting");
          } else {
            setActionError(apiErrorMessage(error));
          }
        });
      }
    }, 2_500);
    return () => window.clearInterval(interval);
  }, [activeId, conversations]);

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(""), 3000);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const filteredConversations = useMemo(() => {
    if (!demoMode) return conversations;
    const normalizedQuery = query.trim().toLocaleLowerCase("ar");
    return conversations.filter((conversation) => {
      const matchesFilter =
        filter === "all" ||
        (filter === "unread" ? conversation.unread > 0 : conversation.mode === filter);
      const matchesQuery =
        !normalizedQuery ||
        `${conversation.customer} ${conversation.subject} ${conversation.id} ${conversation.preview}`
          .toLocaleLowerCase("ar")
          .includes(normalizedQuery);
      return matchesFilter && matchesQuery;
    });
  }, [conversations, filter, query]);

  const activeConversation = filteredConversations.find((conversation) => conversation.id === activeId)
    ?? filteredConversations[0];

  const updateConversation = (
    id: string,
    updater: (conversation: Conversation) => Conversation,
  ) => {
    setConversations((current) =>
      current.map((conversation) =>
        conversation.id === id ? updater(conversation) : conversation,
      ),
    );
  };

  const changeControl = async (mode: ControlMode) => {
    if (!activeConversation) return;
    if (!demoMode) {
      setMutationPending(true);
      setActionError("");
      try {
        await inboxApi.setControl(activeConversation.id, mode, activeConversation.controlVersion ?? 0);
        setToast(mode === "human" ? "أصبحت المحادثة تحت تحكمك" : mode === "paused" ? "تم إيقاف ردود الذكاء الاصطناعي" : "أُعيد التحكم إلى المساعد الذكي");
        setListRefresh((value) => value + 1);
        setDetailRefresh((value) => value + 1);
      } catch (error) {
        setActionError(apiErrorMessage(error));
        if (error instanceof ApiClientError && error.status === 409) {
          setListRefresh((value) => value + 1);
          setDetailRefresh((value) => value + 1);
        }
      } finally {
        setMutationPending(false);
      }
      return;
    }
    const labels: Record<ControlMode, string> = {
      ai: "أُعيد التحكم إلى المساعد الذكي",
      human: "أصبحت المحادثة تحت تحكمك",
      paused: "تم إيقاف ردود الذكاء الاصطناعي",
    };
    updateConversation(activeConversation.id, (conversation) => ({
      ...conversation,
      mode,
    }));
    setToast(labels[mode]);
  };

  const sendMessage = async () => {
    const body = draft.trim();
    if (!body || !activeConversation || activeConversation.mode === "ai") return;
    if (!demoMode) {
      const pending = pendingSends[activeConversation.id] ?? { id: crypto.randomUUID(), body };
      if (pending.body !== body && pendingSends[activeConversation.id]) return;
      setPendingSends((current) => ({ ...current, [activeConversation.id]: pending }));
      setSendPending(true);
      setActionError("");
      try {
        const response = await inboxApi.sendMessage(
          activeConversation.id,
          pending.body,
          activeConversation.controlVersion ?? 0,
          pending.id,
        );
        const message = mapMessage(response.message);
        setConversations((current) => current.map((conversation) =>
          conversation.id === activeConversation.id
            ? {
                ...conversation,
                preview: message.body,
                time: "الآن",
                messages: [...conversation.messages.filter((item) => item.id !== message.id), message],
                timeline: [
                  ...(conversation.timeline ?? conversation.messages.map((item) => ({ kind: "message" as const, message: item }))),
                  { kind: "message", message },
                ],
              }
            : conversation,
        ));
        setPendingSends((current) => {
          const next = { ...current };
          delete next[activeConversation.id];
          return next;
        });
        if (activeIdRef.current === activeConversation.id) setDraft("");
        setToast("تم قبول الرسالة للإرسال");
        setListRefresh((value) => value + 1);
        setDetailRefresh((value) => value + 1);
      } catch (error) {
        setActionError(apiErrorMessage(error));
        if (error instanceof ApiClientError && error.status === 409) {
          setListRefresh((value) => value + 1);
          setDetailRefresh((value) => value + 1);
        }
        if (error instanceof ApiClientError &&
            error.status > 0 &&
            error.status < 500 &&
            error.code !== "STALE_CONTROL_VERSION" &&
            error.code !== "MANUAL_REPLY_NOT_ALLOWED") {
          setPendingSends((current) => {
            const next = { ...current };
            delete next[activeConversation.id];
            return next;
          });
        }
      } finally {
        setSendPending(false);
      }
      return;
    }
    const message: Message = {
      id: `message-${Date.now()}`,
      body,
      direction: "outbound",
      sender: "human",
      time: new Intl.DateTimeFormat("ar-SA", {
        hour: "numeric",
        minute: "2-digit",
      }).format(new Date()),
      status: "delivered",
    };
    updateConversation(activeConversation.id, (conversation) => ({
      ...conversation,
      messages: [...conversation.messages, message],
      preview: body,
      time: "الآن",
      unread: 0,
    }));
    setDraft("");
    setToast("تم إرسال الرسالة");
  };

  const selectConversation = async (conversation: Conversation) => {
    activeIdRef.current = conversation.id;
    setActiveId(conversation.id);
    setDraft(pendingSends[conversation.id]?.body ?? "");
    setMobileShowChat(true);
    if (conversation.unread > 0) {
      if (demoMode) {
        updateConversation(conversation.id, (current) => ({ ...current, unread: 0 }));
      } else {
        try {
          const response = await inboxApi.markConversationRead(conversation.id);
          updateConversation(conversation.id, (current) => ({ ...current, unread: response.unreadCount }));
          setListRefresh((value) => value + 1);
        } catch (error) {
          setActionError(apiErrorMessage(error));
        }
      }
    }
  };

  const loadMoreConversations = async () => {
    if (!listCursor || listLoading || demoMode) return;
    setLoadingMore(true);
    try {
      const page = await inboxApi.listConversations({
        query: query.trim() || undefined,
        controlMode: filter === "ai" || filter === "human" || filter === "paused" ? filter : undefined,
        unread: filter === "unread" ? true : undefined,
        cursor: listCursor,
      });
      setConversations((current) => {
        const existing = new Set(current.map((item) => item.id));
        return [
          ...current,
          ...page.items.filter((item) => !existing.has(item.id)).map((item) => mapConversation(item)),
        ];
      });
      setListCursor(page.nextCursor);
      setListError("");
    } catch (error) {
      setListError(apiErrorMessage(error));
    } finally {
      setLoadingMore(false);
    }
  };

  const loadOlderMessages = async () => {
    if (!activeConversation || !timelineCursor || demoMode) return;
    setLoadingMore(true);
    try {
      const page = await inboxApi.getTimeline(activeConversation.id, timelineCursor);
      const older = mapTimeline(page);
      setConversations((current) => current.map((conversation) =>
        conversation.id === activeConversation.id
          ? mergeTimeline(conversation, older)
          : conversation,
      ));
      setTimelineCursor(page.nextCursor);
    } catch (error) {
      setDetailError(apiErrorMessage(error));
    } finally {
      setLoadingMore(false);
    }
  };

  const assignConversation = async (assignment: { assigneeUserId: string } | { teamId: string }) => {
    if (!activeConversation || demoMode) return;
    setMutationPending(true);
    setActionError("");
    try {
      await inboxApi.assignConversation(
        activeConversation.id,
        activeConversation.controlVersion ?? 0,
        assignment,
      );
      setListRefresh((value) => value + 1);
      setDetailRefresh((value) => value + 1);
    } catch (error) {
      setActionError(apiErrorMessage(error));
      if (error instanceof ApiClientError && error.status === 409) {
        setListRefresh((value) => value + 1);
        setDetailRefresh((value) => value + 1);
      }
    } finally {
      setMutationPending(false);
    }
  };

  const decideApproval = async (
    approval: ApprovalSummary,
    decision: "approve" | "reject",
  ) => {
    if (demoMode || !approval.actionHash) return;
    const idempotencyKey = approvalDecisionKeys[approval.id] ?? crypto.randomUUID();
    setApprovalDecisionKeys((current) => ({ ...current, [approval.id]: idempotencyKey }));
    setMutationPending(true);
    setActionError("");
    try {
      const result = await inboxApi.decideApproval(
        approval.id,
        decision,
        approval.actionHash,
        idempotencyKey,
      );
      setApprovalDecisionKeys((current) => {
        const next = { ...current };
        delete next[approval.id];
        return next;
      });
      setToast(
        result.status === "approved"
          ? "تمت الموافقة؛ لم يُنفّذ الإجراء الخارجي"
          : "تم رفض طلب الإجراء",
      );
      setDetailRefresh((value) => value + 1);
    } catch (error) {
      setActionError(apiErrorMessage(error));
      if (error instanceof ApiClientError && error.status === 409) {
        setDetailRefresh((value) => value + 1);
      }
    } finally {
      setMutationPending(false);
    }
  };

  const unreadCount = conversations.reduce((count, conversation) => count + conversation.unread, 0);
  const activeAiCount = conversations.filter((conversation) => conversation.mode === "ai").length;
  const connectionLabel: Record<RealtimeStatus, string> = {
    connecting: "جارٍ الاتصال بالخادم",
    connected: demoMode ? "وضع تجريبي محلي" : "متصل بالخادم",
    reconnecting: "الاتصال منقطع — جارٍ إعادة المحاولة",
    unauthorized: "يلزم تسجيل الدخول",
  };

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark"><Sparkles size={19} strokeWidth={2.3} /></div>
          <div className="brand-copy">
            <strong>NexaDesk<span> AI</span></strong>
            <small>مركز التواصل</small>
          </div>
          <button className="icon-button workspace-switch" aria-label="تغيير مساحة العمل، غير متاح حاليًا" title="غير متاح حاليًا" disabled>
            <ChevronDown size={16} />
          </button>
        </div>

        <div className="workspace-card">
          <div className="workspace-logo">ن</div>
          <div className="workspace-copy">
            <strong>متجر نُقطة</strong>
            <span><span className="live-dot" /> مساحة العمل الرئيسية</span>
          </div>
          <MoreHorizontal size={18} className="muted-icon" />
        </div>

        <div className="side-label">مساحة العمل</div>
        <nav className="main-nav" aria-label="القائمة الرئيسية">
          <NavButton icon={<LayoutDashboard size={18} />} label="نظرة عامة" active={false} disabled />
          <NavButton icon={<Inbox size={18} />} label="صندوق الوارد" active count={unreadCount} onClick={() => setMobileShowChat(false)} />
          <NavButton icon={<UsersRound size={18} />} label="العملاء" active={false} disabled />
          <NavButton icon={<FileText size={18} />} label="قاعدة المعرفة" active={showKnowledge} disabled={demoMode} onClick={() => setShowKnowledge(true)} />
        </nav>

        <div className="side-label channels-label">القنوات <button className="tiny-add" aria-label="إضافة قناة، غير متاحة حاليًا" title="غير متاح حاليًا" disabled>+</button></div>
        <div className="channel-list">
          <ChannelRow icon={<MessageCircle size={16} />} label="واتساب" count="٢٤" color="whatsapp" />
          <ChannelRow icon={<Mail size={16} />} label="البريد الإلكتروني" count="١٢" color="mail" />
          <ChannelRow icon={<Wifi size={16} />} label="محادثة الموقع" count="٨" color="web" />
          <ChannelRow icon={<Instagram size={16} />} label="إنستغرام" count="" color="instagram" />
        </div>

        <div className="sidebar-bottom">
          <div className="plan-card">
            <div className="plan-heading"><span><Zap size={14} /> الخطة الاحترافية</span><span>٧٢٪</span></div>
            <div className="plan-meter"><span /></div>
            <small>٣٬٦١٠ من ٥٬٠٠٠ محادثة هذا الشهر</small>
            <button disabled title="إدارة الاشتراك غير متاحة حاليًا">ترقية الخطة <ArrowLeft size={13} /></button>
          </div>
          <NavButton icon={<Settings2 size={18} />} label="الإعدادات" active={false} disabled />
          <button className="profile-row" disabled title="إدارة الملف الشخصي غير متاحة حاليًا">
            <div className="profile-avatar">مم</div>
            <span className="profile-name"><strong>مريم محمد</strong><small>مديرة الحساب</small></span>
            <MoreHorizontal size={18} className="muted-icon" />
          </button>
        </div>
      </aside>

      <main className="main-area">
        {showKnowledge ? (
          <KnowledgePanel onBack={() => setShowKnowledge(false)} />
        ) : (
          <>
        <header className="topbar">
          <div className="breadcrumb">
            <span>مساحة العمل</span><ChevronLeft size={14} /><strong>صندوق الوارد</strong>
            <span className={`live-pill ${connectionStatus !== "connected" ? "disconnected" : ""}`}><span className="live-dot" /> {connectionLabel[connectionStatus]}</span>
          </div>
          <div className="topbar-actions">
            <button className="help-button" disabled title="مركز المساعدة غير متاح حاليًا"><CircleHelp size={16} /> مركز المساعدة</button>
            <button className="icon-button notification-button" aria-label="الإشعارات، غير متاحة حاليًا" title="غير متاح حاليًا" disabled><Bell size={18} /><i /></button>
            <div className="top-divider" />
            <div className="today-label"><span>الثلاثاء، ٢٠ أكتوبر ٢٠٢٦</span><strong>مرحبًا، مريم 👋</strong></div>
            <div className="profile-avatar top-avatar">مم</div>
          </div>
        </header>

        <section className="page-heading">
          <div>
            <div className="eyebrow"><span className="eyebrow-line" /> مركز خدمة العملاء</div>
            <h1>صندوق الوارد <span className="heading-count">{conversations.length}</span></h1>
            <p>كل محادثات عملائك في مكان واحد، مع مساعد ذكي يعمل بجانب فريقك.</p>
          </div>
          <div className="heading-actions">
            <button className="outline-button" disabled title="التقارير غير متاحة حاليًا"><Activity size={16} /> عرض التقارير</button>
            <button className="primary-button" disabled title="إعداد القنوات غير متاح حاليًا"><span>+</span> ربط قناة جديدة</button>
          </div>
        </section>

        <section className="stats-row" aria-label="مؤشرات صندوق الوارد">
          <StatCard icon={<MessageCircle size={17} />} label="إجمالي المحادثات" value="١٬٢٨٤" change="+١٢٫٨٪" detail="مقارنة بالأسبوع الماضي" tone="violet" />
          <StatCard icon={<Sparkles size={17} />} label="حلول بالذكاء الاصطناعي" value="٨٦٫٤٪" change="+٥٫٢٪" detail="من إجمالي المحادثات" tone="green" />
          <StatCard icon={<Clock3 size={17} />} label="متوسط أول رد" value="٢٫٤ د" change="−١٨٪" detail="أسرع من الأسبوع الماضي" tone="blue" />
          <StatCard icon={<UserRoundCheck size={17} />} label="بانتظار الفريق" value={new Intl.NumberFormat("ar-SA", { minimumIntegerDigits: 2 }).format(conversations.filter((item) => item.mode !== "ai").length)} change="تحتاج متابعة" detail="محادثات تحت التحكم البشري" tone="amber" />
        </section>

        <section className={`inbox-layout ${showDetails ? "" : "details-hidden"} ${mobileShowChat ? "mobile-chat-open" : ""}`}>
          <div className="conversation-panel">
            <div className="panel-heading">
              <div><h2>المحادثات</h2><span>{conversations.length} محادثة</span></div>
              <button className="icon-button panel-more" aria-label="خيارات المحادثات، غير متاحة حاليًا" title="غير متاح حاليًا" disabled><MoreHorizontal size={19} /></button>
            </div>
            {listError && <div className="api-notice error" role="alert">{listError}<button onClick={() => setListRefresh((value) => value + 1)}>إعادة المحاولة</button></div>}
            {actionError && <div className="api-notice error" role="alert">{actionError}<button aria-label="إغلاق التنبيه" onClick={() => setActionError("")}><X size={13} /></button></div>}
            <div className="search-box">
              <Search size={16} />
              <input ref={searchInputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ابحث عن محادثة أو عميل..." aria-label="البحث في المحادثات" />
              <kbd>⌘ K</kbd>
            </div>
            <div className="filter-tabs" role="tablist" aria-label="تصفية المحادثات">
              <FilterButton label="الكل" value="all" active={filter === "all"} onClick={setFilter} />
              <FilterButton label="غير مقروء" value="unread" active={filter === "unread"} onClick={setFilter} />
              <FilterButton label="ردود AI" value="ai" active={filter === "ai"} onClick={setFilter} />
              <FilterButton label="تحت المراجعة" value="human" active={filter === "human"} onClick={setFilter} />
              <FilterButton label="متوقف" value="paused" active={filter === "paused"} onClick={setFilter} />
            </div>
            <div className="conversation-list">
              {listLoading && conversations.length === 0 ? <div className="empty-list"><span className="loading-spinner" /><strong>جارٍ تحميل المحادثات</strong></div>
                : filteredConversations.length ? filteredConversations.map((conversation) => (
                <ConversationRow key={conversation.id} conversation={conversation} selected={conversation.id === activeConversation?.id} onClick={() => selectConversation(conversation)} />
              )) : <div className="empty-list"><Search size={20} /><strong>{listError ? "تعذر تحميل المحادثات" : "لا توجد نتائج"}</strong><span>{listError ? "تحقق من الاتصال بالخادم ثم أعد المحاولة." : "جرّب كلمة بحث أو تصفية مختلفة."}</span></div>}
            </div>
            {(demoMode || listCursor) && <button className="load-more" onClick={demoMode ? () => setToast("تعرض هذه النسخة جميع المحادثات التجريبية") : loadMoreConversations} disabled={loadingMore || listLoading}>
              {loadingMore ? "جارٍ التحميل..." : "عرض المزيد من المحادثات"} <ArrowLeft size={14} />
            </button>}
          </div>

          {activeConversation ? (
            <ConversationView
              conversation={activeConversation}
              draft={draft}
              setDraft={setDraft}
              onSend={sendMessage}
              onControl={changeControl}
              onLoadOlder={loadOlderMessages}
              timelineCursor={timelineCursor}
              detailLoading={detailLoading}
              loadingMore={loadingMore}
              detailError={detailError}
              mutationPending={mutationPending}
              sendPending={sendPending}
              pendingSend={Boolean(pendingSends[activeConversation.id])}
              onToggleDetails={() => setShowDetails((current) => !current)}
              onBack={() => setMobileShowChat(false)}
            />
          ) : (
            <div className="no-conversation"><Inbox size={28} /><strong>{listLoading ? "جارٍ تحميل المحادثات" : "لا توجد محادثات"}</strong></div>
          )}

          {activeConversation && showDetails && (
            <DetailsPanel
              conversation={activeConversation}
              activeAiCount={activeAiCount}
              demoMode={demoMode}
              members={members}
              teams={teams}
              tasks={tasks}
              approvals={approvals}
              recordsError={recordsError}
              directoryError={directoryError}
              mutationPending={mutationPending}
              onAssignUser={(userId) => void assignConversation({ assigneeUserId: userId })}
              onAssignTeam={(teamId) => void assignConversation({ teamId })}
              onDecideApproval={(approval, decision) => void decideApproval(approval, decision)}
            />
          )}
        </section>
          </>
        )}
      </main>

      {toast && <div className="toast"><span className="toast-check"><Check size={14} /></span>{toast}<button aria-label="إغلاق" onClick={() => setToast("")}><X size={14} /></button></div>}
    </div>
  );
}

function NavButton({ icon, label, active, count, disabled = false, onClick }: { icon: React.ReactNode; label: string; active: boolean; count?: number; disabled?: boolean; onClick?: () => void }) {
  return <button className={`nav-button ${active ? "active" : ""}`} disabled={disabled} title={disabled ? `${label} غير متاح حاليًا` : undefined} onClick={onClick}>{icon}<span>{label}</span>{count !== undefined && count > 0 && <small>{count}</small>}</button>;
}

function ChannelRow({ icon, label, count, color }: { icon: React.ReactNode; label: string; count: string; color: string }) {
  return <button className="channel-row" disabled title="إدارة القنوات غير متاحة حاليًا"><span className={`channel-icon ${color}`}>{icon}</span><span>{label}</span>{count && <small>{count}</small>}</button>;
}

function StatCard({ icon, label, value, change, detail, tone }: { icon: React.ReactNode; label: string; value: string; change: string; detail: string; tone: string }) {
  return <article className="stat-card"><div className="stat-top"><span className={`stat-icon ${tone}`}>{icon}</span><span className={`stat-change ${tone}`}>{change}</span></div><strong className="stat-value">{value}</strong><span className="stat-label">{label}</span><small>{detail}</small></article>;
}

function FilterButton({ label, value, active, onClick }: { label: string; value: Filter; active: boolean; onClick: (value: Filter) => void }) {
  return <button role="tab" aria-selected={active} className={active ? "active" : ""} onClick={() => onClick(value)}>{label}</button>;
}

function ConversationRow({ conversation, selected, onClick }: { conversation: Conversation; selected: boolean; onClick: () => void }) {
  const modeLabel: Record<ControlMode, string> = { ai: "AI يرد", human: "تحكم بشري", paused: "AI متوقف" };
  return (
    <button className={`conversation-row ${selected ? "selected" : ""}`} onClick={onClick}>
      <div className={`customer-avatar avatar-${conversation.initials.charCodeAt(0) % 5}`}>{conversation.initials}<span className={`channel-badge ${conversation.channel}`}>{channelIcon(conversation.channel, 10)}</span></div>
      <div className="conversation-content">
        <div className="conversation-line"><strong>{conversation.customer}</strong><time>{conversation.time}</time></div>
        <div className="conversation-subject">{conversation.subject}</div>
        <div className="conversation-preview">{conversation.preview}</div>
        <div className="conversation-meta"><span className={`mode-label ${conversation.mode}`}><i />{modeLabel[conversation.mode]}</span>{conversation.priority === "high" && <span className="priority-label">عاجل</span>}{conversation.unread > 0 && <span className="unread-dot">{conversation.unread}</span>}</div>
      </div>
    </button>
  );
}

function ConversationView({ conversation, draft, setDraft, onSend, onControl, onLoadOlder, timelineCursor, detailLoading, loadingMore, detailError, mutationPending, sendPending, pendingSend, onToggleDetails, onBack }: {
  conversation: Conversation;
  draft: string;
  setDraft: (value: string) => void;
  onSend: () => void;
  onControl: (mode: ControlMode) => void;
  onLoadOlder: () => void;
  timelineCursor: string | null;
  detailLoading: boolean;
  loadingMore: boolean;
  detailError: string;
  mutationPending: boolean;
  sendPending: boolean;
  pendingSend: boolean;
  onToggleDetails: () => void;
  onBack: () => void;
}) {
  const controlDetails: Record<ControlMode, { title: string; description: string; icon: React.ReactNode; tone: string }> = {
    ai: { title: "المساعد الذكي يرد", description: "يتولى NexaDesk الرد على هذه المحادثة", icon: <Sparkles size={15} />, tone: "ai" },
    human: { title: "أنت تتحكم بالمحادثة", description: "الردود الآلية متوقفة حتى تعيد التحكم", icon: <UserRoundCheck size={15} />, tone: "human" },
    paused: { title: "المساعد الذكي متوقف مؤقتًا", description: "لن يتم إرسال ردود تلقائية جديدة", icon: <Pause size={15} />, tone: "paused" },
  };
  const control = controlDetails[conversation.mode];
  const canReply = conversation.mode !== "ai" && conversation.status !== "closed";

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <button className="icon-button mobile-back-button" aria-label="العودة إلى المحادثات" onClick={onBack}><ArrowLeft size={17} /></button>
        <div className="chat-customer">
          <div className={`customer-avatar header-avatar avatar-${conversation.initials.charCodeAt(0) % 5}`}>{conversation.initials}</div>
          <div><strong>{conversation.customer}</strong><span><span className="online-dot" /> نشط الآن <span className="header-separator">·</span> {conversation.id}</span></div>
        </div>
        <div className="chat-header-actions">
          <button className="icon-button" aria-label="الاتصال غير متاح حاليًا" title="غير متاح حاليًا" disabled><Headphones size={17} /></button>
          <button className="icon-button" aria-label="خيارات المحادثة غير متاحة حاليًا" title="غير متاح حاليًا" disabled><MoreHorizontal size={19} /></button>
          <div className="header-action-divider" />
          <button className="icon-button details-toggle" aria-label="عرض تفاصيل العميل" onClick={onToggleDetails}><UsersRound size={17} /></button>
          {conversation.mode === "ai" ? (
            <button className="takeover-button" disabled={mutationPending || conversation.status === "closed"} onClick={() => onControl("human")}><UserRoundCheck size={15} /> استلام المحادثة</button>
          ) : conversation.mode === "human" ? (
            <button className="resume-button" disabled={mutationPending || conversation.status === "closed"} onClick={() => onControl("ai")}><Sparkles size={15} /> إعادة إلى AI</button>
          ) : (
            <button className="resume-button" disabled={mutationPending || conversation.status === "closed"} onClick={() => onControl("ai")}><Sparkles size={15} /> استئناف AI</button>
          )}
        </div>
      </div>

      <div className={`control-banner ${control.tone}`}>
        <span className="control-icon">{control.icon}</span>
        <div><strong>{control.title}</strong><span>{control.description}</span></div>
        <div className="control-actions">
          {conversation.mode === "ai" && <button disabled={mutationPending || conversation.status === "closed"} onClick={() => onControl("paused")}><Pause size={13} /> إيقاف مؤقت</button>}
          {conversation.mode !== "ai" && conversation.mode !== "paused" && <button disabled={mutationPending || conversation.status === "closed"} onClick={() => onControl("paused")}><Pause size={13} /> إيقاف AI</button>}
          <button className="banner-more" aria-label="خيارات التحكم الإضافية غير متاحة حاليًا" title="غير متاح حاليًا" disabled><MoreHorizontal size={17} /></button>
        </div>
      </div>

      <div className="message-area">
        {timelineCursor && <button className="load-history" disabled={detailLoading || loadingMore} onClick={onLoadOlder}>{loadingMore ? "جارٍ تحميل السجل..." : "تحميل الرسائل الأقدم"}</button>}
        {detailLoading && conversation.messages.length === 0 && <div className="message-loading"><span className="loading-spinner" /> جارٍ تحميل سجل المحادثة</div>}
        {detailError && <div className="api-notice error" role="alert">{detailError}<span>حالة المحادثة لم تتغير محليًا.</span></div>}
        <div className="date-divider"><span />اليوم، ٢٠ أكتوبر<span /></div>
        {conversation.timeline
          ? conversation.timeline.map((item, index) => {
              if (item.kind === "event") return <TimelineEvent key={`event-${item.id}`} item={item} />;
              const previousItem = index > 0 ? conversation.timeline?.[index - 1] : undefined;
              const previous = previousItem?.kind === "message" ? previousItem.message : undefined;
              return <MessageBubble key={item.message.id} message={item.message} previous={previous} customerInitials={conversation.initials} />;
            })
          : conversation.messages.map((message, index) => <MessageBubble key={message.id} message={message} previous={conversation.messages[index - 1]} customerInitials={conversation.initials} />)}
        <div className="conversation-end"><span><CheckCheck size={13} /> {demoMode ? "بيانات تجريبية محلية" : "حالة الرسائل من الخادم"}</span></div>
      </div>

      <div className="composer-area">
        {canReply ? (
          <div className="composer">
            <textarea
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              disabled={sendPending || pendingSend}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  onSend();
                }
              }}
              placeholder="اكتب رسالتك هنا..."
              rows={2}
              aria-label="اكتب رسالة"
            />
            <div className="composer-toolbar">
              <div><button className="composer-tool" aria-label="إرفاق الملفات غير متاح حاليًا" title="غير متاح حاليًا" disabled><Paperclip size={16} /></button><button className="composer-tool" aria-label="قوالب الرد غير متاحة حاليًا" title="غير متاح حاليًا" disabled><FileText size={16} /></button><span className="reply-as"><UserRound size={12} /> الرد باسمك</span></div>
              <button className="send-button" onClick={onSend} disabled={!draft.trim() || sendPending}>
                <Send size={15} /> {sendPending ? "جارٍ الإرسال..." : pendingSend ? "إعادة المحاولة الآمنة" : "إرسال"} <span>↵</span>
              </button>
            </div>
          </div>
        ) : (
          <div className="ai-composer-locked"><span><Bot size={17} /></span><div><strong>{conversation.status === "closed" ? "هذه المحادثة مغلقة" : "المساعد الذكي يتولى هذه المحادثة"}</strong><small>{conversation.status === "closed" ? "لا يمكن إرسال ردود إلى محادثة مغلقة." : "استلم المحادثة لتتمكن من إرسال رد يدوي."}</small></div>{conversation.status !== "closed" && <button disabled={mutationPending} onClick={() => onControl("human")}>استلام الآن <ArrowLeft size={13} /></button>}</div>
        )}
        <div className="composer-footnote"><ShieldCheck size={12} /> {canReply ? "رسالتك ستُرسل باسم فريق متجر نُقطة" : "الردود الآلية تخضع لسياسات الأمان والتحكم البشري"} <span>مدعوم من NexaDesk AI</span></div>
      </div>
    </div>
  );
}

function MessageBubble({ message, previous, customerInitials }: { message: Message; previous?: Message; customerInitials: string }) {
  const outgoing = message.direction === "outbound";
  const isAgent = message.sender === "agent" || message.sender === "system";
  const grouped = previous?.sender === message.sender && previous.direction === message.direction;
  const statusLabel: Record<NonNullable<Message["status"]>, string> = {
    queued: "بانتظار الإرسال",
    sending: "جارٍ الإرسال",
    accepted: "قُبل لدى القناة",
    delivered: "تم التسليم",
    read: "مقروءة",
    failed: "فشل الإرسال",
    unknown: "حالة غير معروفة",
  };
  return (
    <div className={`message-row ${outgoing ? "outgoing" : "incoming"} ${grouped ? "grouped" : ""}`}>
      {!outgoing && !grouped && <div className="message-avatar">{customerInitials}</div>}
      {outgoing && isAgent && !grouped && <div className="bot-avatar"><Sparkles size={12} /></div>}
      <div className="message-stack">
        {!grouped && <div className="message-sender">{outgoing ? (isAgent ? "NexaDesk AI" : "مريم محمد") : "العميل"} <time>{message.time}</time></div>}
        <div className={`message-bubble ${outgoing ? (isAgent ? "agent-message" : "human-message") : "customer-message"}`}>
          {message.body}
          {outgoing && message.status && <span className={`message-status delivery-${message.status}`}>{(message.status === "delivered" || message.status === "read") && <CheckCheck size={13} />}{statusLabel[message.status]}</span>}
        </div>
      </div>
    </div>
  );
}

function TimelineEvent({ item }: { item: Extract<ConversationTimelineItem, { kind: "event" }> }) {
  const label = item.eventType === "control_changed"
    ? "تم تحديث حالة التحكم"
    : item.eventType === "conversation_assigned"
      ? "تم تحديث إسناد المحادثة"
      : "تحديث في المحادثة";
  const time = new Intl.DateTimeFormat("ar-SA", { hour: "numeric", minute: "2-digit" })
    .format(new Date(item.createdAt));
  return <div className="timeline-event"><span>{label}</span><time>{time}</time></div>;
}

function DetailsPanel({
  conversation,
  activeAiCount,
  demoMode: isDemo,
  members,
  teams,
  tasks,
  approvals,
  recordsError,
  directoryError,
  mutationPending,
  onAssignUser,
  onAssignTeam,
  onDecideApproval,
}: {
  conversation: Conversation;
  activeAiCount: number;
  demoMode: boolean;
  members: DirectoryMember[];
  teams: DirectoryTeam[];
  tasks: TaskSummary[];
  approvals: ApprovalSummary[];
  recordsError: string;
  directoryError: string;
  mutationPending: boolean;
  onAssignUser: (userId: string) => void;
  onAssignTeam: (teamId: string) => void;
  onDecideApproval: (approval: ApprovalSummary, decision: "approve" | "reject") => void;
}) {
  const [open, setOpen] = useState(true);
  const modeLabel: Record<ControlMode, string> = { ai: "نشط", human: "تحكم بشري", paused: "متوقف مؤقتًا" };
  const taskStatusLabel: Record<TaskSummary["status"], string> = {
    queued: "في الانتظار",
    running: "قيد التنفيذ",
    waiting_approval: "بانتظار الموافقة",
    approved_not_executed: "موافق عليها؛ لم تُنفّذ",
    succeeded: "مكتملة",
    failed: "فشلت",
    unknown: "غير معروفة",
    cancelled: "ملغاة",
  };
  const approvalStatusLabel: Record<ApprovalSummary["status"], string> = {
    pending: "بانتظار القرار",
    approved: "تمت الموافقة",
    rejected: "مرفوضة",
    expired: "منتهية",
  };
  return (
    <aside className="details-panel">
      <div className="details-heading"><h3>تفاصيل العميل</h3><button className="icon-button" aria-label="خيارات تفاصيل العميل غير متاحة حاليًا" title="غير متاح حاليًا" disabled><MoreHorizontal size={18} /></button></div>
      <div className="customer-profile">
        <div className={`customer-avatar profile-large avatar-${conversation.initials.charCodeAt(0) % 5}`}>{conversation.initials}</div>
        <strong>{conversation.customer}</strong>
        <span>عميل منذ مارس ٢٠٢٤</span>
        <div className="customer-actions"><button disabled title="بدء محادثة جديدة غير متاح حاليًا"><MessageCircle size={14} /> رسالة</button><button aria-label="خيارات العميل غير متاحة حاليًا" title="غير متاح حاليًا" disabled><MoreHorizontal size={15} /></button></div>
      </div>
      <div className="detail-section">
        <button className="section-heading" onClick={() => setOpen((value) => !value)}><span>معلومات التواصل</span><ChevronDown size={15} className={open ? "" : "rotated"} /></button>
        {open && <div className="contact-info">{conversation.email && <><label>البريد الإلكتروني</label><a href={`mailto:${conversation.email}`}>{conversation.email}</a></>}{conversation.phone && <><label>رقم الهاتف</label><a href={`tel:${conversation.phone}`}>{conversation.phone}</a></>}{!conversation.email && !conversation.phone && <span>لا توجد معلومات تواصل مسجلة.</span>}</div>}
      </div>
      <div className="detail-section">
        <div className="section-heading"><span>بيانات المحادثة</span><button className="edit-button" disabled title="تعديل البيانات غير متاح حاليًا">تعديل</button></div>
        <div className="property-row"><span>المعرّف</span><strong className="latin">{conversation.id}</strong></div>
        <div className="property-row"><span>القناة</span><strong className="channel-property">{channelIcon(conversation.channel, 14)}{channelLabel(conversation.channel)}</strong></div>
        <div className="property-row"><span>الحالة</span><strong className={`property-status ${conversation.mode}`}><i />{modeLabel[conversation.mode]}</strong></div>
        <div className="property-row"><span>المسؤول</span><strong className="assignee"><span className="mini-avatar">م</span>{conversation.assignee?.displayName ?? (isDemo ? "مريم محمد" : "غير مسند")}</strong></div>
        {!isDemo && <div className="assignment-controls">
          <label>إسناد إلى عضو
            <select value={conversation.assignee?.userId ?? ""} disabled={mutationPending || Boolean(directoryError)} onChange={(event) => event.target.value && onAssignUser(event.target.value)}>
              <option value="">اختر عضوًا...</option>
              {members.map((member) => <option key={member.userId} value={member.userId}>{member.displayName}</option>)}
            </select>
          </label>
          <label>إسناد إلى فريق
            <select value={conversation.assignee?.teamId ?? ""} disabled={mutationPending || Boolean(directoryError)} onChange={(event) => event.target.value && onAssignTeam(event.target.value)}>
              <option value="">اختر فريقًا...</option>
              {teams.map((team) => <option key={team.id} value={team.id}>{team.name}</option>)}
            </select>
          </label>
          {directoryError && <small className="inline-error">{directoryError}</small>}
        </div>}
      </div>
      <div className="detail-section">
        <div className="section-heading"><span>الوسوم</span><button className="edit-button" disabled title="تعديل الوسوم غير متاح حاليًا">+ إضافة</button></div>
        <div className="tag-list">{conversation.tags.map((tag) => <span className="customer-tag" key={tag}>{tag}<button aria-label={`حذف الوسم ${tag} غير متاح حاليًا`} title="تعديل الوسوم غير متاح حاليًا" disabled><X size={10} /></button></span>)}</div>
      </div>
      {!isDemo && <div className="detail-section">
        <div className="section-heading"><span>المهام والموافقات</span></div>
        {recordsError ? <small className="inline-error">{recordsError}</small> : <>
          <div className="status-list">
            {tasks.map((task) => <div className="status-item" key={task.id}><span>{task.taskType}</span><strong>{taskStatusLabel[task.status]}</strong></div>)}
            {approvals.map((approval) => <div className="approval-item" key={approval.id}>
              <div className="status-item"><span>{approval.requestedAction.type === "refund" ? "استرداد مبلغ" : approval.requestedAction.type === "cancel_order" ? "إلغاء طلب" : "إجراء مطلوب"}</span><strong>{approvalStatusLabel[approval.status]}</strong></div>
              {typeof approval.requestedAction.orderReference === "string" && <small>الطلب: {approval.requestedAction.orderReference}</small>}
              {typeof approval.requestedAction.amount === "number" && <small>المبلغ: {approval.requestedAction.amount}</small>}
              {approval.status === "pending" && approval.canDecide && <div className="approval-actions">
                <button disabled={mutationPending || !approval.actionHash} onClick={() => onDecideApproval(approval, "approve")}>موافقة</button>
                <button disabled={mutationPending || !approval.actionHash} onClick={() => onDecideApproval(approval, "reject")}>رفض</button>
              </div>}
              {approval.status === "pending" && !approval.canDecide && <small>يتطلب القرار صلاحية مشرف أو مسؤول مساحة العمل.</small>}
              {approval.status === "approved" && <small>الموافقة لا تنفّذ الإجراء الخارجي؛ لا يوجد منفّذ مفعّل.</small>}
            </div>)}
            {tasks.length === 0 && approvals.length === 0 && <small>لا توجد مهام أو موافقات لهذه المحادثة.</small>}
          </div>
        </>}
      </div>}
      <div className="ai-insight">
        <div className="insight-title"><span><Sparkles size={14} /></span><strong>ملخص الذكاء الاصطناعي</strong><button aria-label="خيارات الملخص غير متاحة حاليًا" title="غير متاح حاليًا" disabled><MoreHorizontal size={16} /></button></div>
        <p>{isDemo ? `${conversation.subject}. العميل ${conversation.priority === "high" ? "بحاجة إلى متابعة سريعة" : "يتواصل للاستفسار"}. ${conversation.messages.length} رسائل في هذه المحادثة.` : "لا يتوفر ملخص مولّد لهذه المحادثة حاليًا."}</p>
        <div className="insight-footer"><span><ShieldCheck size={12} /> {isDemo ? "بيانات تجريبية" : "لا يوجد ملخص خادمي"}</span>{isDemo && <button disabled title="تفاصيل الملخص غير متاحة حاليًا">عرض التفاصيل <ArrowLeft size={12} /></button>}</div>
      </div>
      <div className="agent-status">
        <div className="agent-status-icon"><Bot size={16} /></div>
        <div><strong>حالة المساعد</strong><span>{activeAiCount} محادثات نشطة الآن</span></div>
        <span className={`agent-online ${isDemo ? "" : "inactive"}`}><i /> {isDemo ? "تجريبي" : "غير مفعّل"}</span>
      </div>
    </aside>
  );
}

function channelIcon(channel: Channel, size = 14) {
  if (channel === "whatsapp") return <MessageCircle size={size} />;
  if (channel === "email") return <Mail size={size} />;
  return <Wifi size={size} />;
}

function channelLabel(channel: Channel) {
  if (channel === "whatsapp") return "واتساب";
  if (channel === "email") return "البريد الإلكتروني";
  if (channel === "web") return "محادثة الموقع";
  return channel;
}

export default App;
