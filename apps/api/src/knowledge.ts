import { createHash, randomUUID } from "node:crypto";
import { Router } from "express";
import type { Pool } from "pg";
import {
  knowledgeDocumentRequestSchema,
  knowledgeSearchQuerySchema,
  uuidSchema,
  type KnowledgeDocumentSummary,
  type KnowledgeSearchResult,
} from "../../../shared/contracts.js";
import { requireRoles, sendError } from "./http.js";

export function splitKnowledgeContent(content: string): string[] {
  const normalized = content.replace(/\r\n?/g, "\n").trim();
  const chunks: string[] = [];
  const maxLength = 1_200;
  const overlap = 160;
  let offset = 0;

  while (offset < normalized.length) {
    let end = Math.min(offset + maxLength, normalized.length);
    if (end < normalized.length) {
      const paragraphBreak = normalized.lastIndexOf("\n\n", end);
      const lineBreak = normalized.lastIndexOf("\n", end);
      const boundary = paragraphBreak > offset + 400 ? paragraphBreak : lineBreak;
      if (boundary > offset + 400) end = boundary;
    }
    const chunk = normalized.slice(offset, end).trim();
    if (chunk) chunks.push(chunk);
    if (end === normalized.length) break;
    offset = Math.max(offset + 1, end - overlap);
  }
  return chunks;
}

export function createKnowledgeRouter(pool: Pool): Router {
  const router = Router();

  router.get("/documents", async (req, res) => {
    if (!req.auth) {
      sendError(res, 401, "UNAUTHENTICATED", "Authentication is required.");
      return;
    }
    const result = await pool.query<KnowledgeDocumentSummary>(
      `SELECT d.id, d.source_key AS "sourceKey", d.source_name AS "sourceName",
              d.version, d.media_type AS "mediaType", d.status,
              d.ingestion_error_code AS "ingestionErrorCode",
              count(k.ordinal)::int AS "chunkCount", d.created_at AS "createdAt"
       FROM knowledge_documents d
       LEFT JOIN knowledge_chunks k
         ON k.tenant_id = d.tenant_id AND k.document_id = d.id
            AND k.document_version = d.version
       WHERE d.tenant_id = $1 AND d.status <> 'replaced'
       GROUP BY d.tenant_id, d.id
       ORDER BY d.updated_at DESC, d.id DESC
       LIMIT 100`,
      [req.auth.tenantId],
    );
    res.json(result.rows.map((row) => ({
      ...row,
      createdAt: new Date(row.createdAt).toISOString(),
    })));
  });

  router.post(
    "/documents",
    requireRoles("supervisor", "tenant_admin"),
    async (req, res) => {
      const parsed = knowledgeDocumentRequestSchema.safeParse(req.body);
      if (!parsed.success || !req.auth) {
        sendError(res, 400, "INVALID_REQUEST", "Document metadata or content is invalid.");
        return;
      }
      const content = parsed.data.content.trim();
      const chunks = splitKnowledgeContent(content);
      if (chunks.length === 0 || chunks.length > 128) {
        sendError(res, 422, "DOCUMENT_TOO_LARGE", "The document could not be split into a supported number of sections.");
        return;
      }
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
          [`${req.auth.tenantId}:${parsed.data.sourceKey}`],
        );
        const current = await client.query<{ id: string; version: number }>(
          `SELECT id, version FROM knowledge_documents
           WHERE tenant_id = $1 AND source_key = $2 AND status = 'active'
           FOR UPDATE`,
          [req.auth.tenantId, parsed.data.sourceKey],
        );
        const version = (current.rows[0]?.version ?? 0) + 1;
        if (current.rows[0]) {
          await client.query(
            `UPDATE knowledge_documents
             SET status = 'replaced', updated_at = now()
             WHERE tenant_id = $1 AND id = $2`,
            [req.auth.tenantId, current.rows[0].id],
          );
        }

        const documentId = randomUUID();
        const contentHash = createHash("sha256").update(content).digest("hex");
        const created = await client.query<{ created_at: Date }>(
          `INSERT INTO knowledge_documents
             (tenant_id, id, source_key, source_name, version, content_sha256, media_type, status)
           VALUES ($1, $2, $3, $4, $5, $6, $7, 'active')
           RETURNING created_at`,
          [
            req.auth.tenantId,
            documentId,
            parsed.data.sourceKey,
            parsed.data.sourceName,
            version,
            contentHash,
            parsed.data.mediaType,
          ],
        );
        for (const [ordinal, chunk] of chunks.entries()) {
          await client.query(
            `INSERT INTO knowledge_chunks
               (tenant_id, document_id, document_version, ordinal, content)
             VALUES ($1, $2, $3, $4, $5)`,
            [req.auth.tenantId, documentId, version, ordinal, chunk],
          );
        }
        await client.query("COMMIT");
        res.status(201).json({
          id: documentId,
          sourceKey: parsed.data.sourceKey,
          sourceName: parsed.data.sourceName,
          version,
          mediaType: parsed.data.mediaType,
          status: "active",
          ingestionErrorCode: null,
          chunkCount: chunks.length,
          createdAt: created.rows[0].created_at.toISOString(),
        } satisfies KnowledgeDocumentSummary);
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
  );

  router.delete(
    "/documents/:id",
    requireRoles("supervisor", "tenant_admin"),
    async (req, res) => {
      const id = uuidSchema.safeParse(req.params.id);
      if (!id.success || !req.auth) {
        sendError(res, 400, "INVALID_REQUEST", "The document ID is invalid.");
        return;
      }
      const result = await pool.query(
        `UPDATE knowledge_documents
         SET status = 'deleted', deleted_at = now(), updated_at = now()
         WHERE tenant_id = $1 AND id = $2 AND status = 'active'
         RETURNING id`,
        [req.auth.tenantId, id.data],
      );
      if (!result.rowCount) {
        sendError(res, 404, "DOCUMENT_NOT_FOUND", "The knowledge document was not found.");
        return;
      }
      res.status(204).end();
    },
  );

  router.get("/search", async (req, res) => {
    const parsed = knowledgeSearchQuerySchema.safeParse(req.query);
    if (!parsed.success || !req.auth) {
      sendError(res, 400, "INVALID_REQUEST", "A valid search phrase is required.");
      return;
    }
    const words = parsed.data.q.split(/\s+/u).filter((word) => word.length >= 2).slice(0, 8);
    const conditions = words.map((_, index) => `k.content ILIKE $${index + 2}`).join(" OR ");
    const values: unknown[] = [
      req.auth.tenantId,
      ...words.map((word) => `%${word.replace(/[\\%_]/g, "\\$&")}%`),
      parsed.data.limit,
    ];
    const result = await pool.query<KnowledgeSearchResult>(
      `SELECT d.id AS "documentId", d.source_name AS "sourceName",
              d.version, k.content AS chunk
       FROM knowledge_chunks k
       JOIN knowledge_documents d
         ON d.tenant_id = k.tenant_id AND d.id = k.document_id
            AND d.version = k.document_version AND d.status = 'active'
       WHERE k.tenant_id = $1 AND (${conditions || "k.content ILIKE $2"})
       ORDER BY d.updated_at DESC, k.document_id, k.ordinal
       LIMIT $${words.length + 2}`,
      words.length > 0 ? values : [req.auth.tenantId, `%${parsed.data.q}%`, parsed.data.limit],
    );
    res.json({ items: result.rows });
  });

  return router;
}
