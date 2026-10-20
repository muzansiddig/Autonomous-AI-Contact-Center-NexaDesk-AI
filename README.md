# NexaDesk AI

منصة موحّدة لإدارة محادثات العملاء بمساعدة الذكاء الاصطناعي، مع إبقاء التحكم النهائي بيد فريق خدمة العملاء.

يتطلب المشروع Node.js 20 أو أحدث وDocker Desktop للتطوير المحلي باستخدام PostgreSQL.

## تشغيل المشروع محليًا

أنشئ إعداد التطوير المحلي ورمزًا عشوائيًا لا يغادر ملف `.env`:

```powershell
Copy-Item .env.example .env
$bytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($bytes)
$rng.Dispose()
$token = [Convert]::ToBase64String($bytes)
$contents = [IO.File]::ReadAllText(".env")
[IO.File]::WriteAllText(".env", [regex]::Replace($contents, "(?m)^DEV_AUTH_TOKEN=.*$", "DEV_AUTH_TOKEN=$token"))
$token = $null
docker compose up -d postgres
npm.cmd install
npm.cmd run db:migrate
npm.cmd run db:seed:dev
```

شغّل الـ API في نافذة طرفية:

```powershell
npm.cmd run dev:api
```

يستخدم Compose المنفذ `5433` افتراضيًا. إذا كان محجوزًا، غيّر `POSTGRES_PORT` و`DATABASE_URL` معًا في `.env` إلى منفذ متاح. لا توقف خدمة أخرى لتوفير هذا المنفذ.

وفي نافذة ثانية شغّل الواجهة:

```powershell
npm.cmd run dev
```

واجهة التطوير متاحة على `http://127.0.0.1:5173` والـ API على `http://127.0.0.1:3000`. يمرر Vite `/v1` و`/health` إلى API. في وضع التطوير المحلي فقط، يضيف Vite رمز `DEV_AUTH_TOKEN` إلى الطلب من جهة الخادم؛ لا يصل الرمز إلى JavaScript المتصفح أو ملفات الإنتاج. يرتبط خادم Vite بعنوان loopback.

نقطة الصحة الحية `GET /health/live` عامة، ونقطة الجاهزية `GET /health/ready` تفحص PostgreSQL. إعداد `DEV_AUTH_ENABLED` مخصص للتطوير والاختبارات، ويُرفض في الإنتاج. ملفات `.env` مستثناة من Git؛ لا تشارك محتواها.

## وضع الواجهة

- الوضع الافتراضي `VITE_APP_MODE=api`: مصدر المحادثات والرسائل والتحكم هو API. أخطاء الطلب لا تعيد التطبيق إلى بيانات المثال ولا تغيّر حالة المحادثة محليًا.
- `VITE_APP_MODE=demo`: يفعّل بيانات المثال و`localStorage` صراحةً للتطوير المحلي. يفشل بناء الإنتاج إذا تم ضبط هذا الوضع.
- `VITE_API_BASE_URL` اختياري؛ اتركه فارغًا للتطوير عبر Vite proxy أو استخدم عنوان API من نفس الأصل عند إعداد reverse proxy.
- `VITE_TENANT_ID` اختياري ويحدد مساحة العمل المطلوبة عبر `X-Tenant-Id`. هو محدد مساحة عمل فقط، وليس تفويضًا؛ يتحقق API من العضوية النشطة لكل طلب.

## ربط OIDC

تستخدم الواجهة `@auth0/auth0-react` مع Authorization Code + PKCE، وتحفظ الـ SDK بيانات الاعتماد في الذاكرة بدل `localStorage`. لا تضع client secret أو access token في إعدادات `VITE_*` أو في الشيفرة.

1. في Auth0، افتح **Applications > APIs** وأنشئ API مخصصًا لـ NexaDesk. استخدم Identifier خاصًا بالتطبيق مثل `https://nexadesk-api` (أو قيمة تختارها وتسجلها كما هي). لا تستخدم `https://<auth0-domain>/api/v2/`؛ فهذا هو جمهور Auth0 Management API وليس API التطبيق.
2. اضبط توقيع API على RS256، وسجّل تطبيق SPA لاستخدام Authorization Code مع PKCE.
3. أضف `http://127.0.0.1:5173` إلى Allowed Callback URLs وAllowed Logout URLs وAllowed Web Origins في إعدادات SPA، أو استخدم أصل الواجهة الذي ستفتحه فعليًا.
4. انسخ API Identifier المخصص إلى كل من `AUTH_AUDIENCE` و`VITE_AUTH0_AUDIENCE` في `.env`. اضبط `AUTH_ISSUER` و`AUTH_JWKS_URL` و`VITE_AUTH0_DOMAIN` و`VITE_AUTH0_CLIENT_ID` بالقيم الموضحة في `.env.example`. قيم `VITE_*` عامة وليست أسرارًا.
5. لاختبار OIDC محليًا، اضبط `DEV_AUTH_ENABLED=false` حتى لا يضيف Vite رمز التطوير إلى الطلبات، ثم أعد تشغيل API وVite. وضع `DEV_AUTH_ENABLED=true` يظل مسار التطوير المحلي البديل ولا يختبر JWT الصادر من Auth0.

