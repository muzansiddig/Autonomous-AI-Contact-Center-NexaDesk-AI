import { useEffect, useState, type FormEvent } from "react";
import { ArrowRight, BookOpen, Search, Trash2, Upload } from "lucide-react";
import { ApiClientError, inboxApi } from "./api";
import type { KnowledgeDocumentSummary, KnowledgeSearchResult } from "../shared/contracts";

function errorMessage(error: unknown): string {
  if (error instanceof ApiClientError && error.status === 403) {
    return "تتطلب إضافة المستندات أو حذفها صلاحية مشرف مساحة العمل.";
  }
  if (error instanceof ApiClientError && error.status === 401) {
    return "انتهت جلسة الدخول. سجّل الدخول مجددًا.";
  }
  if (error instanceof ApiClientError && error.status === 0) {
    return "تعذر الاتصال بالخادم. لم يتم تغيير قاعدة المعرفة.";
  }
  if (error instanceof ApiClientError && error.status === 413) {
    return "المحتوى أكبر من الحد المدعوم.";
  }
  return "تعذر تنفيذ الطلب. تحقق من البيانات وحاول مرة أخرى.";
}

export default function KnowledgePanel({ onBack }: { onBack: () => void }) {
  const [documents, setDocuments] = useState<KnowledgeDocumentSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [sourceKey, setSourceKey] = useState("");
  const [sourceName, setSourceName] = useState("");
  const [mediaType, setMediaType] = useState<"text/plain" | "text/markdown">("text/markdown");
  const [content, setContent] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<KnowledgeSearchResult[]>([]);

  const refreshDocuments = async (signal?: AbortSignal) => {
    setLoading(true);
    try {
      const items = await inboxApi.getKnowledgeDocuments(signal);
      if (!signal?.aborted) {
        setDocuments(items);
        setError("");
      }
    } catch (failure) {
      if (!signal?.aborted) setError(errorMessage(failure));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  };

  useEffect(() => {
    const controller = new AbortController();
    void refreshDocuments(controller.signal);
    return () => controller.abort();
  }, []);

  const registerDocument = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPending(true);
    setError("");
    try {
      const created = await inboxApi.registerKnowledgeDocument({
        sourceKey,
        sourceName,
        mediaType,
        content,
      });
      setDocuments((current) => [
        created,
        ...current.filter((document) => document.sourceKey !== created.sourceKey),
      ]);
      setResults([]);
      setSourceKey("");
      setSourceName("");
      setContent("");
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  };

  const deleteDocument = async (document: KnowledgeDocumentSummary) => {
    setPending(true);
    setError("");
    try {
      await inboxApi.deleteKnowledgeDocument(document.id);
      setDocuments((current) =>
        current.map((item) =>
          item.id === document.id ? { ...item, status: "deleted" } : item,
        ),
      );
      setResults([]);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setPending(false);
    }
  };

  const search = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");
    try {
      const response = await inboxApi.searchKnowledge(query);
      setResults(response.items);
    } catch (failure) {
      setError(errorMessage(failure));
    }
  };

  return (
    <section className="knowledge-page" dir="rtl">
      <header className="knowledge-page__header">
        <button type="button" className="knowledge-back" onClick={onBack}>
          <ArrowRight size={16} /> العودة إلى صندوق الوارد
        </button>
        <div>
          <span className="knowledge-eyebrow"><BookOpen size={14} /> مساحة العمل</span>
          <h1>قاعدة المعرفة</h1>
          <p>سجّل مصادر نصية خاصة بمساحة العمل، واستبدل إصداراتها أو احذفها.</p>
        </div>
      </header>

      {error && <div className="knowledge-error" role="alert">{error}</div>}

      <div className="knowledge-grid">
        <section className="knowledge-card">
          <h2>إضافة مستند نصي</h2>
          <p>تُخزّن النصوص وتُقسّم إلى مقاطع. المحتوى غير موثوق ولا يُعرض كـ HTML.</p>
          <form className="knowledge-form" onSubmit={(event) => void registerDocument(event)}>
            <label>معرّف المصدر
              <input required maxLength={200} value={sourceKey} onChange={(event) => setSourceKey(event.target.value)} placeholder="سياسة-الاسترجاع" />
            </label>
            <label>اسم المستند
              <input required maxLength={200} value={sourceName} onChange={(event) => setSourceName(event.target.value)} placeholder="سياسة الاسترجاع" />
            </label>
            <label>نوع المحتوى
              <select value={mediaType} onChange={(event) => setMediaType(event.target.value as typeof mediaType)}>
                <option value="text/markdown">Markdown</option>
                <option value="text/plain">نص عادي</option>
              </select>
            </label>
            <label className="knowledge-form__content">المحتوى
              <textarea required maxLength={20_000} rows={8} value={content} onChange={(event) => setContent(event.target.value)} />
            </label>
            <button className="knowledge-primary" disabled={pending || !content.trim()} type="submit">
              <Upload size={15} /> {pending ? "جارٍ الحفظ..." : "حفظ إصدار جديد"}
            </button>
          </form>
        </section>

        <section className="knowledge-card">
          <h2>المصادر المسجّلة</h2>
          {loading ? <p>جارٍ تحميل المستندات...</p> : documents.length === 0 ? (
            <p>لا توجد مستندات مسجلة في مساحة العمل.</p>
          ) : (
            <div className="knowledge-documents">
              {documents.map((document) => (
                <article className="knowledge-document" key={document.id}>
                  <div>
                    <strong>{document.sourceName}</strong>
                    <span>{document.sourceKey} · الإصدار {document.version} · {document.chunkCount} مقاطع</span>
                    <small>{document.status === "active" ? "نشط في الاسترجاع" : "محذوف من الاسترجاع"}</small>
                  </div>
                  {document.status === "active" && (
                    <button
                      aria-label={`حذف ${document.sourceName}`}
                      disabled={pending}
                      onClick={() => void deleteDocument(document)}
                      type="button"
                    >
                      <Trash2 size={15} />
                    </button>
                  )}
                </article>
              ))}
            </div>
          )}
        </section>
      </div>

      <section className="knowledge-card knowledge-search">
        <h2>اختبار الاسترجاع</h2>
        <form className="knowledge-search__form" onSubmit={(event) => void search(event)}>
          <input aria-label="عبارة البحث" minLength={2} required value={query} onChange={(event) => setQuery(event.target.value)} placeholder="ابحث في مصادر مساحة العمل" />
          <button disabled={pending} type="submit"><Search size={15} /> بحث</button>
        </form>
        {results.map((result, index) => (
          <article className="knowledge-result" key={`${result.documentId}-${index}`}>
            <strong>{result.sourceName} · الإصدار {result.version}</strong>
            <pre>{result.chunk}</pre>
          </article>
        ))}
        {results.length === 0 && query && <p>لا توجد مقاطع مطابقة.</p>}
      </section>
    </section>
  );
}
