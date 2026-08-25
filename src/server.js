import { Database } from "bun:sqlite";
import { mkdir, readFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

const ROOT = path.resolve(import.meta.dir, "..");
const PUBLIC_DIR = path.join(ROOT, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT, "data");
const UPLOAD_DIR = process.env.UPLOAD_DIR || path.join(ROOT, "uploads");
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, "html-hub.sqlite");
const PORT = Number(process.env.PORT || 4173);
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 100 * 1024 * 1024);
const ALLOWED_EXTENSIONS = new Set([".pdf", ".zip", ".html", ".htm", ".ppt", ".pptx"]);

await mkdir(DATA_DIR, { recursive: true });
await mkdir(UPLOAD_DIR, { recursive: true });

const categories = await loadCategories();
const db = new Database(DB_PATH, { create: true });
db.exec("PRAGMA journal_mode = WAL");
db.exec("PRAGMA foreign_keys = ON");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS categories (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    active INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS slides (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    category_id TEXT NOT NULL REFERENCES categories(id),
    owner_user_id INTEGER NOT NULL REFERENCES users(id),
    original_name TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_path TEXT NOT NULL,
    file_type TEXT NOT NULL,
    file_size INTEGER NOT NULL,
    tags TEXT NOT NULL DEFAULT '[]',
    deleted_at TEXT,
    deleted_by_user_id INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS upload_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slide_id TEXT NOT NULL REFERENCES slides(id),
    user_id INTEGER NOT NULL REFERENCES users(id),
    event_type TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
`);
migrateDatabase();
seedCategories(categories);

Bun.serve({
  port: PORT,
  async fetch(request) {
    const url = new URL(request.url);

    try {
      if (url.pathname.startsWith("/api/")) return await routeApi(request, url);
      if (url.pathname.startsWith("/uploads/")) return await serveUpload(url.pathname);
      return await serveStatic(url.pathname);
    } catch (error) {
      console.error(error);
      return json({ error: "Internal server error" }, 500);
    }
  },
});

console.log(`HTML Hub listening on http://localhost:${PORT}`);

async function routeApi(request, url) {
  if (request.method === "GET" && url.pathname === "/api/health") {
    return json({ ok: true });
  }

  if (request.method === "GET" && url.pathname === "/api/categories") {
    return json({ categories: listCategories() });
  }

  if (request.method === "GET" && url.pathname === "/api/users") {
    return json({ users: listUsers() });
  }

  if (request.method === "GET" && url.pathname === "/api/slides") {
    return json({ slides: listSlides(url.searchParams.get("category")) });
  }

  if (request.method === "POST" && url.pathname === "/api/users/name") {
    const body = await request.json().catch(() => null);
    const name = normalizeName(body?.name);
    if (!name) return json({ error: "Name is required" }, 400);
    return json({ user: upsertUser(name) });
  }

  if (request.method === "POST" && url.pathname === "/api/slides") {
    return await handleSlideUpload(request);
  }

  const slideDeleteMatch = url.pathname.match(/^\/api\/slides\/([^/]+)$/);
  if (request.method === "DELETE" && slideDeleteMatch) {
    return await handleSlideDelete(request, slideDeleteMatch[1]);
  }

  return json({ error: "Not found" }, 404);
}

async function handleSlideUpload(request) {
  const form = await request.formData();
  const title = String(form.get("title") || "").trim();
  const categoryId = String(form.get("categoryId") || "").trim();
  const ownerName = normalizeName(form.get("ownerName"));
  const tags = parseTags(String(form.get("tags") || ""));
  const file = form.get("file");

  if (!title) return json({ error: "Title is required" }, 400);
  if (!categories.some((category) => category.id === categoryId)) return json({ error: "Invalid category" }, 400);
  if (!ownerName) return json({ error: "Owner is required" }, 400);
  if (!(file instanceof File) || file.size === 0) return json({ error: "File is required" }, 400);
  if (file.size > MAX_UPLOAD_BYTES) return json({ error: "File is too large" }, 413);

  const originalName = path.basename(file.name || "slide");
  const extension = path.extname(originalName).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) return json({ error: "Unsupported file type" }, 400);

  const owner = upsertUser(ownerName);

  const slideId = `${slugify(title)}-${Date.now().toString(36)}-${crypto.randomBytes(3).toString("hex")}`;
  const categoryDir = path.join(UPLOAD_DIR, categoryId, slideId);
  await mkdir(categoryDir, { recursive: true });

  const storedName = `original${extension || ".bin"}`;
  const absolutePath = path.join(categoryDir, storedName);
  const relativePath = path.relative(UPLOAD_DIR, absolutePath).split(path.sep).join("/");
  await Bun.write(absolutePath, file);

  db.query(`
    INSERT INTO slides (id, title, category_id, owner_user_id, original_name, file_name, file_path, file_type, file_size, tags)
    VALUES ($id, $title, $categoryId, $ownerId, $originalName, $fileName, $filePath, $fileType, $fileSize, $tags)
  `).run({
    $id: slideId,
    $title: title,
    $categoryId: categoryId,
    $ownerId: owner.id,
    $originalName: originalName,
    $fileName: storedName,
    $filePath: relativePath,
    $fileType: extension.slice(1).toUpperCase(),
    $fileSize: file.size,
    $tags: JSON.stringify(tags),
  });

  db.query("INSERT INTO upload_events (slide_id, user_id, event_type) VALUES ($slideId, $ownerId, 'uploaded')")
    .run({ $slideId: slideId, $ownerId: owner.id });

  const slide = getSlide(slideId);
  return json({ slide }, 201);
}

function listCategories() {
  return db.query(`
    SELECT c.id, c.name, c.description, c.sort_order AS sortOrder, COUNT(s.id) AS slideCount
    FROM categories c
    LEFT JOIN slides s ON s.category_id = c.id AND s.deleted_at IS NULL
    WHERE c.active = 1
    GROUP BY c.id
    ORDER BY c.sort_order, c.name
  `).all();
}

function listSlides(categoryId) {
  const sql = `
    SELECT s.id, s.title, s.category_id AS categoryId, c.name AS categoryName, u.name AS ownerName,
           s.original_name AS originalName, s.file_type AS fileType, s.file_size AS fileSize,
           s.tags, s.created_at AS createdAt, '/uploads/' || s.file_path AS url
    FROM slides s
    JOIN categories c ON c.id = s.category_id
    JOIN users u ON u.id = s.owner_user_id
    WHERE s.deleted_at IS NULL
    ${categoryId ? "AND s.category_id = $categoryId" : ""}
    ORDER BY s.created_at DESC
  `;
  const rows = categoryId ? db.query(sql).all({ $categoryId: categoryId }) : db.query(sql).all();
  return rows.map((row) => ({ ...row, tags: JSON.parse(row.tags || "[]") }));
}

function getSlide(id) {
  const row = db.query(`
    SELECT s.id, s.title, s.category_id AS categoryId, c.name AS categoryName, u.name AS ownerName,
           s.original_name AS originalName, s.file_type AS fileType, s.file_size AS fileSize,
           s.tags, s.created_at AS createdAt, '/uploads/' || s.file_path AS url
    FROM slides s
    JOIN categories c ON c.id = s.category_id
    JOIN users u ON u.id = s.owner_user_id
    WHERE s.id = $id
  `).get({ $id: id });
  return row ? { ...row, tags: JSON.parse(row.tags || "[]") } : null;
}

async function handleSlideDelete(request, slideId) {
  const body = await request.json().catch(() => ({}));
  const userId = Number(body?.userId);

  if (!slideId) return json({ error: "Slide id is required" }, 400);
  if (!Number.isInteger(userId) || userId <= 0 || !getUser(userId)) return json({ error: "Valid user is required" }, 400);

  const result = softDeleteSlide(slideId, userId);
  if (!result) return json({ error: "Slide not found" }, 404);
  return json({ slide: result });
}

function softDeleteSlide(slideId, userId) {
  const existing = db.query("SELECT id, deleted_at AS deletedAt FROM slides WHERE id = $id").get({ $id: slideId });
  if (!existing) return null;

  if (!existing.deletedAt) {
    db.query(`
      UPDATE slides
      SET deleted_at = CURRENT_TIMESTAMP,
          deleted_by_user_id = $userId
      WHERE id = $id
    `).run({ $id: slideId, $userId: userId });

    db.query("INSERT INTO upload_events (slide_id, user_id, event_type) VALUES ($slideId, $userId, 'deleted')")
      .run({ $slideId: slideId, $userId: userId });
  }

  return db.query("SELECT id, title, deleted_at AS deletedAt, deleted_by_user_id AS deletedByUserId FROM slides WHERE id = $id").get({ $id: slideId });
}

function upsertUser(name) {
  db.query(`
    INSERT INTO users (name) VALUES ($name)
    ON CONFLICT(name) DO UPDATE SET last_seen_at = CURRENT_TIMESTAMP
  `).run({ $name: name });
  return db.query("SELECT id, name, created_at AS createdAt, last_seen_at AS lastSeenAt FROM users WHERE name = $name COLLATE NOCASE").get({ $name: name });
}

function listUsers() {
  return db.query(`
    SELECT id, name
    FROM users
    ORDER BY last_seen_at DESC, name COLLATE NOCASE ASC
    LIMIT 100
  `).all();
}

function getUser(id) {
  return db.query("SELECT id, name FROM users WHERE id = $id").get({ $id: id });
}

async function serveStatic(urlPath) {
  const normalized = urlPath === "/" ? "/index.html" : urlPath;
  const absolutePath = safeJoin(PUBLIC_DIR, normalized);
  if (!absolutePath) return new Response("Not found", { status: 404 });
  return await serveFile(absolutePath, urlPath === "/" ? "text/html; charset=utf-8" : undefined, true);
}

async function serveUpload(urlPath) {
  const relative = urlPath.replace(/^\/uploads\//, "");
  const absolutePath = safeJoin(UPLOAD_DIR, relative);
  if (!absolutePath) return new Response("Not found", { status: 404 });
  return await serveFile(absolutePath, undefined, false);
}

async function serveFile(absolutePath, contentType, fallbackToIndex) {
  try {
    const info = await stat(absolutePath);
    if (!info.isFile()) throw new Error("not file");
    return new Response(Bun.file(absolutePath), { headers: contentType ? { "content-type": contentType } : {} });
  } catch {
    if (fallbackToIndex) {
      const indexPath = path.join(PUBLIC_DIR, "index.html");
      if (existsSync(indexPath)) return new Response(Bun.file(indexPath), { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    return new Response("Not found", { status: 404 });
  }
}

function migrateDatabase() {
  const columns = new Set(db.query("PRAGMA table_info(slides)").all().map((column) => column.name));
  if (!columns.has("deleted_at")) db.exec("ALTER TABLE slides ADD COLUMN deleted_at TEXT");
  if (!columns.has("deleted_by_user_id")) db.exec("ALTER TABLE slides ADD COLUMN deleted_by_user_id INTEGER REFERENCES users(id)");
}

function safeJoin(root, target) {
  const decoded = decodeURIComponent(target).replace(/^\/+/, "");
  const absolutePath = path.resolve(root, decoded);
  const resolvedRoot = path.resolve(root);
  return absolutePath.startsWith(resolvedRoot + path.sep) || absolutePath === resolvedRoot ? absolutePath : null;
}

function seedCategories(config) {
  const seen = new Set();
  const insert = db.query(`
    INSERT INTO categories (id, name, description, sort_order, active, updated_at)
    VALUES ($id, $name, $description, $sortOrder, 1, CURRENT_TIMESTAMP)
    ON CONFLICT(id) DO UPDATE SET
      name = excluded.name,
      description = excluded.description,
      sort_order = excluded.sort_order,
      active = 1,
      updated_at = CURRENT_TIMESTAMP
  `);

  config.forEach((category, index) => {
    seen.add(category.id);
    insert.run({
      $id: category.id,
      $name: category.name,
      $description: category.description || "",
      $sortOrder: index,
    });
  });

  const ids = [...seen];
  if (ids.length > 0) {
    const placeholders = ids.map(() => "?").join(",");
    db.query(`UPDATE categories SET active = 0 WHERE id NOT IN (${placeholders})`).run(...ids);
  }
}

async function loadCategories() {
  const raw = await readFile(path.join(ROOT, "categories.json"), "utf8");
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) throw new Error("categories.json must contain categories");
  return parsed.map((category) => ({
    id: slugify(String(category.id || category.name || "")),
    name: String(category.name || "").trim(),
    description: String(category.description || "").trim(),
  })).filter((category) => category.id && category.name);
}

function normalizeName(value) {
  const name = String(value || "").trim().replace(/\s+/g, " ");
  if (name.length < 1 || name.length > 80) return "";
  return name;
}

function parseTags(value) {
  return value.split(",").map((tag) => tag.trim()).filter(Boolean).slice(0, 12);
}

function slugify(value) {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "item";
}

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}