Issuer وJWKS في المثال هما بيانات الاكتشاف العامة المؤكدة لنطاق Auth0 الحالي. يجب أن تطابق قيمة audience المختارة إعداد API في Auth0 حرفيًا. لا تعرض الواجهة صندوق الوارد في وضع API حتى تكتمل إعدادات Auth0. لا يتجاوز `X-Tenant-Id` تحقق عضوية المستأجر على الخادم.

## مسارات API المستخدمة

- `GET /v1/conversations`: البحث والتصفية والصفحات بمؤشر.
- `GET /v1/conversations/:id` و`GET /v1/conversations/:id/timeline`: التفاصيل والرسائل والأحداث، مع صفحات للسجل.
- `POST /v1/conversations/:id/read`: تعليم المقروء وفق استجابة الخادم.
- `POST /v1/conversations/:id/takeover`, `pause-ai`, `resume-ai`: تغييرات تحكم خادمية مع `expectedControlVersion`.
- `GET /v1/members`, `GET /v1/teams` و`POST /v1/conversations/:id/assign`: دليل مساحة العمل والإسناد.
- `POST /v1/conversations/:id/messages`: رد يدوي مع فحص الحالة والإصدار و`Idempotency-Key`.
- `GET /v1/messages/:id`: حالة التسليم؛ `GET /v1/events`: تحديثات SSE بمجرى fetch يدعم Bearer وإعادة الاتصال.
- `GET /v1/tasks`, `GET /v1/tasks/:id`, `GET /v1/approvals`: حالات المهام والموافقات.

عقد الأنواع والتحقق من الطلبات في `shared/contracts.ts`. أخطاء API تستخدم `code`, `requestId`, و`retryable`. أخطاء التحكم المتزامن تعيد `409 STALE_CONTROL_VERSION`.

## قاعدة البيانات والرسائل

المخطط والترحيلات في `apps/api/migrations`. أضف ترحيلًا جديدًا بدل تعديل ترحيل سبق تطبيقه. قاعدة التطوير تستخدم حجم Docker مسمى مستمرًا؛ لا تستخدم `docker compose down -v` لأنه يحذف بيانات الحجم.

إرسال الرد المحلي يضيف الرسالة وحدث outbox ضمن معاملة. test adapter لا يتصل بمزود خارجي ويحدّث الحالة إلى `accepted` فقط، وهذا ليس دليل تسليم حقيقي. يعيد العامل المحاولة فقط عند فشل مصنف صراحةً على أنه آمن؛ أما النتيجة الملتبسة فتصبح `unknown` ولا يعاد إرسالها تلقائيًا.

### Telegram

يتضمن الخادم محول Telegram للرسائل النصية الخاصة فقط. يتحقق webhook من `X-Telegram-Bot-Api-Secret-Token`، ويدعم إزالة تكرار التحديثات وحفظ الرسائل الواردة والإرسال عبر outbox. استجابة Bot API الناجحة تعني `accepted` فقط؛ لا يدعم المحول إيصالات تسليم أو قراءة Telegram، ولا يعلن `delivered`. المجموعات والوسائط غير مدعومة.

لإعداد اتصال تجريبي:

1. أنشئ bot عبر BotFather، واحفظ `TELEGRAM_BOT_TOKEN` في ملف `.env` على الخادم فقط. أنشئ قيمة عشوائية لـ `TELEGRAM_WEBHOOK_SECRET` باستخدام أحرف وأرقام و`_` أو `-`، ولا تضع أيًا منهما في إعدادات `VITE_*`.
2. اضبط `CHANNEL_ADAPTER=telegram`، ثم أعد تشغيل API. يتطلب هذا الاختيار وجود الرمزين السابقين. يُحفظ token في إعداد الخادم ولا يُكتب في قاعدة البيانات أو سجلات الطلبات.
3. وفّر عنوان HTTPS عامًّا للـ API، وأنشئ اتصال `telegram` جاهزًا لمستأجر مخوّل عبر إجراء تهيئة قاعدة بيانات موثوق، ثم استخدم معرّفه في المسار `/webhooks/telegram/:channelId`. لا توجد شاشة أو API إدارية لإنشاء اتصالات القنوات حتى الآن.
4. سجّل webhook لدى Telegram على العنوان الكامل `https://<api-host>/webhooks/telegram/<channel-id>` مع `secret_token` المطابق لـ `TELEGRAM_WEBHOOK_SECRET`. لا ترسل رسائل إلى عملاء حقيقيين أثناء الاختبار؛ استخدم حسابًا اختباريًا وبيئة تشغيل مصرحًا بها.

لم تُضبط بيانات bot حقيقية ولم تُرسل أو تُستقبل رسائل Telegram حقيقية في الاختبارات؛ التكامل مغطى بمحاكاة `fetch` واختبار PostgreSQL محلي.

تغييرات التحكم والإسناد ترفع `controlVersion` داخل معاملة. الرد اليدوي يحتاج إصدارًا حديثًا وحالة بشرية/متوقفة، والواجهة لا تعيد محاولة إرسال ملتبس تلقائيًا؛ عند عرض إعادة محاولة يظل مفتاح idempotency نفسه.

## المعرفة والوكيل التجريبي

- تعرض الواجهة لوحة معرفة لإضافة مستند نصي أو Markdown واستبدال نسخة أو حذفها والبحث فيها. تُحفظ المستندات ومقاطعها ضمن المستأجر؛ البحث الحالي نصي (`ILIKE`) وليس بحثًا دلاليًا. لا يوجد رفع ملفات أو OCR أو embeddings.
- واجهات المعرفة: `GET/POST /v1/knowledge/documents`، و`DELETE /v1/knowledge/documents/:id`، و`GET /v1/knowledge/search?q=...`. الإضافة والاستبدال والحذف تتطلب دور مشرف أو مسؤول مستأجر.
- `AGENT_PROVIDER=disabled` هو الوضع الافتراضي. للاختبار المحلي فقط، أوقف API، اضبط `AGENT_PROVIDER=fake` في `.env` ثم شغّله من جديد. هذا الموفر حتمي ولا يستدعي نموذجًا خارجيًا أو خدمة مدفوعة.
- يتضمن الخادم محول OpenAI Chat Completions. للاستخدام المصرّح به فقط، اضبط `AGENT_PROVIDER=openai` و`OPENAI_API_KEY` و`OPENAI_MODEL` على الخادم، ثم فعّل الوكيل للمستأجر بواسطة `PUT /v1/agent/settings` بقيمة `provider: "openai"`. لا يُرسل أي طلب حتى يُفعّل المستأجر الوكيل ويُشغّل agent run. لا تضع المفتاح في المتصفح أو السجلات أو المحادثة. الاختبارات تستخدم `fetch` وهميًا؛ لم تُجرَ أي مكالمات مدفوعة أو حقيقية.
- اختبار agent محليًا: فعّل الوكيل عبر `PUT /v1/agent/settings` باستخدام `{"enabled":true,"provider":"fake","systemInstructions":"..."}` (مسؤول المستأجر فقط)، ثم أرسل حدثًا تجريبيًا عبر `POST /v1/test/conversations/:id/inbound` وشغّل `POST /v1/conversations/:id/agent-runs`. مسار inbound التجريبي متاح فقط مع `DEV_AUTH_ENABLED=true` ولا يمثل webhook لمزود.
- قرارات الوكيل محصورة في أنواع محددة. الموافقات تُقرأ من `GET /v1/approvals` ويُسجل القرار عبر `POST /v1/approvals/:id/decision` مع `actionHash`. تسجيل الموافقة لا ينفذ refund أو إلغاء أو أي إجراء خارجي؛ لا يوجد منفذ مهام/موافقات بعد.
- إعدادات الوكيل، تشغيلاته، المهام والموافقات لها API، لكن لا توجد لها حاليًا واجهة إدارة كاملة في صندوق الوارد. لا تضبط `AGENT_PROVIDER=fake` في الإنتاج؛ يرفض الإعداد ذلك.

## الاختبارات والتقييم

```powershell
npm.cmd run typecheck
npm.cmd run typecheck:api
npm.cmd run test:api
npm.cmd run test:integration
npm.cmd run test:e2e
npm.cmd run lint
npm.cmd run build
npm.cmd audit --omit=dev
```

اختبارات PostgreSQL تتطلب قاعدة التطوير المهيأة أعلاه، وتستخدم إعدادًا وهميًا صريحًا لموفر الوكيل؛ لا تتطلب تغيير موفر الإنتاج ولا تعيد ضبط قاعدة البيانات. اختبار Playwright ينشئ معرّفات وبيانات اختبار مخصصة ويحذفها بعد الاختبار، ويتطلب Chromium مثبتًا (`npx.cmd playwright install chromium`) وإعداد التطوير المحلي مع `DEV_AUTH_ENABLED=true`. الاختبار يستخدم وكيل التطوير المحلي ولا يختبر تسجيل دخول Auth0 الفعلي. لا تشغّل الاختبارات على قاعدة إنتاج أو مشتركة.

تغطي الاختبارات الحالية واجهات المصادقة وعضوية المستأجر، التحقق من JWT، منع تسرب token إلى السجلات، التحكم المتزامن ونسخ التحكم القديمة، idempotency للرسائل والموافقات وwebhook، outbox، حدود tenant لـ SSE والمعرفة، وممرات الواجهة الأساسية. راجع [مصفوفة تتبع الميزات](./docs/testing/feature-traceability.md)، و[دليل الاختبارات](./docs/testing/e2e-and-integration.md)، و[تقييمات الوكيل](./docs/testing/ai-evaluations.md) لحدود ما تم التحقق منه. لا تختبر هذه المجموعة تسجيل دخول Auth0 حقيقيًا أو إرسال Telegram حقيقيًا أو جودة استجابات LLM الحقيقية أو تنفيذ إجراء خارجي بعد الموافقة.
#   A u t o n o m o u s - A I - C o n t a c t - C e n t e r - N e x a D e s k - A I  
 